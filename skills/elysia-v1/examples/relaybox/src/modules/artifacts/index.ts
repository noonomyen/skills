import { Elysia, file, status, t } from 'elysia'
import { authMacro } from '../../plugins/auth.macro'
import { rateLimitMacro } from '../../plugins/rate-limit.macro'
import { ArtifactSchemas } from './model'
import { ArtifactService } from './service'

// RFC 9110 S13.1.2 If-None-Match matcher handling '*', comma-separated lists, and weak W/"..." tags.
export function matchesIfNoneMatch(header: string | undefined, currentEtag: string): boolean {
	if (!header) return false
	const trimmed = header.trim()
	if (trimmed === '*') return true

	const normalizedCurrent = currentEtag.startsWith('W/') ? currentEtag.slice(2) : currentEtag
	for (const part of trimmed.split(',')) {
		const tag = part.trim()
		const normalizedTag = tag.startsWith('W/') ? tag.slice(2) : tag
		if (normalizedTag === normalizedCurrent) return true
	}
	return false
}

// RFC 6266 / RFC 5987 Content-Disposition header with ASCII fallback and UTF-8 filename*.
function formatContentDisposition(filename: string): string {
	const asciiFallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
	const encoded = encodeURIComponent(filename).replace(
		/['()*!]/g,
		(ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
	)
	return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`
}

export const artifactsModule = new Elysia({ name: 'module:artifacts', prefix: '/artifacts' })
	.use(authMacro)
	.use(rateLimitMacro)
	.model(ArtifactSchemas)
	.prefix('model', 'artifact.')
	.post(
		'/upload',
		async ({ auth, body }) => {
			const saved = await ArtifactService.saveUpload(body.workspaceId, auth.userId, body.file)
			return status(201, saved)
		},
		{
			auth: true,
			rateLimit: { keyPrefix: 'art-upload', limit: 60, windowSec: 60 },
			body: 'artifact.UploadBody',
			response: {
				201: 'artifact.ArtifactDto',
				400: 'artifact.ErrorResponse',
				401: 'artifact.ErrorResponse',
				403: 'artifact.ErrorResponse',
				422: 'artifact.ErrorResponse',
				429: 'artifact.ErrorResponse'
			}
		}
	)
	.get(
		'/:id/download',
		async ({ auth, params: { id }, headers, set }) => {
			const { meta, resolvedPath } = await ArtifactService.getAuthorizedDownload(id, auth.userId)
			const cacheControl = 'private, max-age=3600'

			if (matchesIfNoneMatch(headers['if-none-match'], meta.etag)) {
				// RFC 9110 S15.4.5: 304 MUST be a null-body response and include cache-control + etag.
				return new Response(null, {
					status: 304,
					headers: {
						etag: meta.etag,
						'cache-control': cacheControl
					}
				})
			}

			set.headers.etag = meta.etag
			set.headers['cache-control'] = cacheControl
			set.headers['x-content-type-options'] = 'nosniff'
			set.headers['content-type'] = meta.contentType
			set.headers['content-disposition'] = formatContentDisposition(meta.filename)
			return file(resolvedPath)
		},
		{
			auth: true,
			params: t.Object({ id: t.String({ minLength: 1, maxLength: 64 }) }),
			response: {
				401: 'artifact.ErrorResponse',
				403: 'artifact.ErrorResponse',
				404: 'artifact.ErrorResponse'
			}
		}
	)
