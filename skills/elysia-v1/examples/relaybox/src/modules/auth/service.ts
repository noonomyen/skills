import { CryptoHasher } from 'bun'
import { env } from '../../env'
import { Prisma } from '../../generated/prisma/client'
import { getCacheStore } from '../../infra/cache'
import { signJwt, verifyJwt } from '../../infra/jwt'
import {
	AppError,
	ConflictDomainError,
	ForbiddenDomainError,
	UnauthorizedDomainError
} from '../../plugins/errors'
import { checkRateLimit } from '../../plugins/rate-limit.macro'
import type { AuthModel } from './model'
import { AuthRepository } from './repository'

const ACCESS_TTL_SEC = 15 * 60
const REFRESH_TTL_SEC = 7 * 24 * 60 * 60

// Precomputed valid argon2id hash used on unknown-email logins to normalize verification timing.
const DUMMY_PASSWORD_HASH =
	'$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

interface RefreshRecord {
	userId: string
	sessionId: string
}

function hashToken(secretPart: string): string {
	return new CryptoHasher('blake2b256').update(secretPart).digest('hex')
}

function hashEmailForBucket(email: string): string {
	return new CryptoHasher('sha256').update(email).digest('hex')
}

function generateOpaqueRefreshToken(sessionId: string): { token: string; tokenHash: string } {
	const bytes = new Uint8Array(32)
	crypto.getRandomValues(bytes)
	const secretPart = Buffer.from(bytes).toString('base64url')
	return {
		token: `${sessionId}.${secretPart}`,
		tokenHash: hashToken(`${sessionId}.${secretPart}`)
	}
}

function parseRefreshToken(raw: string): { sessionId: string; tokenHash: string } | null {
	const dotIdx = raw.indexOf('.')
	if (dotIdx <= 0 || dotIdx === raw.length - 1) return null
	const sessionId = raw.slice(0, dotIdx)
	if (!/^[0-9a-f-]{16,64}$/i.test(sessionId)) return null
	return { sessionId, tokenHash: hashToken(raw) }
}

function sessionKeys(sessionId: string) {
	return {
		revokedKey: `auth:{${sessionId}}:revoked`,
		sessionRtKey: `auth:{${sessionId}}:session_rt`,
		rtKey: (tokenHash: string) => `auth:{${sessionId}}:rt:${tokenHash}`,
		usedKey: (tokenHash: string) => `auth:{${sessionId}}:used:${tokenHash}`
	}
}

function truncateUserAgent(raw: string | undefined): string {
	return (raw ?? 'Unknown').slice(0, 512)
}

export abstract class AuthService {
	static async register(input: AuthModel['registerBody'], meta: { ip: string; userAgent: string }) {
		const email = input.email.trim().toLowerCase()
		const existing = await AuthRepository.findAuthUserByEmail(email)
		if (existing) {
			throw new ConflictDomainError('Email is already registered', 'EMAIL_IN_USE')
		}

		const id = Bun.randomUUIDv7()
		const role = 'member' as const
		const passwordHash = await Bun.password.hash(input.password, {
			algorithm: 'argon2id',
			memoryCost: 19456,
			timeCost: 2
		})

		try {
			await AuthRepository.createUser({ id, email, passwordHash, role })
		} catch (err) {
			if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
				throw new ConflictDomainError('Email is already registered', 'EMAIL_IN_USE')
			}
			throw err
		}

		let tokens: { accessToken: string; refreshToken: string; refreshExpiresIn: number }
		try {
			tokens = await AuthService.issueSession({
				id,
				role,
				ip: meta.ip,
				userAgent: truncateUserAgent(meta.userAgent)
			})
		} catch (err) {
			await AuthRepository.deleteUser(id).catch(() => {})
			throw err
		}

