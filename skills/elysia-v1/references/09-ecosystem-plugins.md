# Elysia v1 Ecosystem Plugins & Runtime Integrations

## 1. Official `@elysiajs/*` Plugins (Elysia 1.4 Release Line)

Always match `@elysiajs/*` plugin versions to the Elysia `1.4.x` line (note that unscoped `@elysia/*` 2.0 betas target Elysia v2).

| Need | Official Package | Key Usage / Notes |
| --- | --- | --- |
| End-to-end RPC client | `@elysiajs/eden` | `treaty<App>(origin)` (browser uses `import type { App }` only), `treaty(app)` (in-process test/SSR). |
| OpenAPI docs + typegen | `@elysiajs/openapi` | Replaces older `@elysiajs/swagger`. Supports `fromTypes()` to infer schemas from TS return types. |
| JWT signing / verify | `@elysiajs/jwt` | Built on `jose` (recommended for RS256/EdDSA/JWKS). For zero-dep HS256 microservices on Bun, `Bun.CryptoHasher` + `timingSafeEqual` avoids extra dependencies while validating `iss`/`aud`/`nbf`/`exp`/`crit`. |
| Bearer extraction | `@elysiajs/bearer` | Extracts `Authorization: Bearer <token>` into `context.bearer` (does not verify tokens). |
| CORS | `@elysiajs/cors` | Configure explicit allowlisted `origin` + `credentials: true` in production (`origin: true` reflects any origin). |
| Static files & HMR | `@elysiajs/static` | Set `alwaysStatic: env.IS_PRODUCTION`; supports `bunFullstack: true` for Bun 1.3+ HTML/Tailwind HMR. |
| OpenTelemetry | `@elysiajs/opentelemetry` | Captures lifecycle spans; avoid `--minify` identifier mangling in `bun build --compile` when enabled. |
| Server-Timing header | `@elysiajs/server-timing` | Exposes lifecycle timings in browser DevTools (`Server-Timing` header). |
| In-process Cron | `@elysiajs/cron` | Powered by Croner (`store.cron.<name>.stop()`). Guard against duplicate execution in multi-replica deployments. |
| HTML & JSX | `@elysiajs/html` | Powered by `@kitajs/html` (string JSX); escape untrusted text with `<h1 safe>`. |
| GraphQL | `@elysiajs/apollo`, `@elysiajs/graphql-yoga` | Uses Web Standard `request` context instead of Express `req`/`res`. |
| Node.js standalone | `@elysiajs/node` | Adapter (`new Elysia({ adapter: node() })`) when running standalone on Node.js instead of Bun. |

## 2. Meta-Frameworks & Non-Bun Runtimes

Elysia exposes Web Standard `app.fetch` and `app.handle(request)` when the host owns the HTTP server:

- **Next.js / Astro / SvelteKit / Expo / TanStack Start:** Mount Elysia with matching `prefix: '/api'` and export `GET = app.fetch` (or `({ request }) => app.handle(request)`). Keep server runtime imports out of client bundles (`import type { App }` only for `treaty<App>(origin)`).
- **Deno / Cloudflare Workers / Vercel:** Use `Deno.serve(app.fetch)` or `export default { fetch: (req: Request) => app.handle(req) }`. On Workers (`elysia/adapter/cloudflare-worker`), avoid `file()` / filesystem static plugins and read runtime bindings inside handlers.
