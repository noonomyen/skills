import { t, type UnwrapSchema } from 'elysia'

export const WorkspaceSchemas = {
	createBody: t.Object({
		id: t.Optional(t.String({ pattern: '^[a-zA-Z0-9_-]{1,64}$' })),
		name: t.String({ minLength: 1, maxLength: 100 })
	}),
	workspaceCreatedDto: t.Object({
		id: t.String(),
		name: t.String(),
		ownerId: t.String(),
		webhookSecret: t.String(),
		createdAt: t.Number()
	}),
	workspaceDto: t.Object({
		id: t.String(),
		name: t.String(),
		ownerId: t.String(),
		createdAt: t.Number()
	}),
	errorResponse: t.Object({
		error: t.String(),
		code: t.String()
	})
} as const

export type WorkspaceModel = {
	[K in keyof typeof WorkspaceSchemas]: UnwrapSchema<(typeof WorkspaceSchemas)[K]>
}
