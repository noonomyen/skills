import { env } from '../../env'
import type { Prisma } from '../../generated/prisma/client'
import { cacheGetOrSet } from '../../infra/cache'
import { getPrisma } from '../../infra/db'

export interface WebhookRecord {
	id: string
	workspaceId: string
	source: string
	eventType: string
	payload: unknown
	deliveryStatus: string
	createdAt: number
}

function toRecord(row: {
	id: string
	workspaceId: string
	source: string
	eventType: string
	payloadJson: Prisma.JsonValue
	deliveryStatus: string
	createdAt: bigint
}): WebhookRecord {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		source: row.source,
		eventType: row.eventType,
		payload: row.payloadJson,
		deliveryStatus: row.deliveryStatus,
		createdAt: Number(row.createdAt)
	}
}

export abstract class WebhookRepository {
	static async insert(record: {
		id: string
		workspaceId: string
		source: string
		eventType: string
		payload: unknown
		deliveryStatus: string
		createdAt: number
	}): Promise<void> {
		await getPrisma().webhook.create({
			data: {
				id: record.id,
				workspaceId: record.workspaceId,
				source: record.source,
				eventType: record.eventType,
				payloadJson: record.payload as Prisma.InputJsonValue,
				deliveryStatus: record.deliveryStatus,
				createdAt: BigInt(record.createdAt)
			}
		})
	}

	static async findByIdCached(id: string): Promise<WebhookRecord | null> {
		return cacheGetOrSet(`wh:item:${id}`, env.CACHE_TTL_SECONDS, async () => {
			const row = await getPrisma().webhook.findUnique({ where: { id } })
			return row ? toRecord(row) : null
		})
	}

	static async listByWorkspace(
		workspaceId: string,
		limit: number,
		events?: string[]
	): Promise<WebhookRecord[]> {
		const rows = await getPrisma().webhook.findMany({
			where: {
				workspaceId,
				...(events && events.length > 0 ? { eventType: { in: events } } : {})
			},
			orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
			take: limit
		})
		return rows.map(toRecord)
	}

	static async listAfterId(
		workspaceId: string,
		lastEventId: string,
		limit = 200
	): Promise<{ items: WebhookRecord[]; hasMore: boolean }> {
		const anchor = await getPrisma().webhook.findUnique({
			where: { id: lastEventId },
			select: { createdAt: true, workspaceId: true }
		})
		if (!anchor || anchor.workspaceId !== workspaceId) {
			return { items: [], hasMore: false }
		}

		const rows = await getPrisma().webhook.findMany({
			where: {
				workspaceId,
				OR: [
					{ createdAt: { gt: anchor.createdAt } },
					{ createdAt: anchor.createdAt, id: { gt: lastEventId } }
				]
			},
			orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
			take: limit + 1
		})
		const hasMore = rows.length > limit
		const items = (hasMore ? rows.slice(0, limit) : rows).map(toRecord)
		return { items, hasMore }
	}
}
