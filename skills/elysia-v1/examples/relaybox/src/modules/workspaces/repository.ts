import { env } from '../../env'
import { cacheGetOrSet } from '../../infra/cache'
import { getPrisma } from '../../infra/db'

export interface WorkspaceRecord {
	id: string
	name: string
	ownerId: string
	createdAt: number
}

export abstract class WorkspaceRepository {
	static async createWithOwner(input: {
		id: string
		name: string
		webhookSecret: string
		ownerId: string
	}): Promise<WorkspaceRecord> {
		const created = await getPrisma().$transaction(async (tx) => {
			const ws = await tx.workspace.create({
				data: {
					id: input.id,
					name: input.name,
					webhookSecret: input.webhookSecret,
					ownerId: input.ownerId
				},
				select: {
					id: true,
					name: true,
					ownerId: true,
					createdAt: true
				}
			})
			await tx.workspaceMember.create({
				data: {
					id: Bun.randomUUIDv7(),
					workspaceId: ws.id,
					userId: input.ownerId,
					role: 'owner'
				}
			})
			return ws
		})

		return {
			id: created.id,
			name: created.name,
			ownerId: created.ownerId,
			createdAt: created.createdAt.getTime()
		}
	}

	static async findById(id: string): Promise<WorkspaceRecord | null> {
		const row = await getPrisma().workspace.findUnique({
			where: { id },
			select: { id: true, name: true, ownerId: true, createdAt: true }
		})
		if (!row) return null
		return {
			id: row.id,
			name: row.name,
			ownerId: row.ownerId,
			createdAt: row.createdAt.getTime()
		}
	}

	static async getSecretCached(workspaceId: string): Promise<string | null> {
		return cacheGetOrSet(`ws:secret:${workspaceId}`, env.CACHE_TTL_SECONDS, async () => {
			const row = await getPrisma().workspace.findUnique({
				where: { id: workspaceId },
				select: { webhookSecret: true }
			})
			return row ? row.webhookSecret : null
		})
	}

	static async findMembershipCached(
		workspaceId: string,
		userId: string
	): Promise<{ role: string } | null> {
		return cacheGetOrSet(`ws:mem:${workspaceId}:${userId}`, env.CACHE_TTL_SECONDS, async () => {
			const row = await getPrisma().workspaceMember.findUnique({
				where: { workspaceId_userId: { workspaceId, userId } },
				select: { role: true }
			})
			return row ? { role: row.role } : null
		})
	}
}
