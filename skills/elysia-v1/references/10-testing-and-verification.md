# Testing & Docker Compose Verification

## 1. Zero-Socket & Lifecycle Testing with `app.handle()`

Test routing, `parse`, TypeBox validation, macros, and `onError` in-memory with Web Standard `Request` objects instead of opening TCP sockets:

```ts
const res = await app.handle(
  new Request(`http://localhost/api/webhooks/ingest/${workspaceId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-webhook-timestamp': ts,
      'x-webhook-signature': sig
    },
    body: payload
  })
)
expect(res.status).toBe(202)
```

**Essential testing practices in Elysia 1.4:**

- **WebSocket tests:** Bind an ephemeral loopback listener (`app.listen({ port: 0, hostname: '127.0.0.1' })`) and stop **only the HTTP listener** (`await server.server?.stop(true)`) inside `finally` - calling `app.stop()` mid-suite runs `onStop` and closes shared DB/Redis pools for remaining tests.
- **Cover `precompile: true`:** Construct at least one integration suite app with `{ precompile: true }` so hook registration order mistakes (like registering routes before `securityPlugin`) fail immediately in tests rather than only in production.
- **Await dynamic modules:** When registering lazy async plugins (`.use(import('./plugin'))`), run `await app.modules` before invoking `app.handle()`.

## 2. Docker Compose Integration (PostgreSQL + Redis)

Run integration suites against real PostgreSQL and Redis bound to `127.0.0.1` (`compose.test.yml`) so transaction semantics, SQL array types, and Lua scripts are verified end-to-end:

1. Start services: `docker compose -f compose.test.yml up -d --wait`
2. Sync schema: `bunx --bun prisma generate && bunx --bun prisma db push`
3. Verify baseline infrastructure (`00-compatibility.test.ts`):
   - PostgreSQL connectivity (`SELECT 1`), `$transaction` rollback + FK cascade delete, `UNNEST` batch insert, and poison-batch shedding (`AuditBatchBuffer`).
   - Redis connectivity, Lua `EVALSHA` (`incrWithExpire`, `setNxEx`, `releaseLock`), and `cacheGetOrSet` singleflight object isolation.
4. **Always clean up Postgres AND Redis in `finally`:** Delete test database rows, clean Redis keys (`wh:sig:*`, `rl:*`, `idem:*`), and remove temporary artifact directories.

## 3. Core Regression Scenarios to Always Test (`tests/01..04`)

- **Tenant membership (`403`):** Non-members must fail on cross-tenant webhook reads, workspace lists, SSE streams, WebSocket upgrades, artifact uploads, and artifact downloads.
- **Cookie CSRF (`403`) & session lifecycle:** Cross-site cookie requests must be rejected; concurrent refresh reuse revokes the session; `/logout` revokes via `refreshToken` even when the short-lived access JWT has expired.
- **Pre-parse rejection & error boundaries:** Unsigned invalid JSON returns `401` rather than leaking schema `422` errors; chunked bodies exceeding limits reject with `413`; thrown `status(...)` calls preserve exact HTTP codes; handler exceptions release idempotency locks via `afterResponse`.
- **Files, compression, SSE & WS:** Missing artifact files return `404` rather than throwing unhandled paths; `304` returns a null body with `Cache-Control` and `ETag`; `Accept-Encoding: gzip;q=0` stays uncompressed while emitting `Vary: Accept-Encoding`; SSE backpressure drops excess unread chunks via `CountQueuingStrategy`; invalid WebSocket messages return structured JSON error frames.
