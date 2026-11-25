import { Elysia, status } from 'elysia'
import { getCacheStore } from '../infra/cache'
import { getPrisma } from '../infra/db'
import { shutdownInfra } from '../infra/lifecycle'
import { artifactsModule } from '../modules/artifacts'
import { webhooksModule } from '../modules/webhooks'
import { createAuditPlugin } from '../plugins/audit'
import { errorPlugin } from '../plugins/errors'
import { securityPlugin } from '../plugins/security'
import type { AppOptions } from './monolith'

export function createIngestService(options: AppOptions = {}) {
	const { precompile = false, enableAudit = true } = options
	return new Elysia({
		name: 'service:ingest',
		precompile,
		serve: {
			maxRequestBodySize: 3 * 1024 * 1024,
			idleTimeout: 30
		},
		websocket: {
			maxPayloadLength: 64 * 1024,
			idleTimeout: 60,
			backpressureLimit: 1024 * 1024
		}
	})
		.use(errorPlugin)
		.use(securityPlugin)
		.get('/healthz', () => 'ok')
		.get('/readyz', async () => {
			try {
				await Promise.all([getPrisma().$queryRaw`SELECT 1`, getCacheStore().ping()])
				return { status: 'ready' }
			} catch {
				return status(503, { error: 'Dependencies unavailable', code: 'NOT_READY' })
			}
		})
		.onStop(() => shutdownInfra(enableAudit))
		.group('/api', (api) =>
			api.use(createAuditPlugin(enableAudit)).use(webhooksModule).use(artifactsModule)
		)
}

export type IngestApp = ReturnType<typeof createIngestService>
