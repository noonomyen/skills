# Architecture: Modular Monolith, Microservices & Prisma ORM

## 1. Unidirectional Repo Layout (`examples/relaybox/`)

Organize feature modules (`src/modules/<domain>/`) as self-contained Elysia instances so they mount identically into a **Monolith** (`src/apps/monolith.ts`) or standalone **Microservices** (`src/apps/ingest-service.ts`, `src/apps/core-service.ts`):

```text
src/
├── env.ts                  # TypeBox env validation (fail-fast on boot)
├── generated/prisma/       # Prisma 7 generated client (never hand-edit; gitignored)
├── infra/                  # Pure clients & lifecycle (db, cache, jwt, audit-buffer, event-bus, lifecycle)
├── plugins/                # Shared Elysia plugins & macros (errors, security, audit, auth, rate-limit, idempotency)
├── modules/                # Bounded contexts (1 folder = 1 domain: auth, workspaces, webhooks, artifacts)
│   └── <domain>/
│       ├── model.ts        # TypeBox schemas (as const) + UnwrapSchema types
│       ├── repository.ts   # Prisma queries (camelCase DTOs) + cacheGetOrSet
│       ├── service.ts      # abstract class + static methods (plain values, zero Elysia Context)
│       └── index.ts        # Elysia controller (prefix, .model().prefix(), macros, inline handlers -> Service)
├── apps/                   # Composition factories (export type App = ReturnType<typeof createMonolithApp>)
│   ├── monolith.ts
│   ├── ingest-service.ts
│   └── core-service.ts
└── main.ts                 # CLI entrypoint (parseArgs, --routes, --cluster, --service=..., await startInfra, shutdown)
```

## 2. Architectural Boundaries & Production Probes

- **Unidirectional flow (`module -> service -> repository`):** Controllers destructure plain arguments cleanly into `Service`; never import Elysia `Context` into services and never skip `Service` to query `Repository` from HTTP handlers.
- **Tenant isolation & horizontal state:** Enforce `WorkspaceService.assertMember` inside service methods (`webhooks`, `artifacts`, `workspaces`). Note that local-disk artifacts and in-memory `eventBus`/`ws.publish` require shared object storage (S3/R2) and Redis Pub/Sub before scaling horizontally across multiple replicas.
- **Lazy app factories (`.apps/*.ts`):** Avoid constructing top-level `const app = createMonolithApp()` at import time; use factory functions + `export type App = ReturnType<typeof createMonolithApp>` so `import type { App }` (Eden) and `--routes` work cleanly without hidden allocations.
- **`/healthz` vs `/readyz` & hook order:** Register `errorPlugin` and `securityPlugin` **before** `/healthz` and `/readyz` so `precompile: true` preserves security headers. Keep `/healthz` dependency-free (`() => 'ok'`) and check PostgreSQL + Redis connectivity in `/readyz` (`503` when degraded).
- **Split-service parity:** Mount `errorPlugin`, `securityPlugin`, `createAuditPlugin`, `onStop`, `/healthz`, and `/readyz` consistently across `monolith`, `ingest-service`, and `core-service`.

## 3. Prisma 7 + `@prisma/adapter-pg` on Bun

Prisma 7 runs with `prisma-client` generator and driver adapters (`@prisma/adapter-pg` + `pg.Pool`):

1. **`prisma.config.ts`:** Read `process.env.DATABASE_URL` and fail explicitly if unset when `NODE_ENV === 'production'` (never fall back silently to dev URLs in production). Run CLI commands cleanly with `bunx --bun prisma`.
2. **`prisma/schema.prisma`:**

   ```prisma
   generator client {
     provider = "prisma-client"
     output   = "../src/generated/prisma"
   }
   datasource db {
     provider = "postgresql"
   }
   ```

3. **Explicit projections, indexes & `BigInt`:** Split `USER_PUBLIC_SELECT` from `USER_AUTH_SELECT` (never load `passwordHash` outside authentication), explicitly set `Session.expiresAt` (no `@default(now())`), index foreign keys & high-volume scopes (`@@index([userId])`, `@@index([workspaceId])`, `@@index([createdAt])`), and convert `BigInt` timestamps (`Number(row.createdAt)`) before JSON serialization.
4. **Transactions & uniqueness:** Use `getPrisma().$transaction(async (tx) => ...)` for coupled writes (`createWithOwner`) and catch `Prisma.PrismaClientKnownRequestError` (`code === 'P2002'`) -> `409 ConflictDomainError`. Clean up orphan rows if post-DB Redis session provisioning fails (`register()`).
5. **Bulk inserts:** Use `auditBuffer`'s `$executeRaw` + PostgreSQL `UNNEST(...)` for batched writes.

*(If using Drizzle ORM instead of Prisma, use `drizzle-typebox`, assign `createInsertSchema(...)` to an intermediate variable before `t.Omit(...)` to avoid TS infinite instantiation errors, and align `@sinclair/typebox` versions.)*
