# Caching, Rate Limiting, Idempotency & Graceful Shutdown

## 1. `Bun.RedisClient` Production Configuration

Bun's default `RedisClient` uses `enableOfflineQueue: true` and `maxRetries: 20`. Under traffic during a Redis outage, `enableOfflineQueue: true` queues every command in memory indefinitely instead of rejecting into `try/catch` fallbacks. Configure:

```ts
const MAX_REDIS_RETRIES = 2_147_483_647
const client = new RedisClient(url, {
  connectionTimeout: 2000,
  autoReconnect: true,
  maxRetries: MAX_REDIS_RETRIES,
  enableOfflineQueue: false
})
```

Trigger an explicit `initialConnect` once (or `await client.connect()` in `ping()` during `startInfra()`), keep `idleTimeout: 0`, and reject subsequent disconnected commands immediately into `503` (revocation), local fallback (auth rate-limit), or origin DB fallback.

## 2. L1 Bounded LRU + L2 Redis + Singleflight (`inFlight`)

**Pattern (`src/infra/cache.ts`):**

1. **L1 In-Process LRU (`Map` insertion-order):** Store serialized JSON strings, enforce `MAX_L1_ENTRY_BYTES` (256 KB), clamp `l1TtlMs` to `Math.min(l1TtlMs, ttlSeconds * 1000)`, and parse on `get()` so callers cannot mutate shared objects.
2. **Singleflight BEFORE Redis `GET`:** Check `inFlight.get(key)` before calling `store.get(key)`, returning freshly cloned/parsed results per waiter (`cloneFlightResult`) so concurrent callers do not share mutable references.
3. **Graceful Degradation & Negative Caching:** Guard `null` caching behind `cacheNull = false` so newly invited workspace members are not blocked by cached `false`/`null` misses. Never chain a failure-prone Redis `invalidateCache` synchronously after `insert()` of brand-new UUID records (risking orphan DB rows).
4. **Consistency Caveats:** L1 caches are per-process and an in-flight load can race a concurrent write/invalidation; keep L1 TTLs short and document multi-replica staleness.

## 3. Atomic Redis Operations (`EVALSHA` Lua Scripts)

Compute SHA-1 digests once per script and execute via `EVALSHA` with automatic `NOSCRIPT` fallback to `EVAL`:

- **Rate Limiter (`plugins/rate-limit.macro.ts`):**

  ```lua
  local c = redis.call('INCR', KEYS[1])
  if c == 1 or redis.call('TTL', KEYS[1]) == -1 then
    redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
  end
  return c
  ```

  Validate `windowSec > 0 && limit > 0`, use exact remaining `resetSec`, emit `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`, and `retry-after` on `429`. Note fixed-window 2x boundary bursts and use an in-memory fallback (`fallbackOnRedisError: 'memory'`) on sensitive auth routes.

- **IETF `Idempotency-Key` Lock (`plugins/idempotency.macro.ts`):**
  1. Scope keys by identity/actor + method + pathname + query + `Idempotency-Key`, and fingerprint with canonical key-sorted JSON serialization + headers.
  2. Set `Retry-After: 1` on `409` in-flight collision and `422` on payload mismatch.
  3. Replay ONLY allowlisted headers (`content-type`, `location`, `etag`) so callers keep their own `x-request-id` and `x-ratelimit-*` headers.
  4. Treat `store.set` after side-effect completion as best-effort (`try/catch`), and release the owned lock in **both** `afterHandle` and `afterResponse` via atomic Lua (`if GET == owner then DEL end`) so thrown errors never leak locks for 30 seconds.

- **Refresh Token & Revocation (`rotateRefreshToken`, `revokeSession`):** Validate `ttlSeconds > 0` and rotate/revoke atomically in Lua. Note that multi-key Lua scripts in Redis Cluster require hash-tagged keys (`{sid}`) sharing one hash slot.

## 4. Deterministic Boot & Graceful Shutdown (`main.ts` & `lifecycle.ts`)

Elysia `onStart` / `onStop` hooks run without `await` inside `adapter/bun/index.ts`:

- **Fail-fast boot:** Call `await startInfra(enableAudit)` **before** `instance.listen(...)` in `src/main.ts` so DB/Redis startup failures exit immediately rather than accepting traffic with unhandled rejections.
- **Single-flight teardown:** Wrap `startInfra()` and `shutdownInfra()` in deduplicated promise guards so overlapping `onStop` and `SIGINT`/`SIGTERM` triggers never close pools twice concurrently, force-stop lingering SSE/WS sockets after a bounded timeout, flush `auditBuffer`, close Redis, disconnect Prisma/`pg.Pool`, and preserve failure exit codes.
