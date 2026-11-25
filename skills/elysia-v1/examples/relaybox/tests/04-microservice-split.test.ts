import { beforeAll, describe, expect, it } from 'bun:test'
import { createCoreService } from '../src/apps/core-service'
import { createIngestService } from '../src/apps/ingest-service'
import { getCacheStore, invalidateCache } from '../src/infra/cache'
import { ensureDatabaseConnected, getPrisma } from '../src/infra/db'
import { registerAndCreateWorkspace, signWebhook } from './fixtures'

describe('04: Modular Monolith -> Microservice Split Parity', () => {
	beforeAll(async () => {
		await ensureDatabaseConnected()
		await getCacheStore().ping()
	})

	it('runs core-service and ingest-service independently while sharing auth & workspace membership', async () => {
		const prisma = getPrisma()
		const store = getCacheStore()
		const core = createCoreService({ precompile: true, enableAudit: false })
		const ingest = createIngestService({ precompile: true, enableAudit: false })
		const tenant = await registerAndCreateWorkspace(core, 'split')
		let webhookId = ''
		const payload = JSON.stringify({ event: 'split.ok', data: { ok: true } })
		const signed = signWebhook({
			workspaceId: tenant.workspaceId,
			bodyText: payload,
			secret: tenant.webhookSecret
		})

		try {
			expect((await core.handle(new Request('http://localhost/api/webhooks/nope'))).status).toBe(404)
			expect((await ingest.handle(new Request('http://localhost/api/auth/me'))).status).toBe(404)

			const ing = await ingest.handle(
				new Request(`http://localhost/api/webhooks/ingest/${tenant.workspaceId}`, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'x-webhook-timestamp': signed.ts,
						'x-webhook-signature': signed.sig
					},
					body: payload
				})
			)
			expect(ing.status).toBe(202)
			webhookId = ((await ing.json()) as { id: string }).id

			const lookup = await ingest.handle(
				new Request(`http://localhost/api/webhooks/${webhookId}`, {
					headers: { authorization: `Bearer ${tenant.accessToken}` }
				})
			)
			expect(lookup.status).toBe(200)
		} finally {
			if (webhookId) await invalidateCache(`wh:item:${webhookId}`)
			await store.del(`wh:sig:${tenant.workspaceId}:${signed.ts}:${signed.sig.slice(7)}`)
			await prisma.webhook.deleteMany({ where: { workspaceId: tenant.workspaceId } })
			await prisma.user.deleteMany({ where: { id: tenant.userId } })
		}
	})
})
