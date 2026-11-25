import { CryptoHasher } from 'bun'
import { timingSafeEqual } from 'node:crypto'
import { eventBus } from '../../infra/event-bus'
import { NotFoundDomainError } from '../../plugins/errors'
import { WorkspaceService } from '../workspaces/service'
import type { WebhookModel } from './model'
import { WebhookRepository, type WebhookRecord } from './repository'

const WEBHOOK_TOLERANCE_SEC = 300
const TIMESTAMP_RE = /^\d{1,12}$/

export abstract class WebhookService {
	static verifySignedRequest(input: {
		method: string
		path: string
		workspaceId: string
		rawBytes: Uint8Array
		timestampHeader: string | null
		signatureHeader: string | null
		secret: string
		nowSec?: number
	}): { valid: true; ts: number; sigHex: string } | { valid: false } {
		const {
			method,
			path,
			workspaceId,
			rawBytes,
			timestampHeader,
			signatureHeader,
			secret,
			nowSec = Math.floor(Date.now() / 1000)
		} = input

		if (!timestampHeader || !signatureHeader) return { valid: false }
		if (!TIMESTAMP_RE.test(timestampHeader)) return { valid: false }
		const ts = Number(timestampHeader)
		if (!Number.isSafeInteger(ts) || Math.abs(nowSec - ts) > WEBHOOK_TOLERANCE_SEC) {
			return { valid: false }
		}

		const lowerSig = signatureHeader.trim().toLowerCase()
		if (!lowerSig.startsWith('sha256=')) return { valid: false }
		const providedHex = lowerSig.slice(7)
		if (!/^[0-9a-f]{64}$/.test(providedHex)) return { valid: false }

		const expected = new CryptoHasher('sha256', secret)
			.update(`${method}\n${path}\n${workspaceId}\n${ts}.`)
			.update(rawBytes)
			.digest()
		const provided = Buffer.from(providedHex, 'hex')
		if (provided.byteLength !== expected.byteLength || !timingSafeEqual(provided, expected)) {
			return { valid: false }
		}
		return { valid: true, ts, sigHex: providedHex }
	}

	static async ingest(input: {
		workspaceId: string
		source: string
		body: WebhookModel['ingestBody']
	}): Promise<{ id: string; accepted: boolean }> {
		const id = Bun.randomUUIDv7()
		const createdAt = Date.now()
		const source = input.source.slice(0, 64)
		const record: WebhookRecord = {
			id,
			workspaceId: input.workspaceId,
			source,
			eventType: input.body.event,
			payload: input.body.data,
			deliveryStatus: 'queued',
			createdAt
		}

		await WebhookRepository.insert(record)
		eventBus.publish(record)

		return { id, accepted: true }
	}

	static async getById(id: string, userId: string): Promise<WebhookRecord> {
		const item = await WebhookRepository.findByIdCached(id)
		if (!item) {
			throw new NotFoundDomainError('Webhook event not found', 'WEBHOOK_NOT_FOUND')
		}
		await WorkspaceService.assertMember(item.workspaceId, userId)
		return item
	}

	static async listByWorkspace(
		workspaceId: string,
		userId: string,
		limit: number,
		events?: string[]
	): Promise<WebhookRecord[]> {
		await WorkspaceService.assertMember(workspaceId, userId)
		return WebhookRepository.listByWorkspace(workspaceId, limit, events)
	}

	static async replayAfter(
		workspaceId: string,
		lastEventId: string
	): Promise<{ items: WebhookRecord[]; hasMore: boolean }> {
		return WebhookRepository.listAfterId(workspaceId, lastEventId, 200)
	}
}
