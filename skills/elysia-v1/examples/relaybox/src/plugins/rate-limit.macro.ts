import { Elysia, status } from 'elysia'
import { getCacheStore } from '../infra/cache'
import { securityPlugin } from './security'

export interface RateLimitConfig {
	keyPrefix: string
	limit: number
	windowSec: number
	fallbackOnRedisError?: 'fail-open' | 'memory'
}

interface LocalBucket {
	count: number
	expiresAt: number
}

const localFallbackBuckets = new Map<string, LocalBucket>()
const MAX_LOCAL_BUCKETS = 4096

function incrementLocalFallback(key: string, resetSec: number): number {
	const now = Date.now()
	const existing = localFallbackBuckets.get(key)
	if (!existing || existing.expiresAt <= now) {
		if (localFallbackBuckets.size >= MAX_LOCAL_BUCKETS) {
			for (const [k, v] of localFallbackBuckets) {
				if (v.expiresAt <= now) localFallbackBuckets.delete(k)
			}
			if (localFallbackBuckets.size >= MAX_LOCAL_BUCKETS) {
				const oldest = localFallbackBuckets.keys().next().value
				if (oldest !== undefined) localFallbackBuckets.delete(oldest)
			}
		}
		localFallbackBuckets.set(key, { count: 1, expiresAt: now + resetSec * 1000 })
		return 1
	}
	existing.count++
	return existing.count
}

export async function checkRateLimit(
	config: RateLimitConfig,
	identity: string,
	headersTarget?: Record<string, string | number>
): Promise<{ limited: boolean; resetSec: number; remaining: number }> {
	if (!Number.isFinite(config.windowSec) || config.windowSec <= 0 || config.limit <= 0) {
		throw new RangeError('rateLimit windowSec and limit must be positive')
	}
	const nowSec = Math.floor(Date.now() / 1000)
	const bucket = Math.floor(nowSec / config.windowSec)
	const resetSec = Math.max(1, (bucket + 1) * config.windowSec - nowSec)
	const key = `rl:${config.keyPrefix}:${identity}:${bucket}`

	let count: number
	try {
		count = await getCacheStore().incrWithExpire(key, resetSec)
	} catch (err) {
		console.error(`[relaybox:rate-limit] Redis unavailable for ${config.keyPrefix}:`, err)
		if (config.fallbackOnRedisError === 'memory') {
			count = incrementLocalFallback(key, resetSec)
		} else {
			return { limited: false, resetSec, remaining: config.limit }
		}
	}

	const remaining = Math.max(0, config.limit - count)
	if (headersTarget) {
		headersTarget['x-ratelimit-limit'] = String(config.limit)
		headersTarget['x-ratelimit-remaining'] = String(remaining)
		headersTarget['x-ratelimit-reset'] = String(resetSec)
	}

	if (count > config.limit) {
		if (headersTarget) {
			headersTarget['retry-after'] = String(resetSec)
		}
		return { limited: true, resetSec, remaining: 0 }
	}

	return { limited: false, resetSec, remaining }
}

export const rateLimitMacro = new Elysia({ name: 'macro:rate-limit' })
	.use(securityPlugin)
	.macro({
		rateLimit(config: RateLimitConfig) {
			if (config.windowSec <= 0 || config.limit <= 0) {
				throw new RangeError('rateLimit windowSec and limit must be positive')
			}
			return {
				async beforeHandle({ request, server, getClientIp, set }) {
					const ip = getClientIp(request, server)
					const result = await checkRateLimit(config, ip, set.headers)
					if (result.limited) {
						return status(429, {
							error: 'Too many requests',
							code: 'RATE_LIMITED'
						})
					}
				}
			}
		}
	})
