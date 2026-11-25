# Lifecycle Internals & Sucrose JIT Optimization

## 1. Exact Request Pipeline & `compose.ts` Realities

Elysia compiles each route into a tailored JS function (`compose.ts`). Understanding the exact generated code prevents subtle security and performance bugs:

| Stage | Context Type | Can Short-Circuit? | Critical v1.4 Gotcha |
| --- | --- | --- | --- |
| `onRequest` | `PreContext` | Return value / `Response` / `status()` | Always global. Converts returned values via `mapEarlyResponse`. Presence denies Bun `staticRoutes` promotion. |
| `onParse` / `parse` | `Context` | Named `.parser()` / `throw` | Runs **before** TypeBox validation and `beforeHandle` macros. Thrown errors become `ParseError(error)`. |
| `onTransform` / `derive` | `Context` | Return `status()` (`ElysiaCustomStatusResponse`) | Runs before TypeBox validation; never trust unvalidated inputs here for auth. |
| Validation | TypeBox / Standard | Fails with `422` (`ValidationError`) | Runs after `transform` and before `beforeHandle`. Validate public auth/HMAC/limits in `parse` if unauthenticated `422` oracle is unacceptable. |
| `onBeforeHandle` / `resolve` | `Context` | Return value / `status()` | Post-validation gatekeeper (auth, membership check, rate limit, idempotency). Exception: `.ws()` ignores return value of `options.beforeHandle` (must `throw` or use macro `resolve`). |
| Route Handler | `Context` | Returns payload / `status()` | Keep inline; destructure only used keys. |
| `onAfterHandle` | `+ responseValue` | Return new payload | Still executes if a `beforeHandle` returned early. Sees `ElysiaCustomStatusResponse` before response validation unwraps it. |
| `mapResponse` | `+ responseValue` | Return `Response` | Must skip `Response`, `ElysiaFile`, `ReadableStream`, `Blob`, `ArrayBuffer`, typed arrays, and `ElysiaCustomStatusResponse`. |
| `onAfterResponse` | `Context` | No | Scheduled via `setImmediate` after response flush **and** after error responses (`compose.ts`). Never `await` DB calls directly; use for batched audit push or lock cleanup. |
| `onStart` / `onStop` | `app` | No | `adapter/bun/index.ts` loops over hooks **without `await`**. `await startInfra()` before `listen()`, and await idempotent `shutdownInfra()` in signal handlers. |

## 2. How Sucrose Static Analysis & `precompile` Work

Elysia inspects handler and hook bodies via Sucrose to build `inference` flags (`headers`, `query`, `body`, `cookie`, `set`, `server`):

- **Fast path (`mapCompactResponse`):** If a route has `inference.set === false`, Elysia skips building headers/`set` objects.
- **Registration order bug with `precompile: true`:** When `precompile: true` is passed to `new Elysia({ precompile: true })` (as in production), each route compiles immediately at registration time using the current `this.inference` flags. Always register `.use(errorPlugin)` and `.use(securityPlugin)` **before** `.get('/healthz', ...)` so `inference.set` is already `true`; otherwise `/healthz` compiles into `mapCompactResponse` in production and silently drops all `securityPlugin` headers!
- **`nativeStaticResponse` conditions:** In `index.ts` and `adapter/bun/index.ts`, BunAdapter promotes a route to `Bun.serve({ routes })` only when the handler is a **non-function literal value** (`.get('/healthz', 'ok')`) AND `app.event.request`, `app.event.trace`, and `app.extender.higherOrderFunctions` are all empty. Whenever global security headers via `onRequest` are enabled, native promotion is bypassed cleanly while bare routes like `/healthz` still avoid body/query/audit work.

## 3. Root Tainting Trap

Registering `.derive({ as: 'global' })`, `.mapResponse()`, or an active `.onAfterResponse()` on the root `app` sets `app.inference` flags (`headers`, `set`, `server`, `path`) that propagate to **every** route:

```ts
// Bad: Taints /healthz and fast GET routes with header JSONification + audit overhead, and omits security headers on precompile
new Elysia({ precompile: true })
  .get('/healthz', () => 'ok')
  .derive({ as: 'global' }, ({ request, server }) => ({ ip: resolveIp(request, server) }))
  .mapResponse(compressLargeJson)
  .onAfterResponse(auditMutation)

// Good: Register errorPlugin & securityPlugin before routes; keep root free of derive/mapResponse/audit hooks
new Elysia({ precompile: true })
  .use(errorPlugin)
  .use(securityPlugin) // decorates lazy getClientIp(), sets security headers onRequest
  .get('/healthz', () => 'ok')
  .group('/api', (api) =>
    api
      .use(createAuditPlugin(enableAudit)) // returns empty Elysia when enableAudit=false
      .use(webhooksModule)                 // scopes mapResponse compression to large GET routes
  )
```

Isolating `/healthz` from `derive`/`mapResponse`/`audit`, scoping compression to large payloads, and batching mutation audits asynchronously keeps Sucrose fast paths clean on hot routes.
