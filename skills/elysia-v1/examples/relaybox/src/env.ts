import { getSchemaValidator, t, type Static } from 'elysia'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EnvSchema = t.Object({
	NODE_ENV: t.Union([t.Literal('development'), t.Literal('production'), t.Literal('test')]),
	HOST: t.String({ minLength: 1, default: '127.0.0.1' }),
	PORT: t.Integer({ default: 3000, minimum: 1, maximum: 65535 }),
	DATABASE_URL: t.String({ minLength: 1 }),
	REDIS_URL: t.String({ minLength: 1 }),
	// RFC 7518 S3.2 requires HS256 keys of at least 256 bits (32 bytes).
	JWT_SECRET: t.String({ minLength: 32 }),
	JWT_ISSUER: t.String({ minLength: 1, default: 'relaybox' }),
	JWT_AUDIENCE: t.String({ minLength: 1, default: 'relaybox-api' }),
	ARTIFACT_DIR: t.String({ minLength: 1 }),
	ALLOWED_HOSTS: t.String({ default: '' }),
	TRUSTED_PROXIES: t.String({ default: '' }),
	CACHE_TTL_SECONDS: t.Integer({ default: 30, minimum: 0 }),
	RATE_LIMIT_PER_MIN: t.Integer({ default: 120, minimum: 1 })
})

export type AppEnv = Static<typeof EnvSchema> & {
	IS_PRODUCTION: boolean
	IS_TEST: boolean
	ALLOWED_HOST_LIST: string[]
	TRUSTED_PROXY_LIST: string[]
}

const DEV_DEFAULTS = {
	DATABASE_URL: 'postgres://relaybox:relaybox@127.0.0.1:54332/relaybox',
	REDIS_URL: 'redis://127.0.0.1:63792',
	JWT_SECRET: 'relaybox-dev-jwt-secret-must-be-at-least-32-bytes'
} as const

const envValidator = getSchemaValidator(EnvSchema, {
	coerce: true,
	normalize: 'exactMirror',
	additionalProperties: true
})

function splitCsv(raw: string): string[] {
	return raw
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
}

function validateTrustedProxyEntries(entries: readonly string[]): void {
	for (const entry of entries) {
		const lower = entry.toLowerCase()
		const slashIdx = lower.indexOf('/')
		if (slashIdx !== -1) {
			const netAddr = lower.slice(0, slashIdx)
			const prefixRaw = lower.slice(slashIdx + 1)
			if (!/^\d+$/.test(prefixRaw)) {
				throw new Error(`Invalid TRUSTED_PROXIES CIDR prefix in "${entry}"`)
			}
			const prefix = Number(prefixRaw)
			const ver = isIP(netAddr)
			if (ver === 4 && (prefix < 0 || prefix > 32)) {
				throw new Error(`Invalid IPv4 CIDR prefix in TRUSTED_PROXIES: "${entry}"`)
			}
			if (ver === 6 && (prefix < 0 || prefix > 128)) {
				throw new Error(`Invalid IPv6 CIDR prefix in TRUSTED_PROXIES: "${entry}"`)
			}
			if (ver === 0) {
				throw new Error(`Invalid IP address in TRUSTED_PROXIES: "${entry}"`)
			}
		} else if (isIP(lower) === 0) {
			throw new Error(`Invalid IP address in TRUSTED_PROXIES: "${entry}"`)
		}
	}
}

export function loadEnv(source: Record<string, string | undefined> = Bun.env): AppEnv {
	const nodeEnv = source.NODE_ENV
	if (nodeEnv !== 'development' && nodeEnv !== 'production' && nodeEnv !== 'test') {
		throw new Error('NODE_ENV must be explicitly set to development, production, or test')
	}
	const isProd = nodeEnv === 'production'

	if (isProd) {
		for (const key of ['DATABASE_URL', 'REDIS_URL', 'JWT_SECRET'] as const) {
			if (!source[key]) {
				throw new Error(`${key} must be explicitly set in production`)
			}
			if (source[key] === DEV_DEFAULTS[key]) {
				throw new Error(`${key} must not use a development default in production`)
			}
		}
		if (!source.ARTIFACT_DIR) {
			throw new Error('ARTIFACT_DIR must be explicitly set in production')
		}
		if (!source.ALLOWED_HOSTS || splitCsv(source.ALLOWED_HOSTS).length === 0) {
			throw new Error('ALLOWED_HOSTS must be explicitly set in production')
		}
	}

	const raw = {
		NODE_ENV: nodeEnv,
		HOST: source.HOST ?? '127.0.0.1',
		PORT: source.PORT ?? '3000',
		DATABASE_URL: source.DATABASE_URL ?? DEV_DEFAULTS.DATABASE_URL,
		REDIS_URL: source.REDIS_URL ?? DEV_DEFAULTS.REDIS_URL,
		JWT_SECRET: source.JWT_SECRET ?? DEV_DEFAULTS.JWT_SECRET,
		JWT_ISSUER: source.JWT_ISSUER ?? 'relaybox',
		JWT_AUDIENCE: source.JWT_AUDIENCE ?? 'relaybox-api',
		ARTIFACT_DIR: source.ARTIFACT_DIR ?? join(tmpdir(), 'relaybox-artifacts'),
		ALLOWED_HOSTS: source.ALLOWED_HOSTS ?? '',
		TRUSTED_PROXIES: source.TRUSTED_PROXIES ?? '',
		CACHE_TTL_SECONDS: source.CACHE_TTL_SECONDS ?? '30',
		RATE_LIMIT_PER_MIN: source.RATE_LIMIT_PER_MIN ?? '120'
	}

	if (!envValidator.Check(raw)) {
		const errs = [...envValidator.Errors(raw)].map((e) => `${e.path}: ${e.message}`)
		throw new Error(`Invalid environment configuration: ${errs.join('; ')}`)
	}

	const parsed = envValidator.Decode(raw) as Static<typeof EnvSchema>
	const trustedProxies = splitCsv(parsed.TRUSTED_PROXIES)
	validateTrustedProxyEntries(trustedProxies)

	return {
		...parsed,
		IS_PRODUCTION: isProd,
		IS_TEST: nodeEnv === 'test',
		ALLOWED_HOST_LIST: splitCsv(parsed.ALLOWED_HOSTS).map((h) => h.toLowerCase()),
		TRUSTED_PROXY_LIST: trustedProxies
	}
}

export const env = loadEnv()
