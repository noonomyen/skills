import { CryptoHasher } from 'bun'
import { mkdir, realpath, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { env } from '../../env'
import { AppError, NotFoundDomainError } from '../../plugins/errors'
import { WorkspaceService } from '../workspaces/service'
import { ArtifactRepository, formatEtag, type ArtifactRecord } from './repository'

const WORKSPACE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/
const MEDIA_TYPE_RE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/
const MAX_FILENAME_LEN = 120
const SAFE_ARTIFACT_MIMES = new Set([
	'text/plain',
	'application/json',
	'application/octet-stream',
	'application/zip',
	'application/gzip',
	'image/png',
	'image/jpeg',
	'image/webp'
])

export function sanitizeUploadFilename(rawName: string | undefined): string {
	// Strip control bytes (including CR/LF) BEFORE splitting path separators so "a\nb/c" reduces cleanly to "c".
	const noControl = (rawName ?? 'artifact.bin').replace(/[\x00-\x1f\x7f]/g, '_')
	const base = (noControl.split(/[\\/]/).pop() ?? '').trim()
	if (!base || base === '.' || base === '..') return 'artifact.bin'
	return base.length > MAX_FILENAME_LEN ? base.slice(0, MAX_FILENAME_LEN) : base
}

export function sanitizeArtifactMime(rawType: string | undefined): string {
	const base = (rawType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
	if (!MEDIA_TYPE_RE.test(base) || !SAFE_ARTIFACT_MIMES.has(base)) {
		return 'application/octet-stream'
	}
	return base
}

export abstract class ArtifactService {
	static async saveUpload(
		workspaceId: string,
		ownerId: string,
		uploaded: File
	): Promise<Omit<ArtifactRecord, 'storagePath'>> {
		if (!WORKSPACE_ID_RE.test(workspaceId)) {
			throw new AppError(400, 'INVALID_WORKSPACE_ID', 'Invalid workspaceId')
		}

		await WorkspaceService.assertMember(workspaceId, ownerId)

		const id = Bun.randomUUIDv7()
		const originalName = sanitizeUploadFilename(uploaded.name)
		const diskName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'artifact.bin'

		const rootDir = resolve(env.ARTIFACT_DIR)
		await mkdir(rootDir, { recursive: true })
		const realRoot = await realpath(rootDir)

		const workspaceDir = resolve(join(realRoot, workspaceId))
		if (workspaceDir !== realRoot && !workspaceDir.startsWith(realRoot + sep)) {
			throw new AppError(400, 'INVALID_PATH', 'Invalid artifact workspace path')
		}
		await mkdir(workspaceDir, { recursive: true })
		const realDir = await realpath(workspaceDir)
		if (realDir !== realRoot && !realDir.startsWith(realRoot + sep)) {
			throw new AppError(400, 'INVALID_PATH', 'Symlink escape blocked')
		}

		const fileName = `${id}-${diskName}`
		const fullPath = resolve(join(realDir, fileName))
		if (!fullPath.startsWith(realDir + sep)) {
			throw new AppError(400, 'INVALID_PATH', 'Invalid artifact path')
		}
		const relPath = `${workspaceId}/${fileName}`

		const bytes = new Uint8Array(await uploaded.arrayBuffer())
		const sha256 = new CryptoHasher('sha256').update(bytes).digest('hex')
		await Bun.write(fullPath, bytes)

		const createdAt = Date.now()
		const contentType = sanitizeArtifactMime(uploaded.type)

		try {
			await ArtifactRepository.insert({
				id,
				workspaceId,
				ownerId,
				filename: originalName,
				contentType,
				sizeBytes: bytes.byteLength,
				sha256,
				storagePath: relPath,
				createdAt
			})
		} catch (err) {
			await rm(fullPath, { force: true }).catch(() => {})
			throw err
		}

		return {
			id,
			workspaceId,
			ownerId,
			filename: originalName,
			contentType,
			sizeBytes: bytes.byteLength,
			sha256,
			etag: formatEtag(sha256),
			createdAt
		}
	}

	static async getAuthorizedDownload(
		id: string,
		userId: string
	): Promise<{ meta: ArtifactRecord; resolvedPath: string }> {
		const record = await ArtifactRepository.findByIdCached(id)
		if (!record) {
			throw new NotFoundDomainError('Artifact not found', 'ARTIFACT_NOT_FOUND')
		}

		await WorkspaceService.assertMember(record.workspaceId, userId)

		const realRoot = await realpath(resolve(env.ARTIFACT_DIR)).catch(() => null)
		if (!realRoot) {
			throw new NotFoundDomainError('Artifact file missing', 'ARTIFACT_NOT_FOUND')
		}

		const candidate = resolve(realRoot, record.storagePath)
		if (!candidate.startsWith(realRoot + sep)) {
			throw new AppError(400, 'INVALID_PATH', 'Invalid artifact path')
		}

		let resolvedPath: string
		try {
			resolvedPath = await realpath(candidate)
		} catch {
			throw new NotFoundDomainError('Artifact file missing', 'ARTIFACT_NOT_FOUND')
		}
		if (!resolvedPath.startsWith(realRoot + sep)) {
			throw new AppError(400, 'INVALID_PATH', 'Symlink escape blocked')
		}

		if (!(await Bun.file(resolvedPath).exists())) {
			throw new NotFoundDomainError('Artifact file missing', 'ARTIFACT_NOT_FOUND')
		}

		return { meta: record, resolvedPath }
	}
}
