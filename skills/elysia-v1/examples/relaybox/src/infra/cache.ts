import { CryptoHasher, RedisClient } from 'bun'
import { env } from '../env'

export type RotateResult =
	| { status: 'ok'; payload: string }
	| { status: 'reuse'; sessionId: string }
	| { status: 'revoked' }
	| { status: 'miss' }

export interface CacheStore {
	get(key: string): Promise<string | null>
	set(key: string, value: string, ttlSeconds: number): Promise<void>
	del(...keys: string[]): Promise<void>
	incrWithExpire(key: string, ttlSeconds: number): Promise<number>
	setNxEx(key: string, value: string, ttlSeconds: number): Promise<boolean>
	releaseLock(key: string, owner: string): Promise<boolean>
	rotateRefreshToken(input: {
		oldKey: string
		usedKey: string
		newKey: string
		revokedKey: string
		sessionRtKey: string
		oldHash: string
		newHash: string
		ttlSeconds: number
		revokeTtlSeconds: number
	}): Promise<RotateResult>
	revokeSession(revokedKey: string, sessionRtKey: string, revokeTtlSeconds: number): Promise<void>
	ping(): Promise<string>
	sendRaw(command: string, args: string[]): Promise<unknown>
	close(): void
}

interface L1Entry {
	serialized: string
	expiresAt: number
}

const MAX_L1_ENTRY_BYTES = 262_144

// Bounded O(1) L1 cache storing JSON strings so callers never mutate shared cached objects.
export class L1Cache {
	private readonly map = new Map<string, L1Entry>()

	constructor(private readonly maxEntries = 4096) {}

	get<T>(key: string): T | undefined {
		const entry = this.map.get(key)
		if (!entry) return undefined
		if (entry.expiresAt <= Date.now()) {
			this.map.delete(key)
			return undefined
		}
		this.map.delete(key)
		this.map.set(key, entry)
		return JSON.parse(entry.serialized) as T
	}

	set(key: string, serialized: string, ttlMs: number): void {
		if (ttlMs <= 0 || Buffer.byteLength(serialized, 'utf8') > MAX_L1_ENTRY_BYTES) return
		if (this.map.has(key)) {
			this.map.delete(key)
		} else if (this.map.size >= this.maxEntries) {
			const oldest = this.map.keys().next().value
			if (oldest !== undefined) this.map.delete(oldest)
		}
		this.map.set(key, { serialized, expiresAt: Date.now() + ttlMs })
	}

	del(...keys: string[]): void {
		for (const k of keys) this.map.delete(k)
	}

	clear(): void {
		this.map.clear()
	}
}

interface LuaScript {
	source: string
	sha1: string
}

function defineLuaScript(source: string): LuaScript {
	return {
		source,
		sha1: new CryptoHasher('sha1').update(source).digest('hex')
	}
}

const INCR_WITH_EXPIRE_LUA = defineLuaScript(`
local c = redis.call('INCR', KEYS[1])
if c == 1 or redis.call('TTL', KEYS[1]) == -1 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
end
return c
`)

const RELEASE_LOCK_LUA = defineLuaScript(`
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`)

// Uses only explicit KEYS[] (zero dynamic key concatenation) so Redis Cluster {sid} hash slots & ACLs hold.
const ROTATE_REFRESH_LUA = defineLuaScript(`
if redis.call('GET', KEYS[4]) then
  redis.call('DEL', KEYS[1])
  redis.call('DEL', KEYS[5])
  return {'REVOKED'}
end
local used = redis.call('GET', KEYS[2])
if used then
  redis.call('SET', KEYS[4], '1', 'EX', tonumber(ARGV[3]))
  redis.call('DEL', KEYS[5])
  return {'REUSE', used}
end
local activeHash = redis.call('GET', KEYS[5])
local payload = redis.call('GET', KEYS[1])
if not payload or not activeHash or activeHash ~= ARGV[4] then
  if payload then redis.call('DEL', KEYS[1]) end
  return {'MISS'}
end
local parsed = cjson.decode(payload)
redis.call('DEL', KEYS[1])
redis.call('SET', KEYS[2], parsed.sessionId, 'EX', tonumber(ARGV[1]))
redis.call('SET', KEYS[3], payload, 'EX', tonumber(ARGV[1]))
redis.call('SET', KEYS[5], ARGV[2], 'EX', tonumber(ARGV[1]))
return {'OK', payload}
`)

