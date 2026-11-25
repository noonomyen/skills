import { defineConfig } from 'prisma/config'

const databaseUrl =
	process.env.DATABASE_URL ??
	(process.env.NODE_ENV === 'production'
		? undefined
		: 'postgres://relaybox:relaybox@127.0.0.1:54332/relaybox')

if (!databaseUrl) {
	throw new Error('DATABASE_URL must be explicitly set when running Prisma in production')
}

export default defineConfig({
	schema: 'prisma/schema.prisma',
	migrations: {
		path: 'prisma/migrations'
	},
	datasource: {
		url: databaseUrl
	}
})
