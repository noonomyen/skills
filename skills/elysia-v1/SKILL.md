---
name: elysia-v1
description: >-
  Build, optimize, test, and architect production Elysia v1 (1.4.x) TypeScript backends on Bun with
  Prisma/SQL, Redis caching, standard JWT/refresh auth, WebSockets, and SSE.
  Use for Elysia v1 projects, Bun API servers, modular monoliths, or microservices.
---

# Elysia v1.4 + Bun Production Skill

Elysia v1 is a **Bun-first, TypeScript-inference-driven, JIT-compiled** framework (`compose.ts` + `Sucrose`). Each Elysia instance is an encapsulated mini-app, not an Express middleware chain.

**Target baseline:** `elysia@1.4.32` (v1), `Bun >= 1.3`, `@sinclair/typebox < 1`. Do **not** apply Elysia v2 signatures (`.get(path, opts, handler)`, `'plugin'` scope, `typebox` 1.x).

## Non-Negotiable Rules (Do / Don't)

1. **Always chain methods & use inline handlers.** Every Elysia method returns a new type. Never break the chain (`const app = new Elysia(); app.state(...)`) and never type `ctx: Context` in a separate controller class; destructure in an inline handler and pass plain values to `static` service methods.
2. **Use v1.4 signatures.** Routes are `.get(path, handler, options)`. Hook scope is `{ as: 'local' | 'scoped' | 'global' }` (default `'local'`). Access schemas via `typeof Schema.static` or `UnwrapSchema<typeof Schema>`. In `afterHandle`/`mapResponse`, prefer `responseValue` (`response` is deprecated).
3. **Register plugins before routes.** Hooks (`onBeforeHandle`, `errorPlugin`, `securityPlugin`) only affect routes and `.use()` plugins registered **after** them. Even `/healthz` must come **after** `errorPlugin` and `securityPlugin` so `precompile: true` compiles it with `inference.set = true` instead of dropping security headers.
4. **Declare explicit dependencies & name plugins.** Any module using macros/decorators/models must `.use()` its provider plugin so it runs standalone as a microservice. Give every shared plugin a unique `name` (and `seed` if parameterized) for deduplication.
5. **Respect `compose.ts` and `adapter/bun` lifecycle realities:**
   - `onRequest`: Always global pre-route. Converts returned values via `mapEarlyResponse` (including `status(...)` or `new Response(...)`). Note: adding any `onRequest`, `trace`, or `wrap` hook denies Bun static-route promotion (`staticRoutes`).
   - `parse()` / `onParse`: Runs **before** TypeBox validation and `beforeHandle` macros. Thrown errors are wrapped in `ParseError` (`error.cause`); handle both `AppError` and `ElysiaCustomStatusResponse` inside `onError`. Stream-cap bodies and verify public webhook auth/rate-limits in `parse` before `JSON.parse` to prevent chunked RAM DoS and unauthenticated `422` validation oracles.
   - `transform` (`derive`): Runs before validation and short-circuits if returning `status(...)` (`ElysiaCustomStatusResponse`). Reserve `beforeHandle` (`resolve`) for post-validation checks.
   - `afterHandle` vs `afterResponse`: `afterHandle` still executes when `beforeHandle` returns early and sees `ElysiaCustomStatusResponse` before unwrap. Global `onError` short-circuits subsequent route/macro `error` hooks; use `afterResponse` (which runs even on error short-circuits) for lock cleanup.
   - `.ws()` upgrades: `options.beforeHandle` inside `.ws()` does **not** check its return value; enforce auth via macro `resolve` or **throw** inside `options.beforeHandle`, and supply `options.error` to format WebSocket errors cleanly instead of raw `{ code, response }` wrappers.
   - `onStart` / `onStop`: BunAdapter invokes these without `await`. `await startInfra()` before `app.listen()` in `main.ts`, and await idempotent `shutdownInfra()` on `SIGINT`/`SIGTERM` (stopping only `server.server?.stop(true)` in ephemeral WS tests).
