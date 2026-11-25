import { CryptoHasher } from 'bun'
import { Elysia, ElysiaCustomStatusResponse, ElysiaFile, status } from 'elysia'
import { getCacheStore } from '../infra/cache'
import { requestActorMap } from './auth.macro'

export const IDEM_KEY_RE = /^[a-zA-Z0-9._-]{1,128}$/
const REPLAY_HEADER_ALLOWLIST = ['content-type', 'location', 'etag'] as const

export interface IdempotentConfig {
	ttlSeconds?: number
	fingerprintHeaders?: string[]
}

interface CachedIdempotentResponse {
	statusCode: number
	requestHash: string
	headers: Record<string, string>
	body: unknown
}

interface LockState {
	cacheKey: string
	lockKey: string
	owner: string
	requestHash: string
}

const lockStates = new WeakMap<Request, LockState>()

function canonicalizeValue(value: unknown): unknown {
	if (value instanceof Date) return value.toISOString()
	if (value instanceof RegExp) return value.toString()
	if (value instanceof Blob) {
		const file = value as Partial<File>
		return {
			__blob: true,
			name: file.name ?? '',
			size: value.size,
			type: value.type,
			lastModified: file.lastModified ?? 0
		}
	}
	if (value instanceof ArrayBuffer) return Buffer.from(value).toString('base64')
	if (ArrayBuffer.isView(value)) {
		return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64')
	}
	if (value instanceof Set) {
		return Array.from(value, canonicalizeValue)
	}
	if (value instanceof Map) {
		return Array.from(value.entries())
			.map(([k, v]) => [canonicalizeValue(k), canonicalizeValue(v)] as const)
			.sort((a, b) => JSON.stringify(a[0]).localeCompare(JSON.stringify(b[0])))
	}
	if (Array.isArray(value)) {
		return value.map(canonicalizeValue)
	}
	if (value !== null && typeof value === 'object') {
		const sorted: Record<string, unknown> = {}
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			sorted[key] = canonicalizeValue((value as Record<string, unknown>)[key])
		}
		return sorted
	}
	return value
}

function fingerprintRequest(
	method: string,
	pathWithQuery: string,
	extraHeaders: string,
	body: unknown
): string {
	const serialized =
		typeof body === 'string' ? body : JSON.stringify(canonicalizeValue(body ?? null))
	return new CryptoHasher('sha256')
		.update(`${method}\n${pathWithQuery}\n${extraHeaders}\n${serialized}`)
		.digest('hex')
}

export function buildIdempotencyScope(request: Request, idemKey: string): string {
	const parsedUrl = new URL(request.url)
	const pathWithQuery = `${parsedUrl.pathname}${parsedUrl.search}`
	const actor = requestActorMap.get(request)
	const actorScope = actor ? `u:${actor}` : `p:${parsedUrl.pathname}`
	return `${actorScope}:${request.method}:${pathWithQuery}:${idemKey}`
}

async function releaseOwnedLock(request: Request) {
	const state = lockStates.get(request)
	if (!state) return
	lockStates.delete(request)
	try {
		await getCacheStore().releaseLock(state.lockKey, state.owner)
	} catch (err) {
		console.error('[relaybox:idempotency] failed to release lock:', err)
	}
}

function isNonCacheableBody(value: unknown): boolean {
	return (
		value instanceof Response ||
		value instanceof ReadableStream ||
		value instanceof ElysiaFile ||
		value instanceof Blob ||
		value instanceof ArrayBuffer ||
		ArrayBuffer.isView(value)
	)
}

export const idempotencyMacro = new Elysia({ name: 'macro:idempotency' }).macro({
	idempotent(option: number | boolean | IdempotentConfig = 300) {
		if (!option) return {}
		const ttl =
			typeof option === 'number'
				? option
				: typeof option === 'object'
					? (option.ttlSeconds ?? 300)
					: 300
		const fingerprintHeaders =
			typeof option === 'object' && option.fingerprintHeaders ? option.fingerprintHeaders : []

		return {
			async beforeHandle({ request, headers, body, set }) {
				const idemKey = headers['idempotency-key']
				if (!idemKey) return
				if (!IDEM_KEY_RE.test(idemKey)) {
					return status(400, {
						error: 'Invalid Idempotency-Key header format',
						code: 'INVALID_IDEMPOTENCY_KEY'
					})
				}

				const parsedUrl = new URL(request.url)
				const pathWithQuery = `${parsedUrl.pathname}${parsedUrl.search}`
				const extraHeaders = fingerprintHeaders
					.map((name) => `${name.toLowerCase()}:${headers[name.toLowerCase()] ?? ''}`)
					.join('\n')
				const scope = buildIdempotencyScope(request, idemKey)
				const cacheKey = `idem:resp:${scope}`
				const lockKey = `idem:lock:${scope}`
				const requestHash = fingerprintRequest(request.method, pathWithQuery, extraHeaders, body)

				const store = getCacheStore()
				let cachedRaw: string | null = null
				try {
					cachedRaw = await store.get(cacheKey)
				} catch {
					// Fail open on cache read error to avoid dropping valid requests on transient Redis outages.
				}

				if (cachedRaw !== null) {
					try {
						const parsed = JSON.parse(cachedRaw) as CachedIdempotentResponse
						if (parsed.requestHash !== requestHash) {
							return status(422, {
								error: 'Idempotency-Key reused with different request payload',
								code: 'IDEMPOTENCY_KEY_MISMATCH'
							})
						}
						for (const [k, v] of Object.entries(parsed.headers)) {
							set.headers[k] = v
						}
						return status(parsed.statusCode as 200, parsed.body)
					} catch {
						// Corrupt cache payload; proceed under lock.
					}
				}

				const owner = Bun.randomUUIDv7()
				let acquired = true
				try {
					acquired = await store.setNxEx(lockKey, owner, 30)
				} catch {
					return
				}

				if (!acquired) {
					set.headers['retry-after'] = '1'
					return status(409, {
						error: 'Request with this Idempotency-Key is already in progress',
						code: 'IDEMPOTENCY_IN_FLIGHT'
					})
				}
				lockStates.set(request, { cacheKey, lockKey, owner, requestHash })
			},
			async afterHandle({ request, responseValue, set }) {
				const state = lockStates.get(request)
				if (!state) return

				try {
					const isCustomStatus = responseValue instanceof ElysiaCustomStatusResponse
					const statusCode = isCustomStatus
						? responseValue.code
						: typeof set.status === 'number'
							? set.status
							: 200
					const body = isCustomStatus ? responseValue.response : responseValue

					if (statusCode >= 200 && statusCode < 300 && !isNonCacheableBody(body)) {
						const savedHeaders: Record<string, string> = {}
						for (const headerName of REPLAY_HEADER_ALLOWLIST) {
							const val = set.headers[headerName]
							if (val !== undefined) savedHeaders[headerName] = String(val)
						}
						try {
							await getCacheStore().set(
								state.cacheKey,
								JSON.stringify({
									statusCode,
									requestHash: state.requestHash,
									headers: savedHeaders,
									body
								} satisfies CachedIdempotentResponse),
								ttl
							)
						} catch (err) {
							console.error('[relaybox:idempotency] failed to cache response:', err)
						}
					}
				} finally {
					await releaseOwnedLock(request)
				}
			},
			async afterResponse({ request }) {
				await releaseOwnedLock(request)
			}
		}
	}
})
