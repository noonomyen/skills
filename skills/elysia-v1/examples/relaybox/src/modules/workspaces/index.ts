import { Elysia, status, t } from 'elysia'
import { authMacro } from '../../plugins/auth.macro'
import { rateLimitMacro } from '../../plugins/rate-limit.macro'
import { WorkspaceSchemas } from './model'
import { WorkspaceService } from './service'

export const workspacesModule = new Elysia({ name: 'module:workspaces', prefix: '/workspaces' })
	.use(authMacro)
	.use(rateLimitMacro)
	.model(WorkspaceSchemas)
	.prefix('model', 'ws.')
	.post(
		'/',
		async ({ auth, body }) => {
			const created = await WorkspaceService.create(auth.userId, body)
			return status(201, created)
		},
		{
			auth: true,
			rateLimit: { keyPrefix: 'ws-create', limit: 30, windowSec: 60 },
			body: 'ws.CreateBody',
			response: {
				201: 'ws.WorkspaceCreatedDto',
				401: 'ws.ErrorResponse',
				409: 'ws.ErrorResponse',
				429: 'ws.ErrorResponse'
			}
		}
	)
	.get(
		'/:workspaceId',
		({ auth, params: { workspaceId } }) => WorkspaceService.getForMember(workspaceId, auth.userId),
		{
			auth: true,
			params: t.Object({ workspaceId: t.String({ pattern: '^[a-zA-Z0-9_-]{1,64}$' }) }),
			response: {
				200: 'ws.WorkspaceDto',
				401: 'ws.ErrorResponse',
				403: 'ws.ErrorResponse',
				404: 'ws.ErrorResponse'
			}
		}
	)
