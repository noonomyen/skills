import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createMonolithApp } from '../src/apps/monolith'
import { env } from '../src/env'
import { getCacheStore, invalidateCache } from '../src/infra/cache'
import { ensureDatabaseConnected, getPrisma } from '../src/infra/db'
import { eventBus } from '../src/infra/event-bus'
import { sanitizeUploadFilename } from '../src/modules/artifacts/service'
import { acceptsGzipEncoding } from '../src/modules/webhooks'
import { registerAndCreateWorkspace, signWebhook } from './fixtures'

const app = createMonolithApp({ enableAudit: false })

describe('03: Tenant Authz, Artifacts (RFC 9110/6266), Gzip Q-Values, SSE Backpressure & WS Validation', () => {
	let owner!: Awaited<ReturnType<typeof registerAndCreateWorkspace>>
	let outsider!: Awaited<ReturnType<typeof registerAndCreateWorkspace>>

	beforeAll(async () => {
		await ensureDatabaseConnected()
		await getCacheStore().ping()
		owner = await registerAndCreateWorkspace(app, 'art-owner')
		outsider = await registerAndCreateWorkspace(app, 'art-outsider')
	})

	afterAll(async () => {
		const ids = [owner?.userId, outsider?.userId].filter((id): id is string => Boolean(id))
		if (ids.length > 0) {
			await getPrisma().user.deleteMany({ where: { id: { in: ids } } })
		}
		if (owner?.workspaceId) {
			await rm(join(env.ARTIFACT_DIR, owner.workspaceId), { recursive: true, force: true })
		}
	})

	it('enforces tenant membership checks, blocks traversal, checks missing disk file (404), and returns null-body 304', async () => {
		expect(sanitizeUploadFilename('a\nb/c')).toBe('c')
		const prisma = getPrisma()
		const badForm = new FormData()
		badForm.append('workspaceId', '../../etc')
		badForm.append('file', new File(['x'], 'bad.txt', { type: 'text/plain' }))
		expect(
			(
				await app.handle(
					new Request('http://localhost/api/artifacts/upload', {
						method: 'POST',
						headers: { authorization: `Bearer ${owner.accessToken}` },
						body: badForm
					})
				)
			).status
		).toBe(422)

		// Outsider cannot upload to owner's workspace (403).
		const crossUploadForm = new FormData()
		crossUploadForm.append('workspaceId', owner.workspaceId)
		crossUploadForm.append('file', new File(['nope'], 'x.txt', { type: 'text/plain' }))
		expect(
			(
				await app.handle(
					new Request('http://localhost/api/artifacts/upload', {
						method: 'POST',
						headers: { authorization: `Bearer ${outsider.accessToken}` },
						body: crossUploadForm
					})
				)
			).status
		).toBe(403)

		const form = new FormData()
		form.append('workspaceId', owner.workspaceId)
		form.append(
			'file',
			new File(['<script>alert(1)</script>'], 'รายงาน.html', { type: 'text/html' })
		)

		const uploadRes = await app.handle(
			new Request('http://localhost/api/artifacts/upload', {
				method: 'POST',
				headers: { authorization: `Bearer ${owner.accessToken}` },
				body: form
			})
		)
		expect(uploadRes.status).toBe(201)
		const meta = (await uploadRes.json()) as { id: string; etag: string }

		try {
			// Outsider cannot download owner's artifact (403).
			expect(
				(
					await app.handle(
						new Request(`http://localhost/api/artifacts/${meta.id}/download`, {
							headers: { authorization: `Bearer ${outsider.accessToken}` }
						})
					)
				).status
			).toBe(403)

			const dlRes = await app.handle(
				new Request(`http://localhost/api/artifacts/${meta.id}/download`, {
					headers: { authorization: `Bearer ${owner.accessToken}` }
				})
			)
			expect(dlRes.status).toBe(200)
			expect(dlRes.headers.get('content-type')).toBe('application/octet-stream')
			expect(dlRes.headers.get('content-disposition')).toContain("filename*=UTF-8''")
			expect(dlRes.headers.get('x-content-type-options')).toBe('nosniff')

			const notModified = await app.handle(
				new Request(`http://localhost/api/artifacts/${meta.id}/download`, {
					headers: {
						authorization: `Bearer ${owner.accessToken}`,
						'if-none-match': `"other", W/${meta.etag}`
					}
				})
			)
			expect(notModified.status).toBe(304)
			expect(await notModified.text()).toBe('')
			expect(notModified.headers.get('cache-control')).toBe('private, max-age=3600')

			// Missing file on disk must return 404 (never 200 leaking ENOENT path).
			await rm(join(env.ARTIFACT_DIR, owner.workspaceId), { recursive: true, force: true })
			const missingRes = await app.handle(
				new Request(`http://localhost/api/artifacts/${meta.id}/download`, {
					headers: { authorization: `Bearer ${owner.accessToken}` }
				})
			)
			expect(missingRes.status).toBe(404)
		} finally {
			await invalidateCache(`art:meta:${meta.id}`)
			await prisma.artifact.deleteMany({ where: { id: meta.id } })
		}
	})

	it('respects Accept-Encoding q-values + Vary, sets private no-store, and blocks outsider webhook reads', async () => {
		expect(acceptsGzipEncoding('gzip;q=0, br;q=1')).toBe(false)
		expect(acceptsGzipEncoding('br;q=1.0, x-gzip;q=0.5')).toBe(true)

		const prisma = getPrisma()
		const store = getCacheStore()
		const payload = JSON.stringify({ event: 'big.payload', data: { blob: 'x'.repeat(2048) } })
		const signed = signWebhook({
			workspaceId: owner.workspaceId,
			bodyText: payload,
			secret: owner.webhookSecret
		})
		let id = ''

		try {
			const ingestRes = await app.handle(
				new Request(`http://localhost/api/webhooks/ingest/${owner.workspaceId}`, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'x-webhook-timestamp': signed.ts,
						'x-webhook-signature': signed.sig
					},
					body: payload
				})
			)
			id = ((await ingestRes.json()) as { id: string }).id

			// Outsider cannot read by ID or list owner's workspace (403).
			expect(
				(
					await app.handle(
						new Request(`http://localhost/api/webhooks/${id}`, {
							headers: { authorization: `Bearer ${outsider.accessToken}` }
						})
					)
				).status
			).toBe(403)
			expect(
				(
					await app.handle(
						new Request(`http://localhost/api/webhooks/workspace/${owner.workspaceId}`, {
							headers: { authorization: `Bearer ${outsider.accessToken}` }
						})
					)
				).status
			).toBe(403)

			// q=0 must NOT compress, and MUST emit Vary: Accept-Encoding + private no-store.
			const noGz = await app.handle(
				new Request(`http://localhost/api/webhooks/${id}`, {
					headers: { authorization: `Bearer ${owner.accessToken}`, 'accept-encoding': 'gzip;q=0' }
				})
			)
			expect(noGz.headers.get('content-encoding')).toBeNull()
			expect(noGz.headers.get('vary')).toContain('Accept-Encoding')
			expect(noGz.headers.get('cache-control')).toBe('private, no-store')

			const gzRes = await app.handle(
				new Request(`http://localhost/api/webhooks/${id}`, {
					headers: {
						authorization: `Bearer ${owner.accessToken}`,
						'accept-encoding': 'gzip',
						'x-request-id': 'gz-req-1'
					}
				})
			)
			expect(gzRes.status).toBe(200)
			expect(gzRes.headers.get('content-encoding')).toBe('gzip')
			expect(gzRes.headers.get('vary')).toContain('Accept-Encoding')
			expect(gzRes.headers.get('x-request-id')).toBe('gz-req-1')

			const rawBytes = new Uint8Array(await gzRes.arrayBuffer())
			const decompressed = new TextDecoder().decode(Bun.gunzipSync(rawBytes))
			expect(JSON.parse(decompressed)).toMatchObject({ id, eventType: 'big.payload' })
		} finally {
			if (id) await invalidateCache(`wh:item:${id}`)
			await store.del(`wh:sig:${owner.workspaceId}:${signed.ts}:${signed.sig.slice(7)}`)
			await prisma.webhook.deleteMany({ where: { workspaceId: owner.workspaceId } })
		}
	})

	it('streams SSE with Last-Event-ID replay, real backpressure cap, and tenant membership enforcement', async () => {
		const prisma = getPrisma()
		const store = getCacheStore()
		const ac = new AbortController()

		// Outsider SSE connect must be rejected 403.
		expect(
			(
				await app.handle(
					new Request(`http://localhost/api/webhooks/stream/${owner.workspaceId}`, {
						headers: { authorization: `Bearer ${outsider.accessToken}` }
					})
				)
			).status
		).toBe(403)

		const p1 = JSON.stringify({ event: 'job.queued', data: { step: 1 } })
		const s1 = signWebhook({
			workspaceId: owner.workspaceId,
			bodyText: p1,
			secret: owner.webhookSecret
		})
		const p2 = JSON.stringify({ event: 'job.completed', data: { step: 2 } })
		const s2 = signWebhook({
			workspaceId: owner.workspaceId,
			bodyText: p2,
			secret: owner.webhookSecret,
			ts: Number(s1.ts) + 1
		})

		try {
			const r1 = await app.handle(
				new Request(`http://localhost/api/webhooks/ingest/${owner.workspaceId}`, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'x-webhook-timestamp': s1.ts,
						'x-webhook-signature': s1.sig
					},
					body: p1
				})
			)
			const firstId = ((await r1.json()) as { id: string }).id

			await app.handle(
				new Request(`http://localhost/api/webhooks/ingest/${owner.workspaceId}`, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'x-webhook-timestamp': s2.ts,
						'x-webhook-signature': s2.sig
					},
					body: p2
				})
			)

			const streamRes = await app.handle(
				new Request(`http://localhost/api/webhooks/stream/${owner.workspaceId}`, {
					headers: { authorization: `Bearer ${owner.accessToken}`, 'last-event-id': firstId },
					signal: ac.signal
				})
			)
			expect(streamRes.status).toBe(200)
			const reader = streamRes.body!.getReader()
			const decoder = new TextDecoder()

			const chunk1 = decoder.decode((await reader.read()).value)
			expect(chunk1).toContain('event: connected')
			const chunk2 = decoder.decode((await reader.read()).value)
			expect(chunk2).toContain('job.completed')

			// Verify CountQueuingStrategy caps unread overflow without queuing unbounded events.
			for (let i = 0; i < 400; i++) {
				eventBus.publish({
					id: `flood-${i}`,
					workspaceId: owner.workspaceId,
					source: 'flood',
					eventType: 'flood.ping',
					payload: { i },
					deliveryStatus: 'queued',
					createdAt: Date.now()
				})
			}
			// Drain bounded chunks and observe warning frame.
			let sawWarning = false
			for (let i = 0; i < 265; i++) {
				const next = await reader.read()
				if (next.done) break
				if (decoder.decode(next.value).includes('SLOW_CONSUMER_DROPPED')) {
					sawWarning = true
					break
				}
			}
			expect(sawWarning).toBe(true)

			ac.abort()
			await reader.cancel()
		} finally {
			await store.del(
				`wh:sig:${owner.workspaceId}:${s1.ts}:${s1.sig.slice(7)}`,
				`wh:sig:${owner.workspaceId}:${s2.ts}:${s2.sig.slice(7)}`
			)
			await prisma.webhook.deleteMany({ where: { workspaceId: owner.workspaceId } })
		}
	})

	it('enforces WS tenant membership + returns clean JSON ValidationError without tearing down shared pool', async () => {
		const wsApp = createMonolithApp({ enableAudit: false })
		const server = wsApp.listen({ port: 0, hostname: '127.0.0.1' })
		try {
			const port = server.server!.port

			// Cookie-authenticated WS upgrade missing Origin header must be rejected (403 FORBIDDEN_ORIGIN).
			const noOriginCookieWs = await fetch(
				`http://127.0.0.1:${port}/api/webhooks/ws/${owner.workspaceId}`,
				{
					headers: {
						cookie: `access_token=${owner.accessToken}`,
						connection: 'Upgrade',
						upgrade: 'websocket',
						'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
						'sec-websocket-version': '13'
					}
				}
			)
			expect(noOriginCookieWs.status).toBe(403)

			// Outsider HTTP upgrade must be rejected (403).
			const denied = await fetch(`http://127.0.0.1:${port}/api/webhooks/ws/${owner.workspaceId}`, {
				headers: {
					authorization: `Bearer ${outsider.accessToken}`,
					connection: 'Upgrade',
					upgrade: 'websocket',
					'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
					'sec-websocket-version': '13'
				}
			})
			expect(denied.status).toBe(403)

			const ws = new WebSocket(`ws://127.0.0.1:${port}/api/webhooks/ws/${owner.workspaceId}`, {
				headers: { authorization: `Bearer ${owner.accessToken}` }
			})
			const received: string[] = []

			await Promise.race([
				new Promise<void>((resolve, reject) => {
					ws.onopen = () => {
						ws.send(JSON.stringify({ action: 'ping' }))
						ws.send(JSON.stringify({ action: 'invalid_action' }))
						ws.send(JSON.stringify({ action: 'broadcast', message: 'hello-ws' }))
					}
					ws.onmessage = (ev) => {
						received.push(String(ev.data))
						if (received.length >= 4) resolve()
					}
					ws.onerror = (err) => reject(err)
				}),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error('WebSocket test timed out')), 3000)
				)
			])

			ws.close()
			const joined = received.join('\n')
			expect(joined).toContain('subscribed')
			expect(joined).toContain('pong')
			expect(joined).toContain('hello-ws')
			const errMsg = received.map((r) => JSON.parse(r)).find((m) => m.code === 'VALIDATION_ERROR')
			expect(errMsg).toMatchObject({ code: 'VALIDATION_ERROR' })
			expect(errMsg.response).toBeUndefined()
		} finally {
			// Stop only the ephemeral HTTP listener so shared Postgres/Redis pools stay open.
			await server.server?.stop(true)
		}
	})
})
