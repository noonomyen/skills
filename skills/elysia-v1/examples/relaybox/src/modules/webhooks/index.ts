import {
	Elysia,
	ElysiaCustomStatusResponse,
	ElysiaFile,
	StatusMap,
	ValidationError,
	status,
	t
} from 'elysia'
import { env } from '../../env'
import { getCacheStore } from '../../infra/cache'
import { eventBus, type WorkspaceEvent } from '../../infra/event-bus'
import { authMacro } from '../../plugins/auth.macro'
import { AppError } from '../../plugins/errors'
import {
	IDEM_KEY_RE,
	buildIdempotencyScope,
	idempotencyMacro
} from '../../plugins/idempotency.macro'
import { checkRateLimit, rateLimitMacro } from '../../plugins/rate-limit.macro'
import { resolveClientIp } from '../../plugins/security'
import { WorkspaceService } from '../workspaces/service'
import { WebhookSchemas } from './model'
import { WebhookService } from './service'

const MAX_WEBHOOK_BYTES = 256 * 1024
const MAX_SSE_QUEUE = 256
const SSE_HEARTBEAT_MS = 15_000
const WORKSPACE_ID_PATTERN = '^[a-zA-Z0-9_-]{1,64}$'
const WORKSPACE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/
const ID_MAX_LEN = 64
const decoder = new TextDecoder('utf-8', { fatal: true })
const encoder = new TextEncoder()

interface PendingSignature {
	sigKey: string
	idemMarker: string
	alreadyCompleted: boolean
}

const pendingSigMap = new WeakMap<Request, PendingSignature>()

// RFC 9110 S12.5.3 Accept-Encoding negotiation supporting gzip, x-gzip, case-insensitivity, and [0,1] q-values.
export function acceptsGzipEncoding(header: string | undefined): boolean {
	if (!header) return false
	let gzipQ: number | null = null
	let wildcardQ: number | null = null

	for (const part of header.split(',')) {
		const segments = part.trim().split(';')
		const coding = segments[0]?.trim().toLowerCase()
		if (!coding) continue
		let q = 1
		for (let i = 1; i < segments.length; i++) {
			const kv = segments[i]!.trim().toLowerCase()
			if (kv.startsWith('q=')) {
				const parsed = Number(kv.slice(2))
				q = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0
			}
		}
		if (coding === 'gzip' || coding === 'x-gzip') gzipQ = q
		else if (coding === '*') wildcardQ = q
	}

	if (gzipQ !== null) return gzipQ > 0
	return wildcardQ !== null && wildcardQ > 0
}

function appendVary(existing: string | undefined, token: string): string {
	if (!existing) return token
	const parts = existing.split(',').map((s) => s.trim().toLowerCase())
	return parts.includes(token.toLowerCase()) ? existing : `${existing}, ${token}`
}

function resolveStatusCode(raw: number | string | undefined): number {
	if (typeof raw === 'number') return raw
	if (typeof raw === 'string' && raw in StatusMap) {
		return StatusMap[raw as keyof typeof StatusMap]
	}
	return 200
}

function compressLargeJson({
	headers,
	responseValue,
	set
}: {
	headers: Record<string, string | undefined>
	responseValue: unknown
	set: { status?: number | string; headers: Record<string, string | number> }
}) {
	if (responseValue === undefined || responseValue === null) return
	if (
		responseValue instanceof Response ||
		responseValue instanceof ElysiaFile ||
		responseValue instanceof ElysiaCustomStatusResponse ||
		responseValue instanceof ReadableStream ||
		responseValue instanceof Blob ||
		responseValue instanceof ArrayBuffer ||
		ArrayBuffer.isView(responseValue)
	) {
		return
	}

	const statusCode = resolveStatusCode(set.status)
	const mergedHeaders = new Headers()
	for (const [k, v] of Object.entries(set.headers)) {
		if (v !== undefined) mergedHeaders.set(k, String(v))
	}
	const varyHeader = appendVary(mergedHeaders.get('vary') ?? undefined, 'Accept-Encoding')
	mergedHeaders.set('vary', varyHeader)

	if (!acceptsGzipEncoding(headers['accept-encoding'])) {
		for (const k of Object.keys(set.headers)) {
			if (k.toLowerCase() === 'vary') delete set.headers[k]
		}
		set.headers.vary = varyHeader
		return
	}

	const isJson = typeof responseValue === 'object'
	const rawText = isJson ? JSON.stringify(responseValue) : String(responseValue)
	const rawBytes = encoder.encode(rawText)
	if (!mergedHeaders.has('content-type')) {
		mergedHeaders.set('content-type', `${isJson ? 'application/json' : 'text/plain'}; charset=utf-8`)
	}

	// Avoid a second JSON.stringify pass inside Elysia when payload stays uncompressed (< 1 KB).
	if (rawBytes.byteLength < 1024) {
		return new Response(rawBytes, {
			status: statusCode,
			headers: mergedHeaders
		})
	}

	const compressed = Bun.gzipSync(rawBytes)
	mergedHeaders.set('content-encoding', 'gzip')
	return new Response(compressed, {
		status: statusCode,
		headers: mergedHeaders
	})
}

