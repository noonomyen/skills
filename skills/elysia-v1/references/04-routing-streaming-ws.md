# Routing, Zero-Copy Files, SSE Streaming & WebSockets

## 1. Zero-Copy `file()` & RFC 9110 / RFC 6266 Download Hardening

- **Verify disk presence before `file()`:** In Elysia/Bun, returning `file(missingPath)` when the underlying file does not exist returns `200` with an `ENOENT` error string leaking the host filesystem path. Check `await Bun.file(realPath).exists()` (after `realpath` containment) and throw `NotFoundDomainError` (`404`) if missing.
- **Symlink & path traversal containment:** Validate `workspaceId` (`^[a-zA-Z0-9_-]{1,64}$`), bound filename length (`<= 120`), store a **relative** storage path in PostgreSQL, and verify `realpath()` starts with `realpath(ARTIFACT_DIR) + sep` on **both** upload and download.
- **Tenant authorization:** Authenticate **and** verify workspace membership (`WorkspaceService.assertMember`) on both `/upload` and `/:id/download`.
- **RFC 9110 `If-None-Match` & `304`:** Support `*`, comma-separated ETags, and weak `W/"..."` comparison (`matchesIfNoneMatch`). Return a null-body `new Response(null, { status: 304, headers: { etag, 'cache-control' } })` - never `return ''` with `set.status = 304`.
- **RFC 6266 / 5987 `Content-Disposition` & XSS defense:** Emit ASCII fallback `filename="..."` plus `filename*=UTF-8''...`, allowlist safe inline/download MIMEs (`SAFE_ARTIFACT_MIMES` falling back to `application/octet-stream`), and set `x-content-type-options: nosniff`.

```ts
const { meta, resolvedPath } = await ArtifactService.getAuthorizedDownload(id, auth.userId)
const cacheControl = 'private, max-age=3600'

if (matchesIfNoneMatch(headers['if-none-match'], meta.etag)) {
  return new Response(null, { status: 304, headers: { etag: meta.etag, 'cache-control': cacheControl } })
}

set.headers.etag = meta.etag
set.headers['cache-control'] = cacheControl
set.headers['x-content-type-options'] = 'nosniff'
set.headers['content-type'] = meta.contentType
set.headers['content-disposition'] = formatContentDisposition(meta.filename)
return file(resolvedPath)
```

## 2. Server-Sent Events (SSE) with Real Backpressure & `Last-Event-ID`

Prefer `new ReadableStream({ start, cancel }, new CountQueuingStrategy({ highWaterMark }))` over `async function*` or manual synchronous counters:

1. **Real backpressure (`controller.desiredSize`):** Tracking an `inFlight` counter around synchronous `controller.enqueue(...)` resets immediately and never drops unread chunks. Use `CountQueuingStrategy({ highWaterMark: MAX_SSE_QUEUE })` and drop slow-consumer events when `(controller.desiredSize ?? 0) <= 0`.
2. **Subscribe before `Last-Event-ID` replay:** Subscribe to `eventBus` before querying missed rows, buffer live events during `replayAfter`, and deduplicate by `id` once replay completes so no event emitted mid-query is lost or duplicated. Emit unified DTO shapes (`WebhookRecord`) for both live and replayed frames, and send a `REPLAY_TRUNCATED` warning if capped.
3. **Deterministic cleanup (`cancel` + `try/catch`):** Hoist `closed = false` outside `start()`, wrap `replayAfter` in `try/catch` (`closeCleanly()` on error), and run `cleanup()` (`clearInterval`, `removeEventListener`, `unsubscribe`) inside `cancel()`.
4. **SSE frame injection defense:** Validate `event` schemas (`^[^\r\n]{1,128}$`) and strip `\r`/`\n` inside `formatSseFrame`.
5. **Stream lifetime tied to session validity:** Set an expiry timer for `auth.exp` plus periodic Redis revocation checks so logged-out or expired clients cannot stream indefinitely.

## 3. WebSockets (Bun Native Pub/Sub)

Elysia v1.4 delegates `.ws(path, options)` to Bun's WebSocket handler (`adapter/bun/index.ts`):

- **Resource bounds (`websocket` config):** Configure `maxPayloadLength`, `idleTimeout`, and `backpressureLimit` on the `Elysia` instance (and `maxLength` on message schema fields like `body.message`).
- **Upgrade authorization gotcha:** Elysia runs `options.beforeHandle` inside `.ws()` without inspecting its return value (`adapter/bun/index.ts`), so `return status(403, ...)` inside `options.beforeHandle` still upgrades the socket. Either perform checks inside a macro `resolve` (which runs in `compose.ts` before the handler) OR `throw` a domain error inside `options.beforeHandle`. Enforce `isTrustedOrigin` on cookie-authenticated upgrades.
- **Error formatting (`options.error`):** When WebSocket `ValidationError` falls through to global `onError` returning `status(422, ...)`, `createHandleWSResponse` serializes `{ code: 422, response: ... }`. Define an `.ws(..., { error({ error }) { return { error, code } } })` hook to return clean JSON objects to WS clients.
- **Session expiry, membership & horizontal scaling:** Re-check `auth.exp`, `auth:{<sid>}:revoked`, and `WorkspaceService.assertMember` on `message` (failing closed on auth store outages) with per-connection message rate limiting, and bridge `ws.publish` + `eventBus` via Redis Pub/Sub when running multiple replicas.

## 4. Mounting External Fetch Handlers

Use `.mount('/trpc', fetchHandler)` for non-Elysia Web-Standard `(req: Request) => Response` handlers (Hono, Better Auth, tRPC). Use `.use()` for Elysia instances to preserve static types and hooks.
