import { Elysia, status } from 'elysia'
import { getCacheStore } from '../infra/cache'
import { getPrisma } from '../infra/db'
import { shutdownInfra } from '../infra/lifecycle'
import { authModule } from '../modules/auth'
import { workspacesModule } from '../modules/workspaces'
import { createAuditPlugin } from '../plugins/audit'
import { errorPlugin } from '../plugins/errors'
import { securityPlugin } from '../plugins/security'
import type { AppOptions } from './monolith'

export function createCoreService(options: AppOptions = {}) {
	const { precompile = false, enableAudit = true } = options
	return new Elysia({
		name: 'service:core',
		precompile,
		serve: {
			maxRequestBodySize: 1024 * 1024,
			idleTimeout: 30
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
			api.use(createAuditPlugin(enableAudit)).use(authModule).use(workspacesModule)
		)
}

export type CoreApp = ReturnType<typeof createCoreService>
