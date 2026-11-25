import { env } from '../../env'
import { cacheGetOrSet } from '../../infra/cache'
import { getPrisma } from '../../infra/db'

export interface ArtifactRecord {
	id: string
	workspaceId: string
	ownerId: string
	filename: string
	contentType: string
	sizeBytes: number
	sha256: string
	etag: string
	storagePath: string
	createdAt: number
}

export function formatEtag(sha256: string): string {
	return `"${sha256}"`
}

export abstract class ArtifactRepository {
	static async insert(row: {
		id: string
		workspaceId: string
		ownerId: string
		filename: string
		contentType: string
		sizeBytes: number
		sha256: string
		storagePath: string
		createdAt: number
	}): Promise<void> {
		await getPrisma().artifact.create({
			data: {
				id: row.id,
				workspaceId: row.workspaceId,
				ownerId: row.ownerId,
				filename: row.filename,
				contentType: row.contentType,
				sizeBytes: row.sizeBytes,
				sha256: row.sha256,
				storagePath: row.storagePath,
				createdAt: BigInt(row.createdAt)
			}
		})
	}

	static async findByIdCached(id: string): Promise<ArtifactRecord | null> {
		return cacheGetOrSet(`art:meta:${id}`, env.CACHE_TTL_SECONDS, async () => {
			const row = await getPrisma().artifact.findUnique({ where: { id } })
			if (!row) return null
			return {
				id: row.id,
				workspaceId: row.workspaceId,
				ownerId: row.ownerId,
				filename: row.filename,
				contentType: row.contentType,
				sizeBytes: row.sizeBytes,
				sha256: row.sha256,
				etag: formatEtag(row.sha256),
				storagePath: row.storagePath,
				createdAt: Number(row.createdAt)
			}
		})
	}
}
