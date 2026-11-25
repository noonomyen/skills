import { beforeAll, describe, expect, it } from 'bun:test'
import { Elysia, status } from 'elysia'
import { createMonolithApp } from '../src/apps/monolith'
import { loadEnv } from '../src/env'
import { auditBuffer } from '../src/infra/audit-buffer'
import { getCacheStore, invalidateCache } from '../src/infra/cache'
import { ensureDatabaseConnected, getPrisma } from '../src/infra/db'
import { createAuditPlugin } from '../src/plugins/audit'
import { errorPlugin } from '../src/plugins/errors'
import {
	buildTrustedProxyBlockList,
	isTrustedOrigin,
	normalizeIp,
	resolveClientIp
} from '../src/plugins/security'
import { registerAndCreateWorkspace, signWebhook } from './fixtures'

const app = createMonolithApp({ precompile: true, enableAudit: true })

describe('01: Precompile Lifecycle, Pre-Parse HMAC, Stream Cap, Throw Status & Security Headers', () => {
	beforeAll(async () => {
		await ensureDatabaseConnected()
		await getCacheStore().ping()
	})

	it('serves /healthz with security headers even when precompile: true, plus /readyz', async () => {
		const res = await app.handle(new Request('http://localhost/healthz'))
		expect(res.status).toBe(200)
		expect(await res.text()).toBe('ok')
		expect(res.headers.get('x-content-type-options')).toBe('nosniff')
		expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
		expect(res.headers.get('x-request-id')).toBeTruthy()

		const ready = await app.handle(new Request('http://localhost/readyz'))
		expect(ready.status).toBe(200)

		const traced = await app.handle(
			new Request('http://localhost/healthz', {
				headers: { 'x-request-id': 'req-trace-123' }
			})
		)
		expect(traced.headers.get('x-request-id')).toBe('req-trace-123')
	})

	it('handles thrown status(...) via errorPlugin without flattening to 500', async () => {
		const probe = new Elysia()
			.use(errorPlugin)
			.get('/throw-409', () => {
				throw status(409, { error: 'Already exists', code: 'MY_CONFLICT' })
			})

		const res = await probe.handle(new Request('http://localhost/throw-409'))
		expect(res.status).toBe(409)
		expect(await res.json()).toEqual({ error: 'Already exists', code: 'MY_CONFLICT' })
	})

	it('resolves CIDR proxies, normalized IPv6-mapped IPv4, and avoids X-Real-IP fallback when XFF exists', () => {
		const req = new Request('http://localhost/healthz', {
			headers: {
				'x-forwarded-for': '9.9.9.9, [::FFFF:198.51.100.42]:5432, 10.0.0.2',
				'x-real-ip': '203.0.113.99'
			}
		})
		expect(resolveClientIp(req, '[::FFFF:10.0.0.1]:443', ['10.0.0.0/8'])).toBe('198.51.100.42')

		const allTrusted = new Request('http://localhost/healthz', {
			headers: {
				'x-forwarded-for': '10.0.0.5',
				'x-real-ip': '203.0.113.99'
			}
		})
		expect(resolveClientIp(allTrusted, '10.0.0.1', ['10.0.0.0/8'])).toBe('10.0.0.1')
		expect(resolveClientIp(req, undefined, ['127.0.0.1'])).toBe('unknown')

		expect(normalizeIp('::ffff:0a00:0001')).toBe('10.0.0.1')
		expect(normalizeIp('[::1]garbage')).toBe('unknown')
		expect(resolveClientIp(req, '10.0.0.1', ['::ffff:10.0.0.0/104'])).toBe('198.51.100.42')
		expect(() => buildTrustedProxyBlockList(['10.0.0.0/33'])).toThrow(RangeError)
		expect(() => loadEnv({ NODE_ENV: 'test', PORT: '3000.5' })).toThrow()

		expect(
			isTrustedOrigin(
				new Request('http://localhost/api/workspaces', {
					headers: { host: 'localhost', origin: 'https://localhost' }
				})
			)
		).toBe(false)
		expect(
			isTrustedOrigin(
				new Request('http://localhost/api/webhooks/ws/w1', {
					headers: { host: 'localhost' }
				}),
				true
			)
		).toBe(false)
	})

	it('rejects unsigned invalid JSON with 401 (not 422 oracle), blocks cross-workspace & signature replay, and caps chunked 413', async () => {
		const prisma = getPrisma()
		const store = getCacheStore()
		const t1 = await registerAndCreateWorkspace(app, 'hmac1')
		const t2 = await registerAndCreateWorkspace(app, 'hmac2')

		try {
			// Unsigned invalid body must fail with 401 BEFORE JSON.parse or TypeBox 422.
			const oracleAttempt = await app.handle(
				new Request(`http://localhost/api/webhooks/ingest/${t1.workspaceId}`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: '{"bad":true}'
				})
			)
			expect(oracleAttempt.status).toBe(401)
			expect(oracleAttempt.headers.get('www-authenticate')).toContain('HMAC-SHA256')

			const payload = JSON.stringify({ event: 'order.created', data: { amount: 100 } })
			const signedFor1 = signWebhook({
				workspaceId: t1.workspaceId,
				bodyText: payload,
				secret: t1.webhookSecret
			})

			// Cross-workspace replay must fail 401.
			const crossWs = await app.handle(
				new Request(`http://localhost/api/webhooks/ingest/${t2.workspaceId}`, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'x-webhook-timestamp': signedFor1.ts,
						'x-webhook-signature': signedFor1.sig
					},
					body: payload
				})
			)
			expect(crossWs.status).toBe(401)

			// First ingest succeeds, immediate duplicate signature without Idempotency-Key fails 401.
			const first = await app.handle(
				new Request(`http://localhost/api/webhooks/ingest/${t1.workspaceId}`, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'x-webhook-timestamp': signedFor1.ts,
						'x-webhook-signature': signedFor1.sig
					},
					body: payload
				})
			)
			expect(first.status).toBe(202)
			const createdId = ((await first.json()) as { id: string }).id

			const replayNoIdem = await app.handle(
				new Request(`http://localhost/api/webhooks/ingest/${t1.workspaceId}`, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'x-webhook-timestamp': signedFor1.ts,
						'x-webhook-signature': signedFor1.sig
					},
					body: payload
				})
			)
			expect(replayNoIdem.status).toBe(401)

			// Chunked body without Content-Length exceeding 256KB must stream-reject with 413.
			const chunked = new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(new Uint8Array(150 * 1024).fill(97))
					c.enqueue(new Uint8Array(150 * 1024).fill(97))
					c.close()
				}
			})
			const tooBig = await app.handle(
				new Request(`http://localhost/api/webhooks/ingest/${t1.workspaceId}`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: chunked
				})
			)
			expect(tooBig.status).toBe(413)

			await invalidateCache(`wh:item:${createdId}`)
			await store.del(`wh:sig:${t1.workspaceId}:${signedFor1.ts}:${signedFor1.sig.slice(7)}`)
		} finally {
			await prisma.webhook.deleteMany({
				where: { workspaceId: { in: [t1.workspaceId, t2.workspaceId] } }
			})
			await prisma.user.deleteMany({ where: { id: { in: [t1.userId, t2.userId] } } })
			await prisma.auditLog.deleteMany({
				where: {
					path: {
						in: [
							'/api/auth/register',
							'/api/workspaces',
							`/api/webhooks/ingest/${t1.workspaceId}`,
							`/api/webhooks/ingest/${t2.workspaceId}`
						]
					}
				}
			})
		}
	})

	it('records real actorId in audit logs and leaves zero hooks when enableAudit=false', async () => {
		const disabledAudit = createAuditPlugin(false)
		expect(disabledAudit.event.request?.length ?? 0).toBe(0)
		expect(disabledAudit.event.afterResponse?.length ?? 0).toBe(0)

		const prisma = getPrisma()
		const tenant = await registerAndCreateWorkspace(app, 'audit')
		try {
			await auditBuffer.flush()
			const logs = await prisma.auditLog.findMany({
				where: { path: '/api/workspaces', actorId: tenant.userId }
			})
			expect(logs.length).toBeGreaterThanOrEqual(1)
		} finally {
			await prisma.auditLog.deleteMany({ where: { actorId: tenant.userId } })
			await prisma.user.deleteMany({ where: { id: tenant.userId } })
		}
	})
})
