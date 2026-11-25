# Elysia v1.4 API & Built-In Functions Reference

Complete map of Elysia `1.4.x` APIs, instance methods, lifecycle helpers, and TypeBox extensions verified against `elysia@1.4.32` so any agent immediately knows what Elysia provides natively.

## 1. Instance Constructor (`new Elysia(config)`)

| Option | Purpose | Production Notes |
| --- | --- | --- |
| `name`, `seed` | Plugin deduplication key | Always set `name` on shared plugins; add `seed` if factory accepts config. |
| `prefix` | URL prefix for all routes on this instance | Mount modules cleanly (e.g. `prefix: '/auth'`). |
| `precompile` | Pre-compile JIT route handlers at boot | Set `true` in production (`env.IS_PRODUCTION`) to avoid first-request compilation latency. |
| `aot` | Enables ahead-of-time handler compilation (default `true`) | Keep `true` for Sucrose inference and TypeBox JIT validation. |
| `normalize` | Controls schema field stripping (`true` / `'exactMirror'` / `false`) | Default `'exactMirror'` strips unknown input/output properties quickly. |
| `nativeStaticResponse` | Promotes non-function static routes to native Bun static responses | Only applies when route value is a literal (not `() => 'ok'`) and no `onRequest`/`trace`/`wrap` hooks exist. |
| `serve` | Passes Bun `Serve` options (`maxRequestBodySize`, `idleTimeout`, `tls`) | Always cap `maxRequestBodySize` to limit pre-validation buffering RAM. |
| `websocket` | Configures Bun WebSocket limits (`maxPayloadLength`, `idleTimeout`, `backpressureLimit`) | Essential against WS amplification / memory DoS. |
| `cookie` | Instance defaults for cookies (`secrets`, `sign`, `httpOnly`, `sameSite`, `secure`, `path`) | Enable `secrets` + `sign` if tamper-proof plain cookies are needed (prefer JWT for auth). |
| `strictPath` | Enforce exact trailing slashes (default `false`) | Set `true` when strict REST URL matching is required. |

## 2. Routing, Adapters & Execution Methods

- **HTTP Route Builders:** `.get()`, `.post()`, `.put()`, `.patch()`, `.delete()`, `.options()`, `.head()`, `.all()`, `.route(method, path, handler, hook)` - Signature `(path, handler, hook?)` in v1.4.
- **WebSockets (`.ws(path, options)`):** Native Bun pub/sub (`ws.subscribe`, `ws.publish`, `ws.send`, `ws.close`). Supports TypeBox validation (`params`, `query`, `headers`, `body`, `response`), `open`, `message`, `close`, `drain`, `ping`, `pong`, `parse`, and `error`.
- **Composition & Isolation:**
  - `.use(plugin)` - Registers an Elysia instance or async import promise, inheriting `'scoped'`/`'global'` hooks and models.
  - `.group(prefix, cb)` / `.group(prefix, hook, cb)` - Shares a URL prefix (and optional guard schema/hooks) across grouped routes.
  - `.guard(hook, cb)` - Applies schemas and lifecycle hooks strictly to routes registered inside the callback.
  - `.as('local' | 'scoped' | 'global')` - Promotes hooks/types of the current plugin instance upward (`'plugin'` does not exist in v1.4).
  - `.mount(prefix?, fetchHandler)` - Embeds any Web Standard `(req: Request) => Response` app (Hono, Better Auth, tRPC).
- **Runtime Control & Execution:**
  - `.listen(portOrServeOptions, callback?)` - Starts Bun HTTP/WS server; `.stop(closeActiveConnections?)` stops listener (calls `onStop` without `await`).
  - `.compile()` / `app.routes` - Compiles handlers ahead of serving and inspects registered route definitions.
  - `.fetch(request)` / `.handle(request)` - Web Standard request handler for zero-socket unit tests, Edge runtimes, and meta-frameworks.
  - `await app.modules` - Waits for async dynamic `.use(import(...))` plugins to resolve.

## 3. Lifecycle Hooks (Execution Order)

