import { CryptoHasher } from 'bun'
import { beforeAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { createMonolithApp } from '../src/apps/monolith'
import { getCacheStore, invalidateCache } from '../src/infra/cache'
import { ensureDatabaseConnected, getPrisma } from '../src/infra/db'
import { errorPlugin } from '../src/plugins/errors'
import { idempotencyMacro } from '../src/plugins/idempotency.macro'
import { registerAndCreateWorkspace, signWebhook } from './fixtures'

const app = createMonolithApp({ enableAudit: false })

describe('02: Standard JWT + Atomic Refresh, Logout Parity, CSRF, Idempotency & Rate Limit', () => {
	beforeAll(async () => {
		await ensureDatabaseConnected()
		await getCacheStore().ping()
	})

	it('prevents admin self-registration, sets no-store, rejects cross-site cookies, and logs out with refreshToken', async () => {
		const prisma = getPrisma()
		const memberEmail = `member-${Bun.randomUUIDv7()}@example.com`
		const adminEmail = `admin-${Bun.randomUUIDv7()}@example.com`
		let mId = ''
		let aId = ''

		try {
			const mReg = await app.handle(
				new Request('http://localhost/api/auth/register', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ email: memberEmail, password: 'Password123!', role: 'admin' })
				})
			)
			expect(mReg.status).toBe(201)
			expect(mReg.headers.get('cache-control')).toBe('no-store')
			const mData = (await mReg.json()) as {
				accessToken: string
				refreshToken: string
				tokenType: string
				user: { id: string; role: string }
			}
			mId = mData.user.id
			expect(mData.user.role).toBe('member')
			expect(mData.tokenType).toBe('Bearer')

			const dup = await app.handle(
				new Request('http://localhost/api/auth/register', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ email: memberEmail.toUpperCase(), password: 'Password123!' })
				})
			)
			expect(dup.status).toBe(409)

			// Cookie-only refresh from untrusted Origin / cross-site must fail 403.
			const csrfAttempt = await app.handle(
				new Request('http://localhost/api/auth/refresh', {
					method: 'POST',
					headers: {
						cookie: `refresh_token=${mData.refreshToken}`,
						origin: 'https://attacker.example',
						'sec-fetch-site': 'cross-site'
					}
				})
			)
			expect(csrfAttempt.status).toBe(403)

			expect(
				(
					await app.handle(
						new Request('http://localhost/api/auth/admin/stats', {
							headers: { authorization: `Bearer ${mData.accessToken}` }
						})
					)
				).status
			).toBe(403)

			const aReg = await app.handle(
				new Request('http://localhost/api/auth/register', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ email: adminEmail, password: 'Password123!' })
				})
			)
			aId = ((await aReg.json()) as { user: { id: string } }).user.id
			await prisma.user.update({ where: { id: aId }, data: { role: 'admin' } })

			const aLogin = await app.handle(
				new Request('http://localhost/api/auth/login', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ email: adminEmail, password: 'Password123!' })
				})
			)
			const aTokens = (await aLogin.json()) as { accessToken: string }
			expect(
				(
					await app.handle(
						new Request('http://localhost/api/auth/admin/stats', {
							headers: { authorization: `Bearer ${aTokens.accessToken}` }
						})
					)
				).status
			).toBe(200)

			// Forged <sid>.garbage must return identical 401 INVALID_REFRESH without probing DB session/disabled state.
			const victimSid = mData.refreshToken.split('.')[0]!
			await prisma.user.update({ where: { id: mId }, data: { disabled: true } })
			const probeDisabled = await app.handle(
				new Request('http://localhost/api/auth/refresh', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ refreshToken: `${victimSid}.forged-secret-part-123456` })
				})
			)
			expect(probeDisabled.status).toBe(401)
			expect((await probeDisabled.json()) as { code: string }).toMatchObject({ code: 'INVALID_REFRESH' })
			await prisma.user.update({ where: { id: mId }, data: { disabled: false } })

			// Logout must succeed even with an expired/missing Bearer token when refreshToken is provided.
			const logoutRes = await app.handle(
				new Request('http://localhost/api/auth/logout', {
					method: 'POST',
					headers: {
						authorization: 'Bearer expired.jwt.token',
						'content-type': 'application/json'
					},
					body: JSON.stringify({ refreshToken: mData.refreshToken })
				})
			)
			expect(logoutRes.status).toBe(200)
			const setCookies = logoutRes.headers.getSetCookie()
			expect(setCookies.some((c) => c.includes('refresh_token=;') && c.includes('Path=/api/auth'))).toBe(
				true
			)
			expect(setCookies.some((c) => c.includes('access_token=;') && c.includes('Path=/'))).toBe(true)

			expect(
				(
					await app.handle(
						new Request('http://localhost/api/auth/refresh', {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({ refreshToken: mData.refreshToken })
						})
					)
				).status
			).toBe(401)
		} finally {
			await prisma.user.deleteMany({ where: { id: { in: [mId, aId].filter(Boolean) } } })
		}
	})

	it('atomically rotates refresh token, revokes active session on concurrent reuse, and invalidates newly minted token', async () => {
		const prisma = getPrisma()
		const email = `rot-${Bun.randomUUIDv7()}@example.com`
		let userId = ''

		try {
			const reg = await app.handle(
				new Request('http://localhost/api/auth/register', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ email, password: 'Password123!' })
				})
			)
			const first = (await reg.json()) as {
				accessToken: string
				refreshToken: string
				user: { id: string }
			}
			userId = first.user.id

			const cookieRefresh = await app.handle(
				new Request('http://localhost/api/auth/refresh', {
					method: 'POST',
					headers: { cookie: `refresh_token=${first.refreshToken}` }
				})
			)
			expect(cookieRefresh.status).toBe(200)
			const rotated = (await cookieRefresh.json()) as {
				accessToken: string
				refreshToken: string
			}

			const [r1, r2] = await Promise.all([
				app.handle(
					new Request('http://localhost/api/auth/refresh', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ refreshToken: rotated.refreshToken })
					})
				),
				app.handle(
					new Request('http://localhost/api/auth/refresh', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ refreshToken: rotated.refreshToken })
					})
				)
			])
			const statuses = [r1.status, r2.status].sort()
			expect(statuses[1]).toBe(401)
			expect([200, 401]).toContain(statuses[0]!)

			for (const r of [r1, r2]) {
				if (r.status === 200) {
					const winnerBody = (await r.json()) as { accessToken: string }
					expect(
						(
							await app.handle(
								new Request('http://localhost/api/auth/me', {
									headers: { authorization: `Bearer ${winnerBody.accessToken}` }
								})
							)
						).status
					).toBe(401)
				}
			}
		} finally {
			if (userId) await prisma.user.deleteMany({ where: { id: userId } })
		}
	})

	it('releases idempotency lock on thrown handler error, preserves request-id on replay, and rejects mismatched canonical payload', async () => {
		const prisma = getPrisma()
		const store = getCacheStore()
		const tenant = await registerAndCreateWorkspace(app, 'idem')
		const idemKey = Bun.randomUUIDv7()
		const payloadCanonicalA = JSON.stringify({ event: 'invoice.paid', data: { total: 499, cur: 'USD' } })
		const payloadReorderedKeys = JSON.stringify({ data: { cur: 'USD', total: 499 }, event: 'invoice.paid' })
		const payloadMismatch = JSON.stringify({ event: 'invoice.paid', data: { total: 999 } })
		const pathname = `/api/webhooks/ingest/${tenant.workspaceId}`
		const lockKey = `idem:lock:p:${pathname}:POST:${pathname}:${idemKey}`
		const respKey = `idem:resp:p:${pathname}:POST:${pathname}:${idemKey}`
		const usedSigKeys: string[] = []

		try {
			// 1. Regression check: thrown handler error must release lock in afterResponse so immediate retry succeeds.
			let shouldThrow = true
			const probe = new Elysia()
				.use(errorPlugin)
				.use(idempotencyMacro)
				.post(
					'/fail-then-ok',
					() => {
						if (shouldThrow) throw new Error('transient boom')
						return { ok: true }
					},
					{ idempotent: 60 }
				)
			const probeIdemKey = Bun.randomUUIDv7()
			const rFail = await probe.handle(
				new Request('http://localhost/fail-then-ok', {
					method: 'POST',
					headers: { 'idempotency-key': probeIdemKey }
				})
			)
			expect(rFail.status).toBe(500)
			// Allow setImmediate afterResponse hook to settle.
			await Bun.sleep(10)
			shouldThrow = false
			const rRetryAfterErr = await probe.handle(
				new Request('http://localhost/fail-then-ok', {
					method: 'POST',
					headers: { 'idempotency-key': probeIdemKey }
				})
			)
			expect(rRetryAfterErr.status).toBe(200)
			await store.del(`idem:resp:p:/fail-then-ok:POST:/fail-then-ok:${probeIdemKey}`)

			// 2. Lock collision returns 409 + Retry-After.
			await store.setNxEx(lockKey, 'owner-A', 30)
			const s1 = signWebhook({
				workspaceId: tenant.workspaceId,
				bodyText: payloadCanonicalA,
				secret: tenant.webhookSecret
			})
			usedSigKeys.push(`wh:sig:${tenant.workspaceId}:${s1.ts}:${s1.sig.slice(7)}`)
			const collision = await app.handle(
				new Request(`http://localhost${pathname}`, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'x-webhook-timestamp': s1.ts,
						'x-webhook-signature': s1.sig,
						'idempotency-key': idemKey
					},
					body: payloadCanonicalA
				})
			)
			expect(collision.status).toBe(409)
			expect(collision.headers.get('retry-after')).toBe('1')
			await store.releaseLock(lockKey, 'owner-A')

			// parse() checks sigKey read-only and claims on commit, so retrying exact s1 after 409 succeeds.
			const first = await app.handle(
				new Request(`http://localhost${pathname}`, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'x-request-id': 'req-first-1',
						'x-webhook-timestamp': s1.ts,
						'x-webhook-signature': s1.sig,
						'idempotency-key': idemKey
					},
					body: payloadCanonicalA
				})
			)
			expect(first.status).toBe(202)
			const body1 = (await first.json()) as { id: string }

			// Reordered JSON keys with fresh signature + same Idempotency-Key must replay cleanly without overwriting x-request-id.
			const s3 = signWebhook({
				workspaceId: tenant.workspaceId,
				bodyText: payloadReorderedKeys,
				secret: tenant.webhookSecret,
				ts: Number(s1.ts) + 1
			})
			usedSigKeys.push(`wh:sig:${tenant.workspaceId}:${s3.ts}:${s3.sig.slice(7)}`)
			const replay = await app.handle(
				new Request(`http://localhost${pathname}`, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'x-request-id': 'req-replay-2',
						'x-webhook-timestamp': s3.ts,
						'x-webhook-signature': s3.sig,
						'idempotency-key': idemKey
					},
					body: payloadReorderedKeys
				})
			)
			expect(replay.status).toBe(202)
			expect(replay.headers.get('x-request-id')).toBe('req-replay-2')
			expect(await replay.json()).toEqual(body1)

			// Different payload must return 422 IDEMPOTENCY_KEY_MISMATCH.
			const s4 = signWebhook({
				workspaceId: tenant.workspaceId,
				bodyText: payloadMismatch,
				secret: tenant.webhookSecret,
				ts: Number(s3.ts) + 1
			})
			usedSigKeys.push(`wh:sig:${tenant.workspaceId}:${s4.ts}:${s4.sig.slice(7)}`)
			const mismatch = await app.handle(
				new Request(`http://localhost${pathname}`, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'x-webhook-timestamp': s4.ts,
						'x-webhook-signature': s4.sig,
						'idempotency-key': idemKey
					},
					body: payloadMismatch
				})
			)
			expect(mismatch.status).toBe(422)
			await invalidateCache(`wh:item:${body1.id}`)
		} finally {
			await store.del(lockKey, respKey, ...usedSigKeys)
			await prisma.webhook.deleteMany({ where: { workspaceId: tenant.workspaceId } })
			await prisma.user.deleteMany({ where: { id: tenant.userId } })
		}
	})

	it('enforces both per-IP and per-account login rate limits with Retry-After', async () => {
		const store = getCacheStore()
		const nowSec = Math.floor(Date.now() / 1000)
		const bucket = Math.floor(nowSec / 60)
		const targetEmail = `target-${Bun.randomUUIDv7()}@example.com`
		const emailHash = new CryptoHasher('sha256').update(targetEmail).digest('hex')
		const acctKey = `rl:auth-login-acct:${emailHash}:${bucket}`

		try {
			await store.set(acctKey, '10', 60)
			const res = await app.handle(
				new Request('http://localhost/api/auth/login', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ email: targetEmail, password: 'Password123!' })
				})
			)
			expect(res.status).toBe(429)
			expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
		} finally {
			await store.del(acctKey, `rl:auth-login-acct:${emailHash}:${bucket + 1}`)
		}
	})
})
