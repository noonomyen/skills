# Error Handling & Production Security Patterns

## 1. `return status()` vs `throw` vs `onError`

- **`return status(404, body)`:** Normal early response; skips `onError`.
- **`throw status(...)` or `throw new AppError(...)`:** Enters `onError`.
- Register `errorPlugin` **before** `/healthz` and all modules (`.onError({ as: 'global' }, ...)`).

Inside global `onError` (`src/plugins/errors.ts`), check:

1. `code === 'APP_ERROR' || error instanceof AppError` -> redact non-exposed errors in production, apply custom headers (`www-authenticate`, `retry-after`).
2. `error instanceof ElysiaCustomStatusResponse` -> inspect `error.code` (HTTP numeric status) and `error.response` so thrown `status(...)` calls keep their HTTP status instead of flattening to `500` (and redact `>= 500` in prod).
3. `code === 'VALIDATION' || error instanceof ValidationError` -> handle `422` consistently (including WS validation where `context.code` is unset).
4. `code === 'PARSE'` -> unwrap both `error.cause instanceof AppError` and `error.cause instanceof ElysiaCustomStatusResponse` so rejections from `parse()` preserve exact `401`/`413`/`429`/`400` semantics.
5. `'INVALID_FILE_TYPE'`, `'INVALID_COOKIE_SIGNATURE'`, `'NOT_FOUND'`, numeric `error.status` (`4xx`), and redacted `500 INTERNAL_ERROR`.

## 2. Tenant Authorization & CSRF Protection

Authentication (`auth: true`) verifies identity only; pair it with explicit resource ownership and origin checks:

- **Workspace Membership:** Model `Workspace` + `WorkspaceMember(workspaceId, userId)` in Prisma and call `WorkspaceService.assertMember(workspaceId, auth.userId)` in every service method (`webhooks` read/list/SSE/WS, `artifacts` upload/download, `workspaces` get).
- **CSRF on Cookie & WebSocket Auth:** When a mutating request (`POST`/`PUT`/`PATCH`/`DELETE`), cookie `/refresh` / `/logout`, or WS upgrade authenticates via cookie without an explicit `Authorization: Bearer ...` header, reject `Sec-Fetch-Site: cross-site` and verify `Origin` matches `Host` / `ALLOWED_HOSTS` (`isTrustedOrigin`, returning `403 FORBIDDEN_ORIGIN`).

## 3. Standard Auth: Access JWT + Atomic Opaque Refresh Rotation

1. **Short-lived Access JWT (HS256):** Enforce >= 32-byte key (RFC 7518 S3.2), `token.length <= 8192`, canonical base64url round-trip, JOSE `alg === 'HS256'` + reject `header.crit` (RFC 7515 S4.1.11), verify `iss`, `aud`, `nbf`/`iat` (with bounded clock skew tolerance), `exp` (capped to remaining session TTL on refresh), and non-empty `sub`/`sid`/`jti`. Check `auth:{<sid>}:revoked` in Redis (failing `503` when Redis is disconnected with `enableOfflineQueue: false`).
2. **Case-insensitive Bearer + `WWW-Authenticate`:** Match `/^Bearer\s+(\S+)$/i` and emit `WWW-Authenticate: Bearer realm="relaybox"` on `401`.
3. **Separate Opaque Refresh Token (`<sid>.<32B base64url>`, `blake2b256` hashed):** Pre-check `auth:{<sid>}:rt:<hash>` / `auth:{<sid>}:used:<hash>` in Redis before touching Postgres (preventing unauthenticated `<sid>.garbage` session-state/disabled-account oracles), validate DB session/user status before mutation, then rotate atomically via one Redis Cluster-safe Lua script (`EVALSHA` with `NOSCRIPT` fallback, explicit `KEYS[]` only) over `{<sid>}` hash-tagged keys (`auth:{<sid>}:revoked`, `auth:{<sid>}:used:<hash>`, `auth:{<sid>}:rt:<hash>`, `auth:{<sid>}:session_rt`) with `revokeTtlSeconds = ACCESS_TTL_SEC` so reuse always covers previously minted access JWTs. Note: concurrent double-refresh in parallel tabs revokes the whole session (document UX trade-off cleanly).
4. **Logout Parity & Expired Access Token Support:** Clear `refresh_token` with matching `path: '/api/auth'` (`clearCookieWithParity`), execute atomic Redis session revocation (`REVOKE_SESSION_LUA`), and allow `/api/auth/logout` to revoke by `refreshToken` (body or cookie) even if the 15m access JWT has expired.
5. **Login & Account Protection:** Run dummy `Bun.password.verify` on unknown email lookups to equalize timing, rate-limit login by **both** IP and hashed email (`auth-login-acct`), normalize emails (`trim().toLowerCase()`), reject public admin role overrides (`normalize: 'exactMirror'`), split `USER_PUBLIC_SELECT` from `USER_AUTH_SELECT` (never expose `passwordHash` outside login), set `Cache-Control: no-store` + `Pragma: no-cache` on token responses, and map Prisma `P2002` to `409`.

## 4. Pre-Parse Streaming Webhook HMAC (Eliminates Schema Oracles & RAM DoS)

In Elysia, `parse()` runs **before** TypeBox validation and `beforeHandle` macros. For public signed endpoints (`POST /webhooks/ingest/:workspaceId`):

1. Check rate limit first (`checkRateLimit`) inside `parse()`.
2. Stream-read `request.body?.getReader()` with a strict incremental `256 KB` cap (`413` on both oversized `Content-Length` and chunked overflow without buffering unbounded RAM).
3. Fetch per-workspace `webhookSecret` (`WorkspaceService.getIngestSecret`), validate strict integer timestamp (`^\d{1,12}$` within `+-300s`), verify HMAC-SHA256 bound to `${method}\n${path}\n${workspaceId}\n${ts}.` + `rawBytes`, and atomically claim `wh:sig:${workspaceId}:${ts}:${sigHex}` in Redis (`401` on invalid/cross-workspace/replayed signatures, allowing matching completed `Idempotency-Key` replays cleanly).
4. Only **after** auth succeeds, run fatal UTF-8 decoding and `JSON.parse` so unsigned attackers never receive `422` schema oracle responses or consume `JSON.parse` CPU.

## 5. Network, Headers & Production Config Hardening

- **Fail-fast config (`src/env.ts`):** Require explicit `NODE_ENV`, `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `ARTIFACT_DIR` (non-hardcoded OS `tmpdir()` default in dev), and `ALLOWED_HOSTS` in production.
- **Security headers everywhere (`onRequest`):** Apply `x-content-type-options: nosniff`, `referrer-policy: no-referrer`, `content-security-policy: default-src 'none'; frame-ancestors 'none'`, `strict-transport-security` (prod), and sanitized `x-request-id` even on `400`/`403` Host rejections.
- **Proxy IP validation:** Normalize `[...]` brackets, lowercase before stripping `::ffff:`, strip `%zone`, validate with `node:net` `isIP()`, support CIDR ranges via `BlockList`, and walk `X-Forwarded-For` right-to-left without falling back to `X-Real-IP` when `X-Forwarded-For` is present.
