import { t, type UnwrapSchema } from 'elysia'

export const WebhookSchemas = {
	ingestBody: t.Object({
		event: t.String({ pattern: '^[^\\r\\n]{1,128}$' }),
		data: t.Record(t.String(), t.Unknown())
	}),
	listQuery: t.Object({
		limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, default: 20 })),
		events: t.Optional(
			t.Transform(t.String())
				.Decode((v) =>
					v
						.split(',')
						.map((s) => s.trim())
						.filter(Boolean)
				)
				.Encode((v) => v.join(','))
		)
	}),
	webhookDto: t.Object({
		id: t.String(),
		workspaceId: t.String(),
		source: t.String(),
		eventType: t.String(),
		payload: t.Unknown(),
		deliveryStatus: t.String(),
		createdAt: t.Number()
	}),
	ingestResponse: t.Object({
		id: t.String(),
		accepted: t.Boolean()
	}),
	errorResponse: t.Object({
		error: t.String(),
		code: t.String()
	})
} as const

export type WebhookModel = {
	[K in keyof typeof WebhookSchemas]: UnwrapSchema<(typeof WebhookSchemas)[K]>
}
