import { Elysia, status, t } from 'elysia'
import { env } from '../../env'
import { authMacro, clearCookieWithParity, extractBearerToken } from '../../plugins/auth.macro'
import { rateLimitMacro } from '../../plugins/rate-limit.macro'
import { isTrustedOrigin, securityPlugin } from '../../plugins/security'
import { AuthSchemas } from './model'
import { AuthService } from './service'

function setTokenResponseHeaders(
	set: { headers: Record<string, string | number> },
	cookie: {
		access_token?: { set(opts: Record<string, unknown>): void }
		refresh_token?: { set(opts: Record<string, unknown>): void }
	},
	tokens: { accessToken: string; refreshToken: string; refreshExpiresIn: number }
): void {
	set.headers['cache-control'] = 'no-store'
	set.headers['pragma'] = 'no-cache'

	cookie.access_token?.set({
		value: tokens.accessToken,
		httpOnly: true,
		secure: env.IS_PRODUCTION,
		sameSite: 'lax',
		maxAge: 15 * 60,
		path: '/'
	})
	cookie.refresh_token?.set({
		value: tokens.refreshToken,
		httpOnly: true,
		secure: env.IS_PRODUCTION,
		sameSite: 'lax',
		maxAge: tokens.refreshExpiresIn,
		path: '/api/auth'
	})
}

export const authModule = new Elysia({ name: 'module:auth', prefix: '/auth' })
	.use(securityPlugin)
	.use(authMacro)
	.use(rateLimitMacro)
	.model(AuthSchemas)
	.prefix('model', 'auth.')
	.post(
		'/register',
		async ({ body, request, server, getClientIp, headers, cookie, set }) => {
			const { refreshExpiresIn, ...dto } = await AuthService.register(body, {
				ip: getClientIp(request, server),
				userAgent: headers['user-agent'] ?? 'Unknown'
			})
			setTokenResponseHeaders(set, cookie, { ...dto, refreshExpiresIn })
			return status(201, dto)
		},
		{
			rateLimit: {
				keyPrefix: 'auth-register',
				limit: 20,
				windowSec: 60,
				fallbackOnRedisError: 'memory'
			},
			body: 'auth.RegisterBody',
			response: {
				201: 'auth.AuthSuccess',
				409: 'auth.ErrorResponse',
				429: 'auth.ErrorResponse'
			}
		}
	)
	.post(
		'/login',
		async ({ body, request, server, getClientIp, headers, cookie, set }) => {
			const { refreshExpiresIn, ...dto } = await AuthService.login(body, {
				ip: getClientIp(request, server),
				userAgent: headers['user-agent'] ?? 'Unknown'
			})
			setTokenResponseHeaders(set, cookie, { ...dto, refreshExpiresIn })
			return dto
		},
		{
			rateLimit: {
				keyPrefix: 'auth-login',
				limit: 30,
				windowSec: 60,
				fallbackOnRedisError: 'memory'
			},
			body: 'auth.LoginBody',
			response: {
				200: 'auth.AuthSuccess',
				401: 'auth.ErrorResponse',
				403: 'auth.ErrorResponse',
				429: 'auth.ErrorResponse'
			}
		}
	)
	.post(
		'/refresh',
		async ({ request, body, cookie, set }) => {
			const cookieRefresh =
				typeof cookie.refresh_token?.value === 'string' ? cookie.refresh_token.value : undefined
			if (!body?.refreshToken && cookieRefresh && !isTrustedOrigin(request)) {
				return status(403, { error: 'Untrusted request origin', code: 'FORBIDDEN_ORIGIN' })
			}
			const token = body?.refreshToken ?? cookieRefresh
			if (!token) {
				set.headers['www-authenticate'] = 'Bearer realm="relaybox"'
				return status(401, { error: 'Missing refresh token', code: 'UNAUTHORIZED' })
			}
			const { refreshExpiresIn, ...dto } = await AuthService.refresh(token)
			setTokenResponseHeaders(set, cookie, { ...dto, refreshExpiresIn })
			return dto
		},
		{
			rateLimit: {
				keyPrefix: 'auth-refresh',
				limit: 30,
				windowSec: 60,
				fallbackOnRedisError: 'memory'
			},
			body: 'auth.RefreshBody',
			response: {
				200: 'auth.AuthSuccess',
				401: 'auth.ErrorResponse',
				403: 'auth.ErrorResponse',
				429: 'auth.ErrorResponse'
			}
		}
	)
	.get('/me', ({ auth }) => auth, {
		auth: true,
		response: {
			200: 'auth.MeResponse',
			401: 'auth.ErrorResponse'
		}
	})
	.post(
		'/logout',
		async ({ request, headers, body, cookie: { access_token, refresh_token } }) => {
			const bearerToken = extractBearerToken(headers.authorization)
			const cookieAccess =
				typeof access_token?.value === 'string' && access_token.value.length > 0
					? access_token.value
					: undefined
			const cookieRefresh =
				typeof refresh_token?.value === 'string' && refresh_token.value.length > 0
					? refresh_token.value
					: undefined

			if (!bearerToken && (cookieAccess || cookieRefresh) && !isTrustedOrigin(request)) {
				return status(403, { error: 'Untrusted request origin', code: 'FORBIDDEN_ORIGIN' })
			}

			await AuthService.logoutByCredentials({
				bearerOrCookieAccess: bearerToken ?? cookieAccess,
				refreshToken: body?.refreshToken ?? cookieRefresh
			})
			clearCookieWithParity(access_token, '/')
			clearCookieWithParity(refresh_token, '/api/auth')
			return { ok: true }
		},
		{
			rateLimit: {
				keyPrefix: 'auth-logout',
				limit: 60,
				windowSec: 60,
				fallbackOnRedisError: 'memory'
			},
			body: 'auth.LogoutBody',
			response: {
				200: t.Object({ ok: t.Boolean() }),
				401: 'auth.ErrorResponse',
				403: 'auth.ErrorResponse',
				429: 'auth.ErrorResponse'
			}
		}
	)
	.get('/admin/stats', () => AuthService.getStats(), {
		adminOnly: true,
		response: {
			200: t.Object({
				users: t.Number(),
				activeSessions: t.Number()
			}),
			401: 'auth.ErrorResponse',
			403: 'auth.ErrorResponse'
		}
	})