| Method | Purpose | Critical Behavior |
| --- | --- | --- |
| `.onRequest(fn)` | Pre-routing request interception (Host allowlist, request ID) | Always global across the app; returned values run through `mapEarlyResponse`. |
| `.onParse(fn)` / `.parser(name, fn)` | Custom body parsing, stream byte caps, raw-body HMAC | Runs before TypeBox validation; throws wrap in `ParseError(error)`. Named `.parser()` skips default parsers cleanly. |
| `.onTransform(fn)` | Pre-validation normalization before TypeBox runs | Can short-circuit with `status()`; do not trust unvalidated inputs here for auth. |
| `.onBeforeHandle(fn)` | Post-validation gatekeeper (RBAC, rate-limit, idempotency lock) | Returning a value or `status(...)` short-circuits the route handler (still runs `onAfterHandle` and `onAfterResponse`). |
| `.onAfterHandle(fn)` | Post-handler response mutation or cleanup | Runs even if `onBeforeHandle` returned early; sees `ElysiaCustomStatusResponse` before response validation unwraps it. |
| `.mapResponse(fn)` | Final `Response` construction (compression, custom headers) | Runs after response validation; avoid globally on root to preserve `mapCompactResponse` fast path. |
| `.onAfterResponse(fn)` | Post-flush side effects (metrics, batched audit logs, lock cleanup) | Runs in `setImmediate` after response flush **and** after error responses; never `await` slow DB calls directly. |
| `.error(name, Class)` / `.onError(fn)` | Centralized error boundary | First `onError` returning a value ends the chain (`ElysiaCustomStatusResponse` has `.code`, `.response`). |
| `.onStart(fn)` / `.onStop(fn)` | Lifecycle callbacks bound to `listen()` / `stop()` | Invoked synchronously without `await` by BunAdapter; run blocking init/teardown explicitly around `listen()`/`stop()`. |
| `.on(event, fn)` | Generic hook registration helper (`{ as }`, event name, handler) | Useful when wrapping lifecycle hooks dynamically. |
| `.trace(fn)` | Per-stage timing instrumentation (`ELYSIA_TRACE`) | Disables static-route promotion while active; use in diagnostics/telemetry. |
| `.wrap(fn)` | Higher-order wrapper around the compiled top-level router | Runs around `map()` handler; disables static-route promotion. |

## 4. State, DI, Schemas & Configuration

- `.state(key | obj, value?)` - Registers shared mutable `store` state on `Context.store`.
- `.decorate(key | obj, value?)` - Attaches immutable helpers/services to `Context` (zero per-request Sucrose cost if lazy).
- `.derive(fn)` / `.mapDerive(fn)` - Computes per-request properties before validation (cannot rely on validated params/body; prefer `.resolve` for auth).
- `.resolve(fn)` / `.mapResolve(fn)` - Computes typed per-request properties after validation in `beforeHandle` (can return `status(...)` on rejection).
- `.model(name | map)` - Registers reusable named TypeBox models (accessible by string key `'auth.LoginBody'` + OpenAPI components).
- `.prefix('model' | 'decorator' | 'state' | 'error', str)` / `.suffix(...)` - Namespaces models/injections when composing modules.
- `.macro(name | map, def?)` - Creates declarative route options (`{ auth: true, rateLimit: { ... } }`) injecting schema + hooks + `resolve` types.
- `.headers(Record)` / `.env(t.Object(...))` - Declares default static response headers and validates typed `env`.

## 5. Standalone Utilities & Error Classes (`import { ... } from 'elysia'`)

