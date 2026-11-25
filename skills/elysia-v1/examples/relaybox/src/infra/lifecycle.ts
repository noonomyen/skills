import { auditBuffer } from './audit-buffer'
import { closeCacheStore, getCacheStore } from './cache'
import { closeDatabase, ensureDatabaseConnected } from './db'

let startPromise: Promise<void> | null = null
let shutdownPromise: Promise<void> | null = null

export async function startInfra(enableAudit: boolean): Promise<void> {
	if (startPromise) return startPromise
	startPromise = (async () => {
		await ensureDatabaseConnected()
		await getCacheStore().ping()
		if (enableAudit) auditBuffer.start()
	})().catch((err) => {
		startPromise = null
		throw err
	})
	return startPromise
}

export async function shutdownInfra(enableAudit: boolean): Promise<void> {
	if (shutdownPromise) return shutdownPromise
	shutdownPromise = (async () => {
		try {
			if (enableAudit) await auditBuffer.stop()
		} finally {
			try {
				closeCacheStore()
			} finally {
				await closeDatabase()
			}
		}
		startPromise = null
	})().finally(() => {
		shutdownPromise = null
	})
	return shutdownPromise
}
