import { Elysia, status, t } from 'elysia'
import { env } from '../env'
import { getCacheStore } from '../infra/cache'
import { verifyJwt } from '../infra/jwt'
import { isTrustedOrigin } from './security'

const BEARER_RE = /^Bearer\s+(\S+)$/i
const UNSAFE_HTTP_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export const requestActorMap = new WeakMap<Request, string>()

export function extractBearerToken(authorization: string | undefined): string | undefined {
	if (!authorization) return undefined
	return BEARER_RE.exec(authorization.trim())?.[1]
}

export function clearCookieWithParity(
	cookie: { set(opts: Record<string, unknown>): void } | undefined,
	path: string
): void {
	cookie?.set({
		value: '',
		httpOnly: true,
		secure: env.IS_PRODUCTION,
		sameSite: 'lax',
		maxAge: 0,
		expires: new Date(0),
		path
	})
}

export const authMacro = new Elysia({ name: 'macro:auth' })
	.macro({
		auth: {
			cookie: t.Cookie({
				access_token: t.Optional(t.String())
			}),
			async resolve({ request, cookie: { access_token }, headers, set }) {
				const bearerToken = extractBearerToken(headers.authorization)
				const cookieToken =
					typeof access_token?.value === 'string' && access_token.value.length > 0
						? access_token.value
						: undefined

				const usingCookieAuth = !bearerToken && !!cookieToken
				const isWsUpgrade = headers.upgrade?.toLowerCase() === 'websocket'
				if (usingCookieAuth && (UNSAFE_HTTP_METHODS.has(request.method) || isWsUpgrade)) {
					if (!isTrustedOrigin(request, isWsUpgrade)) {
						return status(403, { error: 'Untrusted request origin', code: 'FORBIDDEN_ORIGIN' })
					}
				}

				const token = bearerToken ?? cookieToken
				if (!token) {
					set.headers['www-authenticate'] = 'Bearer realm="relaybox"'
					return status(401, { error: 'Unauthorized', code: 'UNAUTHORIZED' })
				}

				const claims = verifyJwt(token, env.JWT_SECRET, {
					issuer: env.JWT_ISSUER,
					audience: env.JWT_AUDIENCE
				})
				if (!claims) {
					set.headers['www-authenticate'] = 'Bearer realm="relaybox", error="invalid_token"'
					return status(401, { error: 'Invalid or expired token', code: 'UNAUTHORIZED' })
				}

				let revoked: string | null
				try {
					revoked = await getCacheStore().get(`auth:{${claims.sid}}:revoked`)
				} catch {
					return status(503, { error: 'Auth store unavailable', code: 'SERVICE_UNAVAILABLE' })
				}

				if (revoked) {
					if (cookieToken) clearCookieWithParity(access_token, '/')
					set.headers['www-authenticate'] = 'Bearer realm="relaybox", error="invalid_token"'
					return status(401, { error: 'Session revoked', code: 'UNAUTHORIZED' })
				}

				requestActorMap.set(request, claims.sub)
				return {
					auth: {
						userId: claims.sub,
						role: claims.role,
						sessionId: claims.sid,
						exp: claims.exp
					}
				}
			}
		}
	})
	.macro('adminOnly', {
		auth: true,
		resolve({ auth }) {
			if (auth.role !== 'admin') {
				return status(403, { error: 'Forbidden', code: 'FORBIDDEN' })
			}
		}
	})
