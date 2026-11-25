import { t, type UnwrapSchema } from 'elysia'

export const ArtifactSchemas = {
	uploadBody: t.Object({
		workspaceId: t.String({ pattern: '^[a-zA-Z0-9_-]{1,64}$' }),
		file: t.File({ maxSize: '2m' })
	}),
	artifactDto: t.Object({
		id: t.String(),
		workspaceId: t.String(),
		ownerId: t.String(),
		filename: t.String(),
		contentType: t.String(),
		sizeBytes: t.Number(),
		sha256: t.String(),
		etag: t.String(),
		createdAt: t.Number()
	}),
	errorResponse: t.Object({
		error: t.String(),
		code: t.String()
	})
} as const

export type ArtifactModel = {
	[K in keyof typeof ArtifactSchemas]: UnwrapSchema<(typeof ArtifactSchemas)[K]>
}
