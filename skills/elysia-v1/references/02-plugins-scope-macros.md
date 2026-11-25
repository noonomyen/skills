# Plugins, Scope, Composable Macros & Express Migration

## 1. Encapsulation & Scope Levels (v1.4)

Hooks and schemas are **isolated (`local`) by default**.

| Scope | Reaches | Syntax |
| --- | --- | --- |
| `'local'` (default) | Current instance + descendants (`.use(child)`) | `.onBeforeHandle(fn)` |
| `'scoped'` | Parent + current + descendants | `.onBeforeHandle({ as: 'scoped' }, fn)` or `.as('scoped')` |
| `'global'` | All instances across the app | `.onBeforeHandle({ as: 'global' }, fn)` or `.as('global')` |

> Never use `'plugin'` scope in v1.4 (that is Elysia v2 only).

## 2. Explicit Dependencies & Deduplication

Each feature module (`authModule`, `workspacesModule`, `webhooksModule`, `artifactsModule`) must `.use()` the plugins it depends on (`authMacro`, `rateLimitMacro`, `securityPlugin`) so it has full static types and runs standalone as a microservice.

Always provide `name` (and `seed` if accepting config) so Elysia executes plugin setup once:

```ts
export const authMacro = new Elysia({ name: 'macro:auth' })
export const createAuditPlugin = (enableAudit: boolean) =>
  enableAudit ? new Elysia({ name: 'plugin:audit', seed: true }) : new Elysia({ name: 'plugin:audit', seed: false })
```

**Global vs Explicit rule of thumb:**

- **Global on root/group before routes:** Plugins adding no context types (`errorPlugin`, `@elysiajs/cors`, `@elysiajs/opentelemetry`) or global `onRequest` security guards (`securityPlugin`).
- **Explicit `.use()` inside modules:** Plugins contributing context types, macros, or models (`authMacro`, `rateLimitMacro`, `idempotencyMacro`, shared `.model()`).

## 3. Composable Macros (TypeScript 5-7 Safe Pattern)

Macros replace stacked Express middlewares with declarative, typed route options.

**Chaining dependent macros in Elysia 1.4:**

- Define the base macro using the **1-arg object form** `.macro({ auth: { ... } })` so routes receive the exact inferred `resolve` return type (`{ auth: { userId, role, sessionId, exp } }`).
- Chain dependent macros in a **separate `.macro(name, def)` call** (2-arg form) so the dependent macro's `resolve` sees `{ auth }` on its context:

```ts
export const authMacro = new Elysia({ name: 'macro:auth' })
  .macro({
    auth: {
      cookie: t.Cookie({ access_token: t.Optional(t.String()) }),
      async resolve({ request, cookie: { access_token }, headers, set }) {
        // verify CSRF for cookie auth, JWT signature/claims, Redis revocation
        return { auth: { userId, role, sessionId, exp } }
      }
    }
  })
  .macro('adminOnly', {
    auth: true,
    resolve({ auth }) {
      if (auth.role !== 'admin') return status(403, { error: 'Forbidden', code: 'FORBIDDEN' })
    }
  })
```

**Execution order caveats with macros:**

1. **`beforeHandle` vs inline hooks (`applyMacro`):** Elysia appends macro `beforeHandle` hooks **after** any inline route `beforeHandle`. Keep inline `beforeHandle` absent when relying on macro key declaration order (e.g. `rateLimit` before `idempotent`).
2. **`parse` runs before `beforeHandle` macros:** Any route with a JSON `body` schema runs `parse` and TypeBox `422` validation before `beforeHandle` macros run. For public signed webhook endpoints (`POST /ingest/:workspaceId`), enforce rate limiting, bounded streaming body reads, and HMAC + replay verification inside `parse` before `JSON.parse`, while letting `idempotent` handle replay after TypeBox validation.
3. **`error` hooks vs `afterResponse`:** If a global `errorPlugin` intercepts thrown errors first, macro `error` hooks are skipped (`compose.ts`). Release macro locks in both `afterHandle` and `afterResponse`.

## 4. `guard` and `group`

- Use `.group('/api', (api) => api.use(authModule).use(webhooksModule))` to share a URL prefix.
- Use `.guard({ ...hooksAndSchemas }, (app) => app.get(...))` to apply schemas/hooks to multiple routes without affecting sibling routes outside the guard.
- In v1.4, guard schemas merge with route schemas automatically.

## 5. Shifting from Express.js Mindset

| Express Pattern | Elysia 1.4 Equivalent | Why |
| --- | --- | --- |
| `(req, res, next)` middleware | Lifecycle hooks + `macro` | No `next()` callback chain; Sucrose compiles only used stages. |
| `req.user = user` (untyped mutation) | `resolve()` returning `{ auth: ... }` | Strictly typed end-to-end down to handlers and Eden. |
| `res.status(201).json(data)` | `return status(201, data)` or plain `return data` | Preserves inferred response union types for OpenAPI & Eden. |
| Global `app.use(mw)` side effects | Explicit `.use(plugin)` per module + `name` | Enables zero-refactor Modular Monolith -> Microservice split. |
| `supertest(app)` (binds TCP port) | `app.handle(new Request(...))` | Tests full lifecycle in-memory without socket churn. |
