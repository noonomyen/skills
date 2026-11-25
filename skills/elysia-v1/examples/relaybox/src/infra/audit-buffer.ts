import type { PrismaClient } from '../generated/prisma/client'
import { getPrisma } from './db'

export interface AuditEvent {
	id: string
	actorId: string | null
	method: string
	path: string
	statusCode: number
	durationMs: number
	ip: string
	createdAt: number
}

const PG_DATA_ERROR_RE = /\b2[23][0-9A-Z]{3}\b|invalid byte sequence/i

function isPgDataError(err: unknown): boolean {
	if (!err || typeof err !== 'object') return false
	const record = err as {
		code?: unknown
		message?: unknown
		meta?: {
			code?: unknown
			message?: unknown
			driverAdapterError?: { cause?: { code?: unknown; originalCode?: unknown } }
		}
		cause?: { code?: unknown; message?: unknown }
	}
	const candidates = [
		record.code,
		record.meta?.code,
		record.meta?.driverAdapterError?.cause?.code,
		record.meta?.driverAdapterError?.cause?.originalCode,
		record.cause?.code
	]
	for (const candidate of candidates) {
		if (typeof candidate === 'string' && /^2[23][0-9A-Z]{3}$/.test(candidate)) {
			return true
		}
	}
	for (const msg of [record.message, record.meta?.message, record.cause?.message]) {
		if (typeof msg === 'string' && PG_DATA_ERROR_RE.test(msg)) {
			return true
		}
	}
	return false
}

// Double-buffered non-blocking batch queue using single-query UNNEST bulk insert.
export class AuditBatchBuffer {
	private queue: AuditEvent[] = []
	private timer: Timer | null = null
	private flushing: Promise<number> | null = null
	private flushScheduled = false
	private stopped = false
	private totalDropped = 0
	private consecutiveFailures = 0

	constructor(
		private readonly getClient: () => PrismaClient = getPrisma,
		private readonly maxBuffer = 4096,
		private readonly flushThreshold = 128,
		private readonly flushIntervalMs = 500,
		private readonly maxBatchRetries = 3
	) {}

	start(): void {
		this.stopped = false
		if (this.timer) return
		this.timer = setInterval(() => {
			void this.flush().catch((err) => {
				console.error('AuditBatchBuffer interval flush failed:', err)
			})
		}, this.flushIntervalMs)
		this.timer.unref?.()
	}

	push(event: AuditEvent): void {
		if (this.stopped || this.queue.length >= this.maxBuffer) {
			this.totalDropped++
			return
		}
		this.queue.push(event)
		if (this.queue.length >= this.flushThreshold && !this.flushScheduled) {
			this.flushScheduled = true
			queueMicrotask(() => {
				this.flushScheduled = false
				if (this.stopped) return
				void this.flush().catch((err) => {
					console.error('AuditBatchBuffer microtask flush failed:', err)
				})
			})
		}
	}

	private async insertBatch(batch: AuditEvent[]): Promise<void> {
		const len = batch.length
		const ids = new Array<string>(len)
		const actors = new Array<string | null>(len)
		const methods = new Array<string>(len)
		const paths = new Array<string>(len)
		const statuses = new Array<number>(len)
		const durations = new Array<number>(len)
		const ips = new Array<string>(len)
		const timestamps = new Array<string>(len)

		for (let i = 0; i < len; i++) {
			const e = batch[i]!
			ids[i] = e.id
			actors[i] = e.actorId
			methods[i] = e.method
			paths[i] = e.path
			statuses[i] = e.statusCode
			durations[i] = e.durationMs
			ips[i] = e.ip
			timestamps[i] = String(e.createdAt)
		}

		await this.getClient().$executeRaw`
			INSERT INTO audit_logs (id, actor_id, method, path, status_code, duration_ms, ip, created_at)
			SELECT * FROM UNNEST(
				${ids}::text[],
				${actors}::text[],
				${methods}::text[],
				${paths}::text[],
				${statuses}::int4[],
				${durations}::float8[],
				${ips}::text[],
				${timestamps}::int8[]
			)
			ON CONFLICT (id) DO NOTHING
		`
	}

	private requeueFront(batch: AuditEvent[]): void {
		const available = Math.max(0, this.maxBuffer - this.queue.length)
		if (available > 0) {
			this.queue = batch.slice(-available).concat(this.queue)
			this.totalDropped += Math.max(0, batch.length - available)
		} else {
			this.totalDropped += batch.length
		}
	}

	// Binary-splits data-error batches in O(K log N) and aborts immediately on DB connectivity errors.
	private async rescueCleanRows(batch: AuditEvent[]): Promise<{ saved: number; remaining: AuditEvent[] }> {
		if (batch.length === 0) return { saved: 0, remaining: [] }
		if (batch.length === 1) {
			try {
				await this.insertBatch(batch)
				return { saved: 1, remaining: [] }
			} catch (rowErr) {
				if (isPgDataError(rowErr)) {
					this.totalDropped++
					console.error('AuditBatchBuffer dropped poison row:', rowErr)
					return { saved: 0, remaining: [] }
				}
				return { saved: 0, remaining: batch }
			}
		}

		const mid = batch.length >> 1
		const halves = [batch.slice(0, mid), batch.slice(mid)]
		let saved = 0

		for (let i = 0; i < halves.length; i++) {
			const half = halves[i]!
			try {
				await this.insertBatch(half)
				saved += half.length
			} catch (halfErr) {
				if (!isPgDataError(halfErr)) {
					const rest = i === 0 ? half.concat(halves[1]!) : half
					return { saved, remaining: rest }
				}
				const sub = await this.rescueCleanRows(half)
				saved += sub.saved
				if (sub.remaining.length > 0) {
					const rest = i === 0 ? sub.remaining.concat(halves[1]!) : sub.remaining
					return { saved, remaining: rest }
				}
			}
		}
		return { saved, remaining: [] }
	}

	async flush(): Promise<number> {
		if (this.flushing) return this.flushing
		if (this.queue.length === 0) return 0

		this.flushing = (async () => {
			let total = 0
			try {
				while (this.queue.length > 0) {
					const batch = this.queue
					this.queue = []
					const len = batch.length

					try {
						await this.insertBatch(batch)
						total += len
						this.consecutiveFailures = 0
					} catch (err) {
						this.consecutiveFailures++
						if (!isPgDataError(err) || this.consecutiveFailures < this.maxBatchRetries) {
							this.requeueFront(batch)
							console.error('AuditBatchBuffer DB flush failed:', err)
							break
						}

						this.consecutiveFailures = 0
						const { saved, remaining } = await this.rescueCleanRows(batch)
						total += saved
						if (remaining.length > 0) {
							this.requeueFront(remaining)
							break
						}
					}
				}
				return total
			} finally {
				this.flushing = null
			}
		})()

		return this.flushing
	}

	async stop(): Promise<number> {
		this.stopped = true
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = null
		}
		if (this.flushing) await this.flushing
		return this.flush()
	}

	get pendingCount(): number {
		return this.queue.length
	}

	get droppedCount(): number {
		return this.totalDropped
	}
}

export const auditBuffer = new AuditBatchBuffer()
