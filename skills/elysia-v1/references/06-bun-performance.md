# Bun Native Performance & Production Tuning

## 1. Prefer Bun Native APIs in Hot Paths

| Need | Prefer (Bun Native) | Avoid |
| --- | --- | --- |
| Password hashing | `Bun.password.hash(..., { algorithm: 'argon2id' })` | JS `bcryptjs` |
| HMAC / SHA-256 / BLAKE2b | `new Bun.CryptoHasher('sha256', secret)` | Pure-JS hashers |
| Time-sortable IDs | `Bun.randomUUIDv7()` | External `uuid` packages |
| File serving / writes | `file(path)` (`Bun.file`) / `Bun.write()` | `fs.readFileSync` |
| Response gzip | `Bun.gzipSync()` (only for UTF-8 >= 1 KB) | Compressing small JSON |
| Redis / Valkey | `new Bun.RedisClient(url, { enableOfflineQueue: false })` | Unbounded offline queues |
| Sub-ms timing | `Bun.nanoseconds()` | `Date.now()` for durations |

## 2. Non-Blocking `onAfterResponse` + PostgreSQL `UNNEST` Batching

Never `await` an audit `INSERT` on the request path, and avoid Prisma `createMany` parameter bloat during bursts.

**Pattern (`src/infra/audit-buffer.ts`):**

1. Skip hook registration completely when disabled: return an empty `new Elysia({ name: 'plugin:audit', seed: false })` so disabled routes incur zero `onRequest`/`setImmediate` overhead.
2. When enabled, push mutation events synchronously into a bounded array (`maxBuffer = 4096`), incrementing a `droppedCount` metric when saturated instead of O(N) `Array.shift()`.
3. Guard microtask triggers with `flushScheduled` and drain in a single PostgreSQL `UNNEST` query (8 array parameters total regardless of batch size).
4. Accumulate `consecutiveFailures` across flushes up to `maxBatchRetries` (e.g. 3). On PostgreSQL data/constraint errors (SQLSTATE `22xxx`/`23xxx`, such as `22021` invalid byte sequence), binary-split the batch (`O(K log N)`) to rescue clean rows while dropping only the poison row; on DB connectivity outages, keep events buffered (bounded by `maxBuffer`) instead of launching an O(N) rescue storm or dropping clean events.

## 3. Clean Lifecycle Accessors & Pool Resilience

Avoid `new Proxy({}, ...)` wrappers around `PrismaClient` or eager app construction at module import time:

- **Lazy factories in `apps/*.ts`:** Export `createMonolithApp()`, `createCoreService()`, and `export type App = ReturnType<typeof createMonolithApp>` instead of calling `createMonolithApp()` on import (`CLI --routes` and imports only construct what they run).
- **Explicit accessors (`getPrisma()`, `getCacheStore()`):** Store active handles in module scope and mirror to `globalThis.__relayboxPrisma` / `__relayboxCache` only when `!env.IS_PRODUCTION` for `bun --hot` reload safety.
- **Pool `'error'` listener:** Attach `pool.on('error', ...)` on `pg.Pool` so idle backend disconnects never crash the event loop with an uncaught EventEmitter error.
- **Clean teardown:** Null out references and delete dev `globalThis` keys inside `closeDatabase()` / `closeCacheStore()`.

## 4. Compression Rules (`mapResponse` & RFC 9110 `Accept-Encoding`)

Scope `mapResponse` compression only to large-payload routes (never globally on root `app`):

- Support `gzip` and `x-gzip` case-insensitively (`acceptsGzipEncoding`) and reject invalid q-values outside `[0, 1]`.
- Always preserve existing `set.headers`, set `Cache-Control: private, no-store` on authenticated API reads, and always emit `Vary: Accept-Encoding` even when the response stays uncompressed (`gzip;q=0` or `< 1 KB`).
- Skip `Response`, `ElysiaFile`, `ElysiaCustomStatusResponse`, `ReadableStream`, `Blob`, `ArrayBuffer`, and typed arrays.
- When encoded UTF-8 payload is `< 1024` bytes, return `new Response(rawBytes, ...)` directly instead of letting Elysia serialize JSON a second time. Note RFC 9110 S8.8.3.3: if serving compressed representations alongside strong ETags, use content-coding-specific ETags or weak ETags.

## 5. Multi-Core Cluster & Standalone Binary Builds

- **Linux Multi-Core (`src/main.ts`):** Use `node:util` `parseArgs`, bind configurable `hostname` (`env.HOST`), configure `serve: { maxRequestBodySize, idleTimeout }` + `websocket` limits, fork `os.availableParallelism()` workers with `node:cluster`, set `reusePort: process.platform === 'linux'`, propagate `SIGINT`/`SIGTERM`, and exit non-zero on worker crashes or forced timeouts.
- **Precompile:** Pass `precompile: env.IS_PRODUCTION` to `new Elysia(...)` so handler JIT compilation completes before serving.
- **Compiled Binary:** Reduce production memory footprint cleanly:

```bash
bun build --compile --minify-whitespace --minify-syntax --target bun-linux-x64 --outfile server src/main.ts
```

> Use `--target=bun-linux-x64-baseline` when deploying to CPUs without AVX2 support, and avoid full `--minify` identifier mangling if OpenTelemetry relies on function span names.
