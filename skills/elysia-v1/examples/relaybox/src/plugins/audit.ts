import { Elysia, ElysiaCustomStatusResponse } from 'elysia'
import { auditBuffer } from '../infra/audit-buffer'
import { requestActorMap } from './auth.macro'
import { resolveClientIp } from './security'

const requestStartNs = new WeakMap<Request, number>()

export function createAuditPlugin(enableAudit: boolean) {
	if (!enableAudit) {
		return new Elysia({ name: 'plugin:audit', seed: false })
	}

	return new Elysia({ name: 'plugin:audit', seed: true })
		.onRequest(({ request }) => {
			if (request.method !== 'GET' && request.method !== 'HEAD') {
				requestStartNs.set(request, Bun.nanoseconds())
			}
		})
		.onAfterResponse({ as: 'scoped' }, ({ request, path, set, server, responseValue }) => {
			if (request.method === 'GET' || request.method === 'HEAD') return
			const started = requestStartNs.get(request)
			const durationMs = started !== undefined ? (Bun.nanoseconds() - started) / 1_000_000 : 0
			const ip = resolveClientIp(request, server?.requestIP(request)?.address)
			const statusCode =
				responseValue instanceof ElysiaCustomStatusResponse &&
				typeof responseValue.code === 'number'
					? responseValue.code
					: responseValue instanceof Response
						? responseValue.status
						: typeof set.status === 'number'
							? set.status
							: 200

			// Strip NUL bytes and bound path length so adversarial URLs cannot poison PostgreSQL UTF-8 audit inserts.
			const safePath = path.replace(/\x00/g, '').slice(0, 512)

			auditBuffer.push({
				id: Bun.randomUUIDv7(),
				actorId: requestActorMap.get(request) ?? null,
				method: request.method,
				path: safePath,
				statusCode,
				durationMs,
				ip,
				createdAt: Date.now()
			})
		})
}
