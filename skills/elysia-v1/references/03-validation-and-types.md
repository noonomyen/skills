# Validation, TypeBox & Type Inference (v1.4)

## 1. Single Source of Truth (`t` from `'elysia'`)

Elysia v1 bundles `@sinclair/typebox` (`< 1`). Never duplicate TypeScript interfaces separately from runtime schemas.

```ts
import { t, type UnwrapSchema } from 'elysia'

export const WebhookSchemas = {
  ingestBody: t.Object({
    event: t.String({ pattern: '^[^\\r\\n]{1,128}$' }),
    data: t.Record(t.String(), t.Unknown())
  }),
  ingestResponse: t.Object({ id: t.String(), accepted: t.Boolean() }),
  errorResponse: t.Object({ error: t.String(), code: t.String() })
} as const

export type WebhookModel = {
  [K in keyof typeof WebhookSchemas]: UnwrapSchema<(typeof WebhookSchemas)[K]>
}
// Single schema shortcut: type Body = typeof WebhookSchemas.ingestBody.static
```

> Always pass `as const` on schema maps so `UnwrapSchema` preserves literal and union types.

## 2. Normalization, String Coercion & `t.Transform`

- By default, `normalize: true` (`'exactMirror'`) strips unknown extra fields on incoming/outgoing objects using a precompiled cleaner, preventing mass-assignment bugs (such as passing `role: 'admin'` on `/register`).
- Use `t.Numeric()` / `t.Integer()` / `t.BooleanString()` / `t.Date()` / `t.ArrayQuery()` for typed query and param coercion (`?limit=20` -> `number`).
- Use `t.Transform` (v1 API; `t.Codec` is v2) to decode custom formats:

```ts
listQuery: t.Object({
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, default: 20 })),
  events: t.Optional(
    t.Transform(t.String())
      .Decode((v) => v.split(',').map((s) => s.trim()).filter(Boolean))
      .Encode((v) => v.join(','))
  )
})
```

## 3. Reference Models (`.model()` + `.prefix()`)

Register schemas on a module to reference them by string name, speed up TypeScript checking, and emit named OpenAPI components:

```ts
export const authModule = new Elysia({ name: 'module:auth', prefix: '/auth' })
  .model(AuthSchemas)
  .prefix('model', 'auth.')
  .post('/register', handler, {
    body: 'auth.RegisterBody', // Trailing '.' capitalizes first char: registerBody -> auth.RegisterBody
    response: {
      201: 'auth.AuthSuccess',
      409: 'auth.ErrorResponse'
    }
  })
```

## 4. File Uploads (`t.File` / `t.Files`) & Input Bounds

```ts
uploadBody: t.Object({
  workspaceId: t.String({ pattern: '^[a-zA-Z0-9_-]{1,64}$' }),
  file: t.File({ maxSize: '2m' })
})
```

- **Pre-validation RAM limit:** `t.File({ maxSize: '2m' })` checks size *after* multipart `formData()` parses into memory. Always configure `serve: { maxRequestBodySize }` on the Elysia instance (e.g. `3 * 1024 * 1024`) so oversized uploads are rejected at the HTTP layer before buffering.
- Always bound `:id` params, `email` (`maxLength: 254`), `refreshToken` (`maxLength: 256`), and custom headers (`user-agent`, `x-webhook-source`) so attackers cannot bloat DB columns or Redis keys.
- Note: Passing `type` in `t.File({ type: 'image' })` lazy-loads `file-type` for magic-byte inspection; ensure `file-type` is installed if `type` is specified, or omit `type` and sanitize `uploaded.type` + `nosniff` explicitly.

## 5. Cookies & `noUncheckedIndexedAccess`

Bun's default `tsconfig.json` enables `noUncheckedIndexedAccess: true`. Elysia's `cookie` object is a runtime Proxy, while TypeScript types undeclared keys as `Cookie<unknown> | undefined`:

```ts
cookie.access_token?.set({
  value: token,
  httpOnly: true,
  secure: env.IS_PRODUCTION,
  sameSite: 'lax',
  path: '/'
})
```

For optional JSON bodies (such as cookie-only `POST /auth/refresh` or `/logout`), wrap the body schema in `t.Optional(t.Object(...))`; otherwise an empty POST fails with `422`.

## 6. Standard Schema & Boot Config (`src/env.ts`)

- Elysia 1.4 accepts Zod, Valibot, and ArkType schemas natively via Standard Schema (`~standard`), though built-in TypeBox `t` remains fastest due to `exactMirror` and AOT compilation.
- Validate environment variables at boot with `getSchemaValidator(EnvSchema, { coerce: true, normalize: 'exactMirror', additionalProperties: true })`, narrowing `envValidator.Decode(raw) as Static<typeof EnvSchema>` after `.Check(raw)`. Require `NODE_ENV`, `ARTIFACT_DIR`, `ALLOWED_HOSTS`, DB/Redis URLs, and >= 32-byte secrets explicitly in production (no dev fallbacks).