function formatSseFrame(event: string, data: unknown, id?: string): Uint8Array {
	const safeEvent = event.replace(/[\r\n]/g, '')
	let frame = ''
	if (id) frame += `id: ${id.replace(/[\r\n]/g, '')}\n`
	frame += `event: ${safeEvent}\ndata: ${JSON.stringify(data)}\n\n`
	return encoder.encode(frame)
}

async function readLimitedBodyBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
	const rawLen = request.headers.get('content-length')
	if (rawLen !== null) {
		const parsedLen = Number(rawLen)
		if (!Number.isFinite(parsedLen) || parsedLen < 0) {
			throw new AppError(400, 'PARSE_ERROR', 'Invalid Content-Length header')
		}
		if (parsedLen > maxBytes) {
			throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Webhook payload exceeds 256KB limit')
		}
	}

	if (!request.body) return new Uint8Array(0)
	const reader = request.body.getReader()
	const chunks: Uint8Array[] = []
	let total = 0

	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			if (!value) continue
			total += value.byteLength
			if (total > maxBytes) {
				await reader.cancel().catch(() => {})
				throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Webhook payload exceeds 256KB limit')
			}
			chunks.push(value)
		}
	} finally {
		reader.releaseLock()
	}

	const merged = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		merged.set(chunk, offset)
		offset += chunk.byteLength
	}
	return merged
}

