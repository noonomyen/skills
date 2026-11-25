import { Prisma } from '../../generated/prisma/client'
import {
	ConflictDomainError,
	ForbiddenDomainError,
	NotFoundDomainError
} from '../../plugins/errors'
import type { WorkspaceModel } from './model'
import { WorkspaceRepository, type WorkspaceRecord } from './repository'

function generateWebhookSecret(): string {
	const bytes = new Uint8Array(32)
	crypto.getRandomValues(bytes)
	return Buffer.from(bytes).toString('hex')
}

export abstract class WorkspaceService {
	static async create(
		ownerId: string,
		input: WorkspaceModel['createBody']
	): Promise<WorkspaceRecord & { webhookSecret: string }> {
		const id = input.id ?? `ws-${Bun.randomUUIDv7()}`
		const name = input.name.trim()
		const webhookSecret = generateWebhookSecret()

		try {
			const ws = await WorkspaceRepository.createWithOwner({
				id,
				name,
				webhookSecret,
				ownerId
			})
			return { ...ws, webhookSecret }
		} catch (err) {
			if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
				throw new ConflictDomainError('Workspace already exists', 'WORKSPACE_EXISTS')
			}
			throw err
		}
	}

	static async getForMember(workspaceId: string, userId: string): Promise<WorkspaceRecord> {
		await WorkspaceService.assertMember(workspaceId, userId)
		const ws = await WorkspaceRepository.findById(workspaceId)
		if (!ws) {
			throw new NotFoundDomainError('Workspace not found', 'WORKSPACE_NOT_FOUND')
		}
		return ws
	}

	static async assertMember(workspaceId: string, userId: string): Promise<void> {
		const member = await WorkspaceRepository.findMembershipCached(workspaceId, userId)
		if (!member) {
			throw new ForbiddenDomainError('Not a member of this workspace', 'FORBIDDEN_WORKSPACE')
		}
	}

	static getIngestSecret(workspaceId: string): Promise<string | null> {
		return WorkspaceRepository.getSecretCached(workspaceId)
	}
}