| Export | What It Is & When to Use |
| --- | --- |
| `status(code, body)` | Returns typed `ElysiaCustomStatusResponse(code, body)`. Preserves HTTP status union types for Eden & OpenAPI (`return status(201, dto)` skips `onError`; `throw status(...)` enters `onError`). |
| `redirect(url, status?)` | Returns an HTTP redirect `Response` (default `302`; pass `301`/`307`/`308` as needed). |
| `file(path)` (`ElysiaFile`) | Zero-copy file streaming wrapper backed by `Bun.file(path)` with automatic content-type/range handling. Verify existence first or handle missing file explicitly. |
| `sse(payload \| AsyncGenerator)` | Helper for formatting Server-Sent Events (`event`, `data`, `id`, `retry`). For slow-consumer memory safety (`CountQueuingStrategy`), prefer explicit `ReadableStream`. |
| `form(data)` | Constructs `FormData` response payloads (paired with `t.Form`). |
| `env` (`elysia`) | Universal runtime env map (`Bun.env` / `process.env`). |
| `getSchemaValidator(schema, opts)` | Compiles a reusable standalone TypeBox/Standard Schema validator (great for fail-fast `src/env.ts` boot config checks). |
| `Cookie` / `serializeCookie` (`'elysia'`), `signCookie` / `unsignCookie` (`'elysia/utils'`) | Cookie proxy class and low-level HMAC-SHA256 cookie signing/parsing primitives (`signCookie`/`unsignCookie` are exported from `'elysia/utils'`, not top-level `'elysia'`). |
| `validationDetail(msg)` | Formats custom validation error strings that satisfy TypeBox error detail formatting cleanly. |
| `fileType` | Magic-byte MIME verifier helper used when `t.File({ type: ... })` checks binary signatures. |
| `StatusMap` / `InvertedStatusMap` | Bidirectional map between HTTP reason strings (`'Unauthorized'`, `'Too Many Requests'`) and numeric status codes (`401`, `429`). |
| `ValidationError`, `ParseError`, `NotFoundError`, `InvalidFileType`, `InternalServerError`, `InvalidCookieSignature` | Built-in Elysia error classes dispatched to `onError` (`context.code` matches `'VALIDATION'`, `'PARSE'`, `'NOT_FOUND'`, `'INVALID_FILE_TYPE'`, `'INTERNAL_SERVER_ERROR'`, `'INVALID_COOKIE_SIGNATURE'`). |

## 6. Elysia Extended TypeBox Builders (`import { t } from 'elysia'`)

In addition to standard TypeBox (`t.Object`, `t.String`, `t.Number`, `t.Union`, `t.Literal`, `t.Optional`, `t.Record`, `t.Array`, `t.Transform`), Elysia extends `t` for HTTP serialization gaps:

| Builder | What It Does | Typical Use |
| --- | --- | --- |
| `t.Numeric(opts?)` | Accepts numeric strings or numbers and coerces/validates to `number` | Query pagination (`?limit=20`), numeric `:id` path params, env vars |
| `t.Integer(opts?)` | Same as `t.Numeric` restricted to integers | Integer page/offset params |
| `t.NumericEnum(enum, opts?)` | Parses numeric strings into TypeScript numeric enum members | Numeric status filter params |
| `t.BooleanString(opts?)` | Converts `'true'`/`'false'` strings or booleans to `boolean` | Boolean query flags (`?active=true`) |
| `t.Date(opts?)` | Parses ISO strings / epoch numbers into `Date` objects | Query/body date ranges |
| `t.ObjectString(props)` | Parses stringified JSON objects in query/multipart fields into objects | FormData JSON fields |
| `t.ArrayString(item?)` | Parses JSON array strings (`'["a","b"]'`) into typed arrays | Query/multipart JSON arrays |
| `t.ArrayQuery(item?)` | Parses comma-separated or repeated query params (`?tag=a,b`) into arrays | Tag filters |
| `t.File(opts?)` / `t.Files(opts?)` | Validates uploaded `File` / `File[]` size (`maxSize`) and MIME (`type`) | Multipart uploads |
| `t.Form(props)` | Schema wrapper matching `FormData` responses | Multipart response typing |
| `t.Cookie(props, opts?)` | Types & configures cookie signing/attributes directly on a route or macro | Typed session cookies |
| `t.Nullable(schema)` / `t.MaybeEmpty(schema)` | Shorthand for `schema \| null` and `schema \| null \| undefined` | Nullable DTO fields |
| `t.UnionEnum(['a', 'b'])` | Faster literal enum validation + OpenAPI enum emission without `Enum` object overhead | Status / role string unions |
| `t.NoValidate(schema)` | Preserves OpenAPI/TS typing on response while skipping runtime check for speed | Hot large-array responses |
| `t.ArrayBuffer()` / `t.Uint8Array()` | Validates raw binary payloads | Binary webhook / upload routes |