export const webhooksModule = new Elysia({ name: 'module:webhooks', prefix: '/webhooks' })
	.use(authMacro)
	.use(rateLimitMacro)
	.use(idempotencyMacro)
	.model(WebhookSchemas)
	.prefix('model', 'wh.')
	.post(
		'/ingest/:workspaceId',
		async ({ request, params: { workspaceId }, headers, body }) => {
			const sigState = pendingSigMap.get(request)
			if (!sigState) {
				throw new AppError(
					401,
					'INVALID_SIGNATURE',
					'Invalid or expired webhook signature',
					true,
					{ 'www-authenticate': 'HMAC-SHA256 realm="relaybox"' }
				)
			}
			const store = getCacheStore()
			let claimed = false

			if (!sigState.alreadyCompleted) {
				try {
					claimed = await store.setNxEx(sigState.sigKey, sigState.idemMarker, 600)
				} catch {
					throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Replay store unavailable')
				}
				if (!claimed) {
					throw new AppError(
						401,
						'SIGNATURE_REPLAYED',
						'Webhook signature already consumed',
						true,
						{ 'www-authenticate': 'HMAC-SHA256 realm="relaybox"' }
					)
				}
			}

			try {
				const source = (headers['x-webhook-source'] ?? 'generic').slice(0, 64)
				const res = await WebhookService.ingest({ workspaceId, source, body })
				return status(202, res)
			} catch (err) {
				// Release replay marker if persistence failed so sender can safely retry transient errors.
				if (sigState && claimed) {
					await store.del(sigState.sigKey).catch(() => {})
				}
				throw err
			}
		},
		{
			idempotent: { ttlSeconds: 300, fingerprintHeaders: ['x-webhook-source'] },
			params: t.Object({ workspaceId: t.String({ pattern: WORKSPACE_ID_PATTERN }) }),
			body: 'wh.IngestBody',
			response: {
				202: 'wh.IngestResponse',
				400: 'wh.ErrorResponse',
				401: 'wh.ErrorResponse',
				409: 'wh.ErrorResponse',
				413: 'wh.ErrorResponse',
				422: 'wh.ErrorResponse',
				429: 'wh.ErrorResponse',
				503: 'wh.ErrorResponse'
			},
			async parse(ctx) {
				const { request, set } = ctx
				const pathname = new URL(request.url).pathname
				const workspaceId =
					(ctx as { params?: { workspaceId?: string } }).params?.workspaceId ??
					pathname.split('/').pop() ??
					''

				if (!WORKSPACE_ID_RE.test(workspaceId)) {
					throw new AppError(400, 'INVALID_WORKSPACE_ID', 'Invalid workspaceId')
				}

				const server =
					(ctx as { server?: { requestIP(req: Request): { address: string } | null } | null })
						.server ?? null
				const clientIp = resolveClientIp(request, server?.requestIP(request)?.address)
				const rl = await checkRateLimit(
					{ keyPrefix: 'wh-ingest', limit: env.RATE_LIMIT_PER_MIN, windowSec: 60 },
					`${workspaceId}:${clientIp}`,
					set.headers
				)
				if (rl.limited) {
					throw new AppError(429, 'RATE_LIMITED', 'Too many requests', true, {
						'retry-after': String(rl.resetSec)
					})
				}

				const rawBytes = await readLimitedBodyBytes(request, MAX_WEBHOOK_BYTES)
				const secret = await WorkspaceService.getIngestSecret(workspaceId)
				if (!secret) {
					throw new AppError(
						401,
						'INVALID_SIGNATURE',
						'Invalid or expired webhook signature',
						true,
						{ 'www-authenticate': 'HMAC-SHA256 realm="relaybox"' }
					)
				}

				const verified = WebhookService.verifySignedRequest({
					method: request.method,
					path: pathname,
					workspaceId,
					rawBytes,
					timestampHeader: request.headers.get('x-webhook-timestamp'),
					signatureHeader: request.headers.get('x-webhook-signature'),
					secret
				})
				if (!verified.valid) {
					throw new AppError(
						401,
						'INVALID_SIGNATURE',
						'Invalid or expired webhook signature',
						true,
						{ 'www-authenticate': 'HMAC-SHA256 realm="relaybox"' }
					)
				}

				const store = getCacheStore()
				const sigKey = `wh:sig:${workspaceId}:${verified.ts}:${verified.sigHex}`
				const rawIdemKey = request.headers.get('idempotency-key')
				const validIdemKey = rawIdemKey && IDEM_KEY_RE.test(rawIdemKey) ? rawIdemKey : null

				let consumedMarker: string | null
				try {
					consumedMarker = await store.get(sigKey)
				} catch {
					throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Replay store unavailable')
				}

				if (consumedMarker !== null) {
					const hasCachedReplay = validIdemKey
						? (await store
								.get(`idem:resp:${buildIdempotencyScope(request, validIdemKey)}`)
								.catch(() => null)) !== null
						: false

					if (!validIdemKey || consumedMarker !== validIdemKey || !hasCachedReplay) {
						throw new AppError(
							401,
							'SIGNATURE_REPLAYED',
							'Webhook signature already consumed',
							true,
							{ 'www-authenticate': 'HMAC-SHA256 realm="relaybox"' }
						)
					}
				}

				pendingSigMap.set(request, {
					sigKey,
					idemMarker: validIdemKey ?? 'none',
					alreadyCompleted: consumedMarker !== null
				})

				return JSON.parse(decoder.decode(rawBytes)) as unknown
			}
		}
	)
	.get(
		'/:id',
		({ auth, params: { id }, set }) => {
			set.headers['cache-control'] = 'private, no-store'
			return WebhookService.getById(id, auth.userId)
		},
		{
			auth: true,
			params: t.Object({ id: t.String({ minLength: 1, maxLength: ID_MAX_LEN }) }),
			response: {
				200: 'wh.WebhookDto',
				401: 'wh.ErrorResponse',
				403: 'wh.ErrorResponse',
				404: 'wh.ErrorResponse'
			},
			mapResponse: compressLargeJson
		}
	)
	.get(
		'/workspace/:workspaceId',
		({ auth, params: { workspaceId }, query: { limit = 20, events }, set }) => {
			set.headers['cache-control'] = 'private, no-store'
			return WebhookService.listByWorkspace(workspaceId, auth.userId, limit, events)
		},
		{
			auth: true,
			params: t.Object({ workspaceId: t.String({ pattern: WORKSPACE_ID_PATTERN }) }),
			query: 'wh.ListQuery',
			response: {
				200: t.Array(WebhookSchemas.webhookDto),
				401: 'wh.ErrorResponse',
				403: 'wh.ErrorResponse'
			},
			mapResponse: compressLargeJson
		}
	)
	.get(
		'/stream/:workspaceId',
		async ({ auth, params: { workspaceId }, headers, request }) => {
			await WorkspaceService.assertMember(workspaceId, auth.userId)

			let closed = false
			let cleanup: (() => void) | null = null
			const lastEventId = headers['last-event-id']

			const stream = new ReadableStream<Uint8Array>(
				{
					async start(controller) {
						let droppedSinceDrain = 0
						let replaying = Boolean(lastEventId)
						let replayBufferOverflow = false
						const bufferedLive: WorkspaceEvent[] = []

						const closeCleanly = () => {
							if (closed) return
							closed = true
							cleanup?.()
							try {
								controller.close()
							} catch {
								// Stream already closed.
							}
						}

						const enqueueSafe = (chunk: Uint8Array) => {
							if (closed) return
							const desired = controller.desiredSize ?? 0
							if (desired <= 0) {
								droppedSinceDrain++
								if (droppedSinceDrain === 1) {
									try {
										controller.enqueue(formatSseFrame('warning', { code: 'SLOW_CONSUMER_DROPPED' }))
									} catch {
										closeCleanly()
									}
								}
								return
							}
							droppedSinceDrain = 0
							try {
								controller.enqueue(chunk)
							} catch {
								closeCleanly()
							}
						}

						// Subscribe before replaying so events emitted mid-replay are buffered and deduplicated.
						const unsubscribe = eventBus.subscribe(workspaceId, (event) => {
							if (closed) return
							if (replaying) {
								if (bufferedLive.length < MAX_SSE_QUEUE) {
									bufferedLive.push(event)
								} else {
									replayBufferOverflow = true
								}
								return
							}
							enqueueSafe(formatSseFrame(event.eventType, event, event.id))
						})

						const heartbeat = setInterval(() => {
							if (!closed && (controller.desiredSize ?? 0) > 0) {
								try {
									controller.enqueue(encoder.encode(': keepalive\n\n'))
								} catch {
									closeCleanly()
								}
							}
						}, SSE_HEARTBEAT_MS)
						heartbeat.unref?.()

						const ttlMs = Math.max(0, auth.exp * 1000 - Date.now())
						const expiryTimer = setTimeout(() => {
							if (!closed) {
								try {
									controller.enqueue(formatSseFrame('error', { code: 'TOKEN_EXPIRED' }))
								} catch {
									// Ignore write errors before closing.
								}
								closeCleanly()
							}
						}, ttlMs)
						expiryTimer.unref?.()

						const revokeCheck = setInterval(() => {
							if (closed) return
							void Promise.all([
								getCacheStore().get(`auth:{${auth.sessionId}}:revoked`),
								WorkspaceService.assertMember(workspaceId, auth.userId)
									.then(() => true)
									.catch(() => false)
							])
								.then(([revoked, isMember]) => {
									if ((revoked || !isMember) && !closed) closeCleanly()
								})
								.catch(() => {
									// Fail-closed on auth store outage consistent with HTTP endpoints.
									closeCleanly()
								})
						}, 30_000)
						revokeCheck.unref?.()

						const onAbort = () => closeCleanly()
						request.signal.addEventListener('abort', onAbort, { once: true })

						cleanup = () => {
							clearInterval(heartbeat)
							clearTimeout(expiryTimer)
							clearInterval(revokeCheck)
							request.signal.removeEventListener('abort', onAbort)
							unsubscribe()
						}

						if (request.signal.aborted || closed) {
							closeCleanly()
							return
						}

						try {
							controller.enqueue(formatSseFrame('connected', { workspaceId }))
						} catch {
							closeCleanly()
							return
						}

						if (lastEventId) {
							try {
								const seenIds = new Set<string>()
								const { items, hasMore } = await WebhookService.replayAfter(workspaceId, lastEventId)
								for (const item of items) {
									if (closed) return
									seenIds.add(item.id)
									enqueueSafe(formatSseFrame(item.eventType, item, item.id))
								}
								if (hasMore) {
									// Close cleanly after signaling truncation so client reconnects from its last received ID without skipping gap events.
									enqueueSafe(formatSseFrame('warning', { code: 'REPLAY_TRUNCATED' }))
									closeCleanly()
									return
								}
								replaying = false
								for (const live of bufferedLive) {
									if (closed) return
									if (!seenIds.has(live.id)) {
										enqueueSafe(formatSseFrame(live.eventType, live, live.id))
									}
								}
								if (replayBufferOverflow) {
									enqueueSafe(formatSseFrame('warning', { code: 'SLOW_CONSUMER_DROPPED' }))
								}
							} catch (err) {
								console.error('[relaybox:sse] replay failed:', err)
								closeCleanly()
							}
						}
					},
					cancel() {
						closed = true
						cleanup?.()
					}
				},
				new CountQueuingStrategy({ highWaterMark: MAX_SSE_QUEUE })
			)

			return new Response(stream, {
				status: 200,
				headers: {
					'content-type': 'text/event-stream; charset=utf-8',
					'cache-control': 'no-cache, no-transform',
					connection: 'keep-alive'
				}
			})
		},
		{
			auth: true,
			params: t.Object({ workspaceId: t.String({ pattern: WORKSPACE_ID_PATTERN }) })
		}
	)
	.ws('/ws/:workspaceId', {
		auth: true,
		rateLimit: { keyPrefix: 'wh-ws-connect', limit: 60, windowSec: 60 },
		params: t.Object({ workspaceId: t.String({ pattern: WORKSPACE_ID_PATTERN }) }),
		body: t.Object({
			action: t.Union([t.Literal('ping'), t.Literal('broadcast')]),
			message: t.Optional(t.String({ maxLength: 4096 }))
		}),
		// In Elysia .ws(), options.beforeHandle must throw (return value is ignored before upgrade).
		async beforeHandle({ auth, params }) {
			await WorkspaceService.assertMember(params.workspaceId, auth.userId)
		},
		error({ error }) {
			if (error instanceof ValidationError) {
				return {
					error: env.IS_PRODUCTION ? 'Validation failed' : error.message,
					code: 'VALIDATION_ERROR'
				}
			}
			return {
				error: env.IS_PRODUCTION
					? 'WebSocket error'
					: error instanceof Error
						? error.message
						: 'WebSocket error',
				code: 'WS_ERROR'
			}
		},
		open(ws) {
			if (Math.floor(Date.now() / 1000) >= ws.data.auth.exp) {
				ws.close(4001, 'Token expired')
				return
			}
			const topic = `ws:${ws.data.params.workspaceId}`
			ws.subscribe(topic)
			ws.send({ type: 'subscribed', topic })
		},
		async message(ws, body) {
			if (Math.floor(Date.now() / 1000) >= ws.data.auth.exp) {
				ws.close(4001, 'Token expired')
				return
			}

			try {
				const [revoked] = await Promise.all([
					getCacheStore().get(`auth:{${ws.data.auth.sessionId}}:revoked`),
					WorkspaceService.assertMember(ws.data.params.workspaceId, ws.data.auth.userId)
				])
				if (revoked) {
					ws.close(4001, 'Session revoked')
					return
				}
			} catch {
				ws.close(4001, 'Authorization check failed')
				return
			}

			const rl = await checkRateLimit(
				{ keyPrefix: 'wh-ws-msg', limit: 120, windowSec: 10, fallbackOnRedisError: 'memory' },
				`${ws.data.auth.sessionId}:${ws.data.params.workspaceId}`
			)
			if (rl.limited) {
				ws.close(1008, 'WebSocket rate limit exceeded')
				return
			}

			if (body.action === 'ping') {
				ws.send({ type: 'pong', ts: Date.now() })
				return
			}
			const topic = `ws:${ws.data.params.workspaceId}`
			const payload = { type: 'broadcast', message: body.message ?? '', ts: Date.now() }
			ws.publish(topic, payload)
			ws.send(payload)
		}
	})
