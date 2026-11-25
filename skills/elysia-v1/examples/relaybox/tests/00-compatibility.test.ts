import { beforeAll, describe, expect, it } from 'bun:test'
import { AuditBatchBuffer } from '../src/infra/audit-buffer'
import { cacheGetOrSet, getCacheStore, invalidateCache } from '../src/infra/cache'
import { ensureDatabaseConnected, getPrisma } from '../src/infra/db'

describe('00: PostgreSQL (Prisma) & Redis Compatibility', () => {
	beforeAll(async () => {
		await ensureDatabaseConnected()
		await getCacheStore().ping()
	})

	it('connects to PostgreSQL and executes raw query', async () => {
		const rows = await getPrisma().$queryRaw<{ ok: number }[]>`SELECT 1 AS ok`
		expect(rows[0]?.ok).toBe(1)
	})

	it('supports ACID transaction commit and rollback with FK cascade', async () => {
		const prisma = getPrisma()
		const userId = Bun.randomUUIDv7()
		const sessionId = Bun.randomUUIDv7()
		const email = `tx-${userId}@example.com`

		try {
			await prisma.$transaction(async (tx) => {
				await tx.user.create({
					data: {
						id: userId,
						email,
						passwordHash: 'hash',
						role: 'member',
						sessions: {
							create: {
								id: sessionId,
								userAgent: 'test',
								ip: '127.0.0.1',
								expiresAt: new Date(Date.now() + 60_000)
							}
						}
					}
				})
			})

			await expect(
				prisma.$transaction(async (tx) => {
					await tx.user.delete({ where: { id: userId } })
					throw new Error('INTENTIONAL_ROLLBACK')
				})
			).rejects.toThrow('INTENTIONAL_ROLLBACK')

			const stillThere = await prisma.user.findUnique({ where: { id: userId } })
			expect(stillThere?.id).toBe(userId)

			await prisma.user.delete({ where: { id: userId } })
			const cascaded = await prisma.session.findUnique({ where: { id: sessionId } })
			expect(cascaded).toBeNull()
		} finally {
			await prisma.user.deleteMany({ where: { id: userId } })
		}
	})

	it('batches audit logs via UNNEST and sheds poison batches after max retries', async () => {
		const prisma = getPrisma()
		const buffer = new AuditBatchBuffer(getPrisma, 128, 64, 60_000, 2)
		const id1 = Bun.randomUUIDv7()
		const id2 = Bun.randomUUIDv7()
		const poisonId = Bun.randomUUIDv7()
		const now = Date.now()

		buffer.push({
			id: id1,
			actorId: null,
			method: 'GET',
			path: '/compat-1',
			statusCode: 200,
			durationMs: 0.42,
			ip: '127.0.0.1',
			createdAt: now
		})
		buffer.push({
			id: id2,
			actorId: 'actor-1',
			method: 'POST',
			path: '/compat-2',
			statusCode: 201,
			durationMs: 1.25,
			ip: '127.0.0.1',
			createdAt: now
		})

		try {
			const flushed = await buffer.flush()
			expect(flushed).toBe(2)

			const rows = await prisma.auditLog.findMany({
				where: { id: { in: [id1, id2] } },
				select: { id: true }
			})
			expect(rows.length).toBe(2)

			// Verify NUL byte poison row is isolated via binary-split while rescuing clean rows in the same batch.
			const cleanId = Bun.randomUUIDv7()
			buffer.push({
				id: cleanId,
				actorId: null,
				method: 'POST',
				path: '/clean-alongside-poison',
				statusCode: 200,
				durationMs: 0.2,
				ip: '127.0.0.1',
				createdAt: now
			})
			buffer.push({
				id: poisonId,
				actorId: null,
				method: 'POST',
				path: '/bad\x00path',
				statusCode: 400,
				durationMs: 0.1,
				ip: '127.0.0.1',
				createdAt: now
			})
			await buffer.flush()
			const rescued = await buffer.flush()
			expect(rescued).toBe(1)
			expect(buffer.pendingCount).toBe(0)
			expect(buffer.droppedCount).toBe(1)
			const rescuedRow = await prisma.auditLog.findUnique({ where: { id: cleanId }, select: { id: true } })
			expect(rescuedRow?.id).toBe(cleanId)

			// Verify DB connectivity outage re-queues events instead of dropping clean rows in rescue mode.
			let outageCalls = 0
			const outageClient = {
				$executeRaw: async () => {
					outageCalls++
					throw new Error('ECONNREFUSED: postgres temporarily unavailable')
				}
			} as unknown as ReturnType<typeof getPrisma>
			const outageBuffer = new AuditBatchBuffer(() => outageClient, 128, 64, 60_000, 2)
			for (let i = 0; i < 10; i++) {
				outageBuffer.push({
					id: Bun.randomUUIDv7(),
					actorId: null,
					method: 'POST',
					path: `/outage-${i}`,
					statusCode: 200,
					durationMs: 0.1,
					ip: '127.0.0.1',
					createdAt: now
				})
			}
			await outageBuffer.flush()
			await outageBuffer.flush()
			await outageBuffer.flush()
			expect(outageCalls).toBe(3)
			expect(outageBuffer.pendingCount).toBe(10)
			expect(outageBuffer.droppedCount).toBe(0)
		} finally {
			await prisma.auditLog.deleteMany({ where: { id: { in: [id1, id2, poisonId] } } })
			await prisma.auditLog.deleteMany({ where: { path: '/clean-alongside-poison' } })
		}
	})

	it('connects to Redis >= 7.0 and supports atomic Lua EVALSHA scripts', async () => {
		const store = getCacheStore()
		const info = String(await store.sendRaw('INFO', ['server']))
		expect(info).toContain('redis_version:')

		const rlKey = `compat:rl:${Bun.randomUUIDv7()}`
		const lockKey = `compat:lock:${Bun.randomUUIDv7()}`
		try {
			expect(await store.incrWithExpire(rlKey, 30)).toBe(1)
			expect(await store.incrWithExpire(rlKey, 30)).toBe(2)
			const ttl = Number(await store.sendRaw('TTL', [rlKey]))
			expect(ttl).toBeGreaterThan(0)

			expect(await store.setNxEx(lockKey, 'owner-1', 30)).toBe(true)
			expect(await store.setNxEx(lockKey, 'owner-2', 30)).toBe(false)
			expect(await store.releaseLock(lockKey, 'owner-2')).toBe(false)
			expect(await store.releaseLock(lockKey, 'owner-1')).toBe(true)
		} finally {
			await store.del(rlKey, lockKey)
		}
	})

	it('coalesces concurrent misses via singleflight and isolates returned object copies', async () => {
		const key = `compat:sf:${Bun.randomUUIDv7()}`
		let loads = 0

		try {
			const results = await Promise.all(
				Array.from({ length: 10 }, () =>
					cacheGetOrSet(key, 30, async () => {
						loads++
						await Bun.sleep(15)
						return { count: loads }
					})
				)
			)

			expect(loads).toBe(1)
			results[0]!.count = 999
			expect(results[1]!.count).toBe(1)
		} finally {
			await invalidateCache(key)
		}
	})

	it('isolates corrupt Redis payloads from L1 cache and rotates/revokes {sid} hash-tagged refresh keys atomically', async () => {
		const store = getCacheStore()
		const corruptKey = `compat:corrupt:${Bun.randomUUIDv7()}`
		const sid = Bun.randomUUIDv7()
		const oldHash = 'h1'
		const newHash = 'h2'
		const tag = `{${sid}}`
		const oldKey = `auth:${tag}:rt:${oldHash}`
		const usedKey = `auth:${tag}:used:${oldHash}`
		const newKey = `auth:${tag}:rt:${newHash}`
		const revokedKey = `auth:${tag}:revoked`
		const sessionRtKey = `auth:${tag}:session_rt`
		let loadCount = 0

		try {
			await store.set(corruptKey, '{not-valid-json', 30)
			const v1 = await cacheGetOrSet(corruptKey, 30, () => {
				loadCount++
				return { ok: true, n: loadCount }
			})
			const v2 = await cacheGetOrSet(corruptKey, 30, () => {
				loadCount++
				return { ok: true, n: loadCount }
			})
			expect(v1).toEqual({ ok: true, n: 1 })
			expect(v2).toEqual({ ok: true, n: 1 })
			expect(loadCount).toBe(1)

			await store.set(oldKey, JSON.stringify({ userId: 'u1', sessionId: sid }), 60)
			await store.set(sessionRtKey, oldHash, 60)

			const first = await store.rotateRefreshToken({
				oldKey,
				usedKey,
				newKey,
				revokedKey,
				sessionRtKey,
				newHash,
				oldHash,
				ttlSeconds: 60,
				revokeTtlSeconds: 60
			})
			expect(first.status).toBe('ok')

			const reuse = await store.rotateRefreshToken({
				oldKey,
				usedKey,
				newKey: `auth:${tag}:rt:h3`,
				revokedKey,
				sessionRtKey,
				newHash: 'h3',
				oldHash,
				ttlSeconds: 60,
				revokeTtlSeconds: 60
			})
			expect(reuse).toEqual({ status: 'reuse', sessionId: sid })
			expect(await store.get(revokedKey)).toBe('1')
			expect(await store.get(sessionRtKey)).toBeNull()

			const afterRevoke = await store.rotateRefreshToken({
				oldKey: newKey,
				usedKey: `auth:${tag}:used:${newHash}`,
				newKey: `auth:${tag}:rt:h3`,
				revokedKey,
				sessionRtKey,
				newHash: 'h3',
				oldHash: newHash,
				ttlSeconds: 60,
				revokeTtlSeconds: 60
			})
			expect(afterRevoke).toEqual({ status: 'revoked' })
			expect(await store.get(newKey)).toBeNull()
		} finally {
			await invalidateCache(corruptKey)
			await store.del(
				oldKey,
				usedKey,
				newKey,
				`auth:${tag}:used:${newHash}`,
				`auth:${tag}:rt:h3`,
				revokedKey,
				sessionRtKey
			)
		}
	})
})