const REVOKE_SESSION_LUA = defineLuaScript(`
redis.call('SET', KEYS[1], '1', 'EX', tonumber(ARGV[1]))
redis.call('DEL', KEYS[2])
return 1
`)

// Keep autoReconnect enabled while enableOfflineQueue=false rejects disconnected commands immediately into fallbacks.
const MAX_REDIS_RETRIES = 2_147_483_647

export function createRedisCacheStore(url: string): CacheStore {
	const client = new RedisClient(url, {
		connectionTimeout: 2000,
		autoReconnect: true,
		maxRetries: MAX_REDIS_RETRIES,
		enableOfflineQueue: false
	})

	let initialConnect: Promise<void> | null = client
		.connect()
		.catch(() => {})
		.finally(() => {
			initialConnect = null
		})

	async function ready(): Promise<void> {
		if (!client.connected && initialConnect) {
			await initialConnect
		}
	}

	async function evalScript(script: LuaScript, numKeys: string, args: string[]): Promise<unknown> {
		await ready()
		try {
			return await client.send('EVALSHA', [script.sha1, numKeys, ...args])
		} catch (err) {
			if (String(err).includes('NOSCRIPT')) {
				return client.send('EVAL', [script.source, numKeys, ...args])
			}
			throw err
		}
	}

	return {
		async get(key) {
			await ready()
			return client.get(key)
		},
		async set(key, value, ttlSeconds) {
			if (ttlSeconds <= 0) return
			await ready()
			await client.set(key, value, 'EX', ttlSeconds)
		},
		async del(...keys) {
			if (keys.length === 0) return
			await ready()
			await client.del(...keys)
		},
		async incrWithExpire(key, ttlSeconds) {
			if (ttlSeconds <= 0) throw new RangeError('ttlSeconds must be positive')
			const count = await evalScript(INCR_WITH_EXPIRE_LUA, '1', [key, String(ttlSeconds)])
			return Number(count)
		},
		async setNxEx(key, value, ttlSeconds) {
			if (ttlSeconds <= 0) throw new RangeError('ttlSeconds must be positive')
			await ready()
			const result = await client.send('SET', [key, value, 'NX', 'EX', String(ttlSeconds)])
			return result === 'OK'
		},
		async releaseLock(key, owner) {
			const res = await evalScript(RELEASE_LOCK_LUA, '1', [key, owner])
			return Number(res) === 1
		},
		async rotateRefreshToken(input) {
			if (input.ttlSeconds <= 0 || input.revokeTtlSeconds <= 0) {
				throw new RangeError('Refresh and revoke TTL must be positive')
			}
			const res = await evalScript(ROTATE_REFRESH_LUA, '5', [
				input.oldKey,
				input.usedKey,
				input.newKey,
				input.revokedKey,
				input.sessionRtKey,
				String(input.ttlSeconds),
				input.newHash,
				String(input.revokeTtlSeconds),
				input.oldHash
			])
			if (!Array.isArray(res)) return { status: 'miss' }
			if (res[0] === 'REVOKED') return { status: 'revoked' }
			if (res[0] === 'REUSE' && typeof res[1] === 'string') {
				return { status: 'reuse', sessionId: res[1] }
			}
			if (res[0] === 'OK' && typeof res[1] === 'string') {
				return { status: 'ok', payload: res[1] }
			}
			return { status: 'miss' }
		},
		async revokeSession(revokedKey, sessionRtKey, revokeTtlSeconds) {
			if (revokeTtlSeconds <= 0) throw new RangeError('revokeTtlSeconds must be positive')
			await evalScript(REVOKE_SESSION_LUA, '2', [revokedKey, sessionRtKey, String(revokeTtlSeconds)])
		},
		async ping() {
			await ready()
			if (!client.connected) await client.connect()
			return String(await client.send('PING', []))
		},
		async sendRaw(command, args) {
			await ready()
			return client.send(command, args)
		},
		close: () => client.close()
	}
}