6. **Protect Sucrose JIT fast paths.** Avoid global `.derive()`, `.mapResponse()`, or enabled `.onAfterResponse()` on the root app because they taint `app.inference` for every child route. Scope compression (`mapResponse`) to specific routes and return empty `new Elysia(...)` when optional audit plugins are disabled.
7. **Error boundary & tenant authorization:** `return status(code, body)` skips `onError`; `throw status(...)` or `throw new AppError(...)` enters `onError`. Check `error instanceof ElysiaCustomStatusResponse` (reading `.code` / `.response`), `error instanceof ValidationError`, and `ParseError.cause`. Always pair `auth: true` with explicit tenant/workspace membership checks (`WorkspaceService.assertMember`) in every service method and close SSE/WS streams on token expiry or revocation.
8. **Unidirectional architecture:** `apps -> modules (HTTP) -> services (domain) -> repositories (ORM + cache) -> infra`. Keep `.listen()` and eager construction out of `apps/*.ts` (`export type App = ReturnType<typeof createMonolithApp>`), never let routes call repositories directly, and never import `Context` in services.

## Lifecycle Execution Order

```text
Request -> onRequest (pre-routing; always global; returns via mapEarlyResponse)
        -> onParse / parse() (body parsing before validation; throws become ParseError)
        -> onTransform / derive() (pre-validation; short-circuits on status())
        -> TypeBox Validation (headers, params, query, cookie, body; 422 on fail)
        -> onBeforeHandle / resolve() / macros (auth, membership, rateLimit, idempotent)
        -> Route Handler (inline, minimal destructuring)
        -> onAfterHandle (sees ElysiaCustomStatusResponse before unwrap)
        -> Response Validation (unwraps status(), sets set.status)
        -> mapResponse (or mapCompactResponse if headers/set untouched)
        -> onAfterResponse (runs after flush AND after error responses; audit/lock cleanup)
   [any throw] -> onError (first returning handler wins and stops error chain)
```

## Task Index & Capability Guide

| Goal / Problem | Read | Verified Example (`examples/relaybox/`) |
| --- | --- | --- |
| Complete Elysia v1.4 API, functions & TypeBox helper catalog | [00-elysia-api-reference](references/00-elysia-api-reference.md) | `src/apps/*.ts`, `src/modules/*/model.ts` |
| Lifecycle internals, Sucrose JIT, `precompile`, static routes | [01-lifecycle-and-sucrose](references/01-lifecycle-and-sucrose.md) | `src/apps/*.ts`, `src/modules/webhooks/index.ts` |
| Plugins, `local`/`scoped`/`global`, composable macros, Express shift | [02-plugins-scope-macros](references/02-plugins-scope-macros.md) | `src/plugins/auth.macro.ts`, `src/plugins/rate-limit.macro.ts` |
| TypeBox schemas, `t.*` extensions, `t.Transform`, `.model()` | [03-validation-and-types](references/03-validation-and-types.md) | `src/modules/*/model.ts`, `src/env.ts` |
| Streaming SSE (`CountQueuingStrategy`), `file()`/`ETag`, WebSockets | [04-routing-streaming-ws](references/04-routing-streaming-ws.md) | `src/modules/webhooks/index.ts`, `src/modules/artifacts/index.ts` |
| Errors, tenant authz, CSRF, JWT+refresh rotation, pre-parse HMAC, headers | [05-errors-and-security](references/05-errors-and-security.md) | `src/plugins/errors.ts`, `src/modules/auth/*`, `src/plugins/security.ts` |
| Bun native APIs, `UNNEST` audit buffer, pooling, `cluster`, compile | [06-bun-performance](references/06-bun-performance.md) | `src/infra/audit-buffer.ts`, `src/infra/db.ts`, `src/main.ts` |
| `enableOfflineQueue: false`, L1+L2 singleflight, `EVALSHA`, shutdown | [07-cache-and-resilience](references/07-cache-and-resilience.md) | `src/infra/cache.ts`, `src/plugins/idempotency.macro.ts`, `src/infra/lifecycle.ts` |
| Modular Monolith <-> Microservice split, Prisma 7, Eden | [08-architecture-and-orm](references/08-architecture-and-orm.md) | `src/apps/*.ts`, `prisma/schema.prisma`, `src/modules/workspaces/*` |
| Official `@elysiajs/*` plugins & runtime adapters | [09-ecosystem-plugins](references/09-ecosystem-plugins.md) | Official `@elysiajs/*` v1.4 ecosystem |
| `app.handle()`, Docker Compose Postgres+Redis tests, SSE/WS verification | [10-testing-and-verification](references/10-testing-and-verification.md) | `compose.test.yml`, `tests/*.test.ts` |
