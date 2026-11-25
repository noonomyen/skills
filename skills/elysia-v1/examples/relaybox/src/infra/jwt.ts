import { CryptoHasher } from 'bun'
import { timingSafeEqual } from 'node:crypto'

export interface JwtClaims {
	iss: string
	aud: string
	sub: string
	role: string
	sid: string
	jti: string
	iat: number
	nbf?: number
	exp: number
}

export interface JwtVerifyOptions {
	issuer: string
	audience: string
	clockToleranceSec?: number
}

const MAX_JWT_LENGTH = 8192
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/
const decoder = new TextDecoder('utf-8', { fatal: true })

function toBase64Url(input: string | Uint8Array): string {
	if (typeof input === 'string') return Buffer.from(input, 'utf8').toString('base64url')
	return Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString('base64url')
}

function decodeBase64Url(input: string): Uint8Array | null {
	if (input.length === 0 || input.length % 4 === 1 || !BASE64URL_RE.test(input)) return null
	const buf = Buffer.from(input, 'base64url')
	if (buf.toString('base64url') !== input) return null
	return buf
}

const HS256_HEADER_B64 = toBase64Url('{"alg":"HS256","typ":"JWT"}')

function assertHs256Secret(secret: string): void {
	// RFC 7518 S3.2: HS256 key size MUST be at least 256 bits (32 octets).
	if (Buffer.byteLength(secret, 'utf8') < 32) {
		throw new RangeError('HS256 JWT secret must be at least 32 bytes')
	}
}

function signInput(signingInput: string, secret: string): Uint8Array {
	const hasher = new CryptoHasher('sha256', secret)
	hasher.update(signingInput)
	return hasher.digest()
}

export function signJwt(
	claims: Omit<JwtClaims, 'iat' | 'exp' | 'nbf'>,
	secret: string,
	ttlSeconds: number
): string {
	assertHs256Secret(secret)
	if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
		throw new RangeError('JWT ttlSeconds must be positive')
	}
	const now = Math.floor(Date.now() / 1000)
	const fullClaims: JwtClaims = {
		...claims,
		iat: now,
		nbf: now,
		exp: now + ttlSeconds
	}
	const payloadB64 = toBase64Url(JSON.stringify(fullClaims))
	const signingInput = `${HS256_HEADER_B64}.${payloadB64}`
	const sigB64 = toBase64Url(signInput(signingInput, secret))
	return `${signingInput}.${sigB64}`
}

export function verifyJwt(
	token: string,
	secret: string,
	options: JwtVerifyOptions
): JwtClaims | null {
	assertHs256Secret(secret)
	if (token.length === 0 || token.length > MAX_JWT_LENGTH) return null

	const parts = token.split('.')
	if (parts.length !== 3) return null
	const [headerB64, payloadB64, sigB64] = parts
	if (!headerB64 || !payloadB64 || !sigB64) return null

	const headerBytes = decodeBase64Url(headerB64)
	const payloadBytes = decodeBase64Url(payloadB64)
	const providedSig = decodeBase64Url(sigB64)
	if (!headerBytes || !payloadBytes || !providedSig) return null

	const signingInput = `${headerB64}.${payloadB64}`
	const expectedSig = signInput(signingInput, secret)
	if (providedSig.byteLength !== expectedSig.byteLength) return null
	if (!timingSafeEqual(providedSig, expectedSig)) return null

	try {
		const header = JSON.parse(decoder.decode(headerBytes)) as Record<string, unknown>
		if (header.alg !== 'HS256') return null
		if (header.typ !== undefined && header.typ !== 'JWT') return null
		// RFC 7515 S4.1.11: reject critical header extensions we do not implement.
		if (header.crit !== undefined) return null

		const claims = JSON.parse(decoder.decode(payloadBytes)) as Record<string, unknown>
		if (
			typeof claims.sub !== 'string' ||
			claims.sub.length === 0 ||
			typeof claims.role !== 'string' ||
			claims.role.length === 0 ||
			typeof claims.sid !== 'string' ||
			claims.sid.length === 0 ||
			typeof claims.jti !== 'string' ||
			claims.jti.length === 0 ||
			claims.iss !== options.issuer ||
			claims.aud !== options.audience ||
			typeof claims.iat !== 'number' ||
			!Number.isFinite(claims.iat) ||
			typeof claims.exp !== 'number' ||
			!Number.isFinite(claims.exp)
		) {
			return null
		}

		const skew = options.clockToleranceSec ?? 5
		const now = Math.floor(Date.now() / 1000)
		if (claims.iat > now + skew) return null
		if (claims.nbf !== undefined) {
			if (typeof claims.nbf !== 'number' || !Number.isFinite(claims.nbf)) return null
			if (claims.nbf > now + skew) return null
		}
		if (claims.exp <= now) return null

		return claims as unknown as JwtClaims
	} catch {
		return null
	}
}