const hotRegistry = globalThis as typeof globalThis & {
	__relayboxCache?: { store: CacheStore; l1: L1Cache }
}

let activeCache: { store: CacheStore; l1: L1Cache } | null = env.IS_PRODUCTION
	? null
	: (hotRegistry.__relayboxCache ?? null)

function getCacheBundle() {
	if (!activeCache) {
		activeCache = {
			store: createRedisCacheStore(env.REDIS_URL),
			l1: new L1Cache()
		}
		if (!env.IS_PRODUCTION) {
			hotRegistry.__relayboxCache = activeCache
		}
	}
	return activeCache
}

export function getCacheStore(): CacheStore {
	return getCacheBundle().store
}

export async function invalidateCache(...keys: string[]): Promise<void> {
	if (keys.length === 0) return
	const { store, l1 } = getCacheBundle()
	l1.del(...keys)
	await store.del(...keys)
}

export function closeCacheStore(): void {
	const current = activeCache
	activeCache = null
	if (!env.IS_PRODUCTION) {
		delete hotRegistry.__relayboxCache
	}
	if (!current) return
	current.l1.clear()
	current.store.close()
}

interface FlightResult<T> {
	serialized: string | null
	value: T
}

// Per-process singleflight coalesces concurrent cold misses before touching Redis L2.
const inFlight = new Map<string, Promise<FlightResult<unknown>>>()

function cloneFlightResult<T>(res: FlightResult<T>): T {
	if (res.serialized !== null) return JSON.parse(res.serialized) as T
	return res.value
}

export async function cacheGetOrSet<T>(
	key: string,
	ttlSeconds: number,
	load: () => Promise<T> | T,
	options: { store?: CacheStore; l1TtlMs?: number; cacheNull?: boolean } = {}
): Promise<T> {
	const bundle = options.store ? { store: options.store, l1: null } : getCacheBundle()
	const l1TtlMs = Math.min(options.l1TtlMs ?? 1500, ttlSeconds * 1000)
	const cacheNull = options.cacheNull ?? false

	if (ttlSeconds <= 0) return await load()

	if (bundle.l1 && l1TtlMs > 0) {
		const hot = bundle.l1.get<T>(key)
		if (hot !== undefined) return hot
	}

	const existing = !options.store ? inFlight.get(key) : undefined
	if (existing) {
		const settled = (await existing) as FlightResult<T>
		return cloneFlightResult(settled)
	}

	const execute = async (): Promise<FlightResult<T>> => {
		try {
			const cached = await bundle.store.get(key)
			if (cached !== null) {
				// Parse before populating L1 so corrupt Redis payloads cannot poison in-process L1.
				const parsed = JSON.parse(cached) as T
				if (bundle.l1 && l1TtlMs > 0) bundle.l1.set(key, cached, l1TtlMs)
				return { serialized: cached, value: parsed }
			}
		} catch {
			// Fall through to origin on corrupt cache payload or transient Redis error.
		}

		const value = await load()
		if (value !== undefined && (value !== null || cacheNull)) {
			const serialized = JSON.stringify(value)
			if (bundle.l1 && l1TtlMs > 0) bundle.l1.set(key, serialized, l1TtlMs)
			try {
				await bundle.store.set(key, serialized, ttlSeconds)
			} catch {
				// Origin read succeeded; ignore non-fatal cache write failure.
			}
			return { serialized, value }
		}
		return { serialized: null, value }
	}

	if (options.store) {
		return cloneFlightResult(await execute())
	}

	const pending = execute().finally(() => {
		inFlight.delete(key)
	})
	inFlight.set(key, pending)
	return cloneFlightResult(await pending)
}
