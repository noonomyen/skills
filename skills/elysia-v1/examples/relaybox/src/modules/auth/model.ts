import { t, type UnwrapSchema } from 'elysia'

export const AuthSchemas = {
	registerBody: t.Object({
		email: t.String({ format: 'email', maxLength: 254 }),
		password: t.String({ minLength: 8, maxLength: 128 })
	}),
	loginBody: t.Object({
		email: t.String({ format: 'email', maxLength: 254 }),
		password: t.String({ minLength: 8, maxLength: 128 })
	}),
	refreshBody: t.Optional(
		t.Object({
			refreshToken: t.Optional(t.String({ minLength: 16, maxLength: 256 }))
		})
	),
	logoutBody: t.Optional(
		t.Object({
			refreshToken: t.Optional(t.String({ minLength: 16, maxLength: 256 }))
		})
	),
	authSuccess: t.Object({
		user: t.Object({
			id: t.String(),
			email: t.String(),
			role: t.String()
		}),
		tokenType: t.Literal('Bearer'),
		expiresIn: t.Number(),
		accessToken: t.String(),
		refreshToken: t.String()
	}),
	meResponse: t.Object({
		userId: t.String(),
		role: t.String(),
		sessionId: t.String(),
		exp: t.Number()
	}),
	errorResponse: t.Object({
		error: t.String(),
		code: t.String()
	})
} as const

export type AuthModel = {
	[K in keyof typeof AuthSchemas]: UnwrapSchema<(typeof AuthSchemas)[K]>
}