		return {
			user: { id, email, role },
			tokenType: 'Bearer' as const,
			expiresIn: ACCESS_TTL_SEC,
			...tokens
		}
	}

	static async login(input: AuthModel['loginBody'], meta: { ip: string; userAgent: string }) {
		const email = input.email.trim().toLowerCase()
		const acctLimit = await checkRateLimit(
			{ keyPrefix: 'auth-login-acct', limit: 10, windowSec: 60, fallbackOnRedisError: 'memory' },
			hashEmailForBucket(email)
		)
		if (acctLimit.limited) {
			throw new AppError(429, 'RATE_LIMITED', 'Too many login attempts for account', true, {
				'retry-after': String(acctLimit.resetSec)
			})
		}

		const user = await AuthRepository.findAuthUserByEmail(email)
		if (!user) {
			await Bun.password.verify(input.password, DUMMY_PASSWORD_HASH).catch(() => false)
			throw new UnauthorizedDomainError('Invalid email or password', 'INVALID_CREDENTIALS')
		}

		const valid = await Bun.password.verify(input.password, user.passwordHash)
		if (!valid) {
			throw new UnauthorizedDomainError('Invalid email or password', 'INVALID_CREDENTIALS')
		}

		if (user.disabled) {
			throw new ForbiddenDomainError('Account is disabled', 'ACCOUNT_DISABLED')
		}

		const tokens = await AuthService.issueSession({
			id: user.id,
			role: user.role,
			ip: meta.ip,
			userAgent: truncateUserAgent(meta.userAgent)
		})

		return {
			user: { id: user.id, email: user.email, role: user.role },
			tokenType: 'Bearer' as const,
			expiresIn: ACCESS_TTL_SEC,
			...tokens
		}
	}

	// Pre-checks Redis token possession before Postgres so forged <sid>.garbage cannot probe session/user state.
	static async refresh(refreshToken: string) {
		const parsedToken = parseRefreshToken(refreshToken)
		if (!parsedToken) {
			throw new UnauthorizedDomainError('Invalid or expired refresh token', 'INVALID_REFRESH')
		}

		const keys = sessionKeys(parsedToken.sessionId)
		const store = getCacheStore()
		const [activeRaw, usedSid] = await Promise.all([
			store.get(keys.rtKey(parsedToken.tokenHash)),
			store.get(keys.usedKey(parsedToken.tokenHash))
		])

		if (usedSid) {
			const reused = await store.rotateRefreshToken({
				oldKey: keys.rtKey(parsedToken.tokenHash),
				usedKey: keys.usedKey(parsedToken.tokenHash),
				newKey: keys.rtKey(parsedToken.tokenHash),
				revokedKey: keys.revokedKey,
				sessionRtKey: keys.sessionRtKey,
				oldHash: parsedToken.tokenHash,
				newHash: parsedToken.tokenHash,
				ttlSeconds: REFRESH_TTL_SEC,
				revokeTtlSeconds: ACCESS_TTL_SEC
			})
			await AuthRepository.revokeSession(
				reused.status === 'reuse' ? reused.sessionId : parsedToken.sessionId
			)
			throw new UnauthorizedDomainError('Refresh token reuse detected', 'TOKEN_REUSE')
		}

		if (!activeRaw) {
			throw new UnauthorizedDomainError('Invalid or expired refresh token', 'INVALID_REFRESH')
		}

		let preRecord: RefreshRecord
		try {
			preRecord = JSON.parse(activeRaw) as RefreshRecord
		} catch {
			throw new UnauthorizedDomainError('Invalid or expired refresh token', 'INVALID_REFRESH')
		}
		if (preRecord.sessionId !== parsedToken.sessionId) {
			throw new UnauthorizedDomainError('Invalid or expired refresh token', 'INVALID_REFRESH')
		}

		const session = await AuthRepository.findSessionById(parsedToken.sessionId)
		if (!session || session.revoked) {
			throw new UnauthorizedDomainError('Session revoked', 'UNAUTHORIZED')
		}

		const remainingSec = Math.floor((session.expiresAt.getTime() - Date.now()) / 1000)
		if (remainingSec <= 0) {
			throw new UnauthorizedDomainError('Session expired', 'UNAUTHORIZED')
		}

		const user = await AuthRepository.findPublicUserById(session.userId)
		if (!user) {
			await AuthService.logout(session.id)
			throw new UnauthorizedDomainError('Invalid session user', 'UNAUTHORIZED')
		}
		if (user.disabled) {
			await AuthService.logout(session.id)
			throw new ForbiddenDomainError('Account is disabled', 'ACCOUNT_DISABLED')
		}

		const { token: newRefreshToken, tokenHash: newHash } = generateOpaqueRefreshToken(session.id)
		const rotated = await store.rotateRefreshToken({
			oldKey: keys.rtKey(parsedToken.tokenHash),
			usedKey: keys.usedKey(parsedToken.tokenHash),
			newKey: keys.rtKey(newHash),
			revokedKey: keys.revokedKey,
			sessionRtKey: keys.sessionRtKey,
			oldHash: parsedToken.tokenHash,
			newHash,
			ttlSeconds: remainingSec,
			// Cover max possible lifetime of any previously minted access JWT even near session expiry.
			revokeTtlSeconds: ACCESS_TTL_SEC
		})

		if (rotated.status === 'revoked') {
			throw new UnauthorizedDomainError('Session revoked', 'UNAUTHORIZED')
		}

		if (rotated.status === 'reuse') {
			await AuthRepository.revokeSession(rotated.sessionId)
			throw new UnauthorizedDomainError('Refresh token reuse detected', 'TOKEN_REUSE')
		}

		if (rotated.status === 'miss') {
			throw new UnauthorizedDomainError('Invalid or expired refresh token', 'INVALID_REFRESH')
		}

		let payloadRecord: RefreshRecord
		try {
			payloadRecord = JSON.parse(rotated.payload) as RefreshRecord
		} catch {
			await AuthService.logout(session.id)
			throw new UnauthorizedDomainError('Invalid refresh state', 'UNAUTHORIZED')
		}

		if (payloadRecord.userId !== user.id || payloadRecord.sessionId !== session.id) {
			await AuthService.logout(session.id)
			throw new UnauthorizedDomainError('Invalid refresh session', 'UNAUTHORIZED')
		}

		const accessTtlSec = Math.min(ACCESS_TTL_SEC, remainingSec)
		const newAccessToken = signJwt(
			{
				iss: env.JWT_ISSUER,
				aud: env.JWT_AUDIENCE,
				sub: user.id,
				role: user.role,
				sid: session.id,
				jti: Bun.randomUUIDv7()
			},
			env.JWT_SECRET,
			accessTtlSec
		)

		return {
			user: { id: user.id, email: user.email, role: user.role },
			tokenType: 'Bearer' as const,
			expiresIn: accessTtlSec,
			accessToken: newAccessToken,
			refreshToken: newRefreshToken,
			refreshExpiresIn: remainingSec
		}
	}

	static async logout(sessionId: string): Promise<void> {
		const keys = sessionKeys(sessionId)
		await Promise.all([
			AuthRepository.revokeSession(sessionId),
			getCacheStore().revokeSession(keys.revokedKey, keys.sessionRtKey, ACCESS_TTL_SEC)
		])
	}

	static async logoutByCredentials(input: {
		bearerOrCookieAccess?: string
		refreshToken?: string
	}): Promise<void> {
		let sessionId: string | null = null
		if (input.bearerOrCookieAccess) {
			const claims = verifyJwt(input.bearerOrCookieAccess, env.JWT_SECRET, {
				issuer: env.JWT_ISSUER,
				audience: env.JWT_AUDIENCE
			})
			if (claims) sessionId = claims.sid
		}

		if (!sessionId && input.refreshToken) {
			const parsed = parseRefreshToken(input.refreshToken)
			if (parsed) {
				const keys = sessionKeys(parsed.sessionId)
				const raw = await getCacheStore().get(keys.rtKey(parsed.tokenHash)).catch(() => null)
				if (raw) {
					try {
						sessionId = (JSON.parse(raw) as RefreshRecord).sessionId
					} catch {
						sessionId = null
					}
				}
			}
		}

		if (!sessionId) {
			throw new UnauthorizedDomainError(
				'Valid session token or refresh token required',
				'UNAUTHORIZED'
			)
		}
		await AuthService.logout(sessionId)
	}

	static getStats(): Promise<{ users: number; activeSessions: number }> {
		return AuthRepository.getStats()
	}

	private static async issueSession(input: {
		id: string
		role: string
		ip: string
		userAgent: string
	}): Promise<{ accessToken: string; refreshToken: string; refreshExpiresIn: number }> {
		const sessionId = Bun.randomUUIDv7()
		const expiresAt = new Date(Date.now() + REFRESH_TTL_SEC * 1000)
		await AuthRepository.createSession({
			id: sessionId,
			userId: input.id,
			ip: input.ip,
			userAgent: input.userAgent,
			expiresAt
		})

		const accessToken = signJwt(
			{
				iss: env.JWT_ISSUER,
				aud: env.JWT_AUDIENCE,
				sub: input.id,
				role: input.role,
				sid: sessionId,
				jti: Bun.randomUUIDv7()
			},
			env.JWT_SECRET,
			ACCESS_TTL_SEC
		)
		const { token: refreshToken, tokenHash: rtHash } = generateOpaqueRefreshToken(sessionId)
		const keys = sessionKeys(sessionId)
		const store = getCacheStore()

		try {
			await Promise.all([
				store.set(
					keys.rtKey(rtHash),
					JSON.stringify({
						userId: input.id,
						sessionId
					} satisfies RefreshRecord),
					REFRESH_TTL_SEC
				),
				store.set(keys.sessionRtKey, rtHash, REFRESH_TTL_SEC)
			])
		} catch (err) {
			await AuthRepository.deleteSession(sessionId).catch(() => {})
			throw err
		}

		return { accessToken, refreshToken, refreshExpiresIn: REFRESH_TTL_SEC }
	}
}
