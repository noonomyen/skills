import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'
import { env } from '../env'
import { PrismaClient } from '../generated/prisma/client'

interface PrismaBundle {
	client: PrismaClient
	pool: Pool
}

const hotRegistry = globalThis as typeof globalThis & {
	__relayboxPrisma?: PrismaBundle
}

let activeBundle: PrismaBundle | null = env.IS_PRODUCTION ? null : (hotRegistry.__relayboxPrisma ?? null)

function createPrismaBundle(): PrismaBundle {
	const pool = new Pool({
		connectionString: env.DATABASE_URL,
		max: 20,
		idleTimeoutMillis: 30_000,
		connectionTimeoutMillis: 5_000
	})
	pool.on('error', (err) => {
		console.error('[relaybox:pg-pool] idle client error:', err)
	})
	const adapter = new PrismaPg(pool)
	const client = new PrismaClient({ adapter })
	return { client, pool }
}

export function getPrisma(): PrismaClient {
	if (!activeBundle) {
		activeBundle = createPrismaBundle()
		if (!env.IS_PRODUCTION) {
			hotRegistry.__relayboxPrisma = activeBundle
		}
	}
	return activeBundle.client
}

export async function ensureDatabaseConnected(): Promise<void> {
	await getPrisma().$connect()
}

export async function closeDatabase(): Promise<void> {
	const current = activeBundle
	activeBundle = null
	if (!env.IS_PRODUCTION) {
		delete hotRegistry.__relayboxPrisma
	}
	if (!current) return

	try {
		await current.client.$disconnect()
	} finally {
		await current.pool.end().catch(() => {})
	}
}
