import { Elysia, ElysiaCustomStatusResponse, ValidationError, status } from 'elysia'
import { env } from '../env'

export type HttpErrorStatus =
	| 400
	| 401
	| 403
	| 404
	| 405
	| 409
	| 413
	| 415
	| 422
	| 429
	| 500
	| 502
	| 503
	| 504

export class AppError extends Error {
	constructor(
		public readonly statusCode: HttpErrorStatus,
		public readonly code: string,
		message: string,
		public readonly expose = true,
		public readonly headers?: Record<string, string>
	) {
		super(message)
		this.name = 'AppError'
	}
}

export class NotFoundDomainError extends AppError {
	constructor(message = 'Resource not found', code = 'NOT_FOUND') {
		super(404, code, message, true)
	}
}

export class ConflictDomainError extends AppError {
	constructor(message = 'Resource conflict', code = 'CONFLICT') {
		super(409, code, message, true)
	}
}

export class UnauthorizedDomainError extends AppError {
	constructor(message = 'Unauthorized', code = 'UNAUTHORIZED') {
		super(401, code, message, true)
	}
}

export class ForbiddenDomainError extends AppError {
	constructor(message = 'Forbidden', code = 'FORBIDDEN') {
		super(403, code, message, true)
	}
}

function formatAppError(appErr: AppError, headers: Record<string, string | number>) {
	if (appErr.statusCode === 401 && !appErr.headers?.['www-authenticate']) {
		headers['www-authenticate'] = 'Bearer realm="relaybox"'
	}
	if (appErr.headers) {
		for (const [k, v] of Object.entries(appErr.headers)) {
			headers[k] = v
		}
	}
	const message = !env.IS_PRODUCTION || appErr.expose ? appErr.message : 'Internal server error'
	return status(appErr.statusCode, { error: message, code: appErr.code })
}

function formatCustomStatusError(customErr: ElysiaCustomStatusResponse<any, any, any>) {
	const code = typeof customErr.code === 'number' ? customErr.code : 500
	if (code >= 500) {
		console.error('[relaybox:error]', customErr.response)
		const response = env.IS_PRODUCTION
			? { error: 'Internal server error', code: 'INTERNAL_ERROR' }
			: customErr.response
		return status(code as HttpErrorStatus, response)
	}
	return status(code as HttpErrorStatus, customErr.response)
}

export const errorPlugin = new Elysia({ name: 'plugin:errors' })
	.error({ APP_ERROR: AppError })
	.onError({ as: 'global' }, ({ code, error, set }) => {
		if (code === 'APP_ERROR' || error instanceof AppError) {
			return formatAppError(error as AppError, set.headers)
		}

		if (error instanceof ElysiaCustomStatusResponse) {
			return formatCustomStatusError(error)
		}

		// Handle ValidationError by instance as well because Elysia WS errors omit context.code.
		if (code === 'VALIDATION' || error instanceof ValidationError) {
			const msg = error instanceof Error ? error.message : 'Validation failed'
			return status(422, {
				error: env.IS_PRODUCTION ? 'Validation failed' : msg,
				code: 'VALIDATION_ERROR'
			})
		}

		if (code === 'INVALID_FILE_TYPE') {
			return status(422, {
				error: 'Invalid file type',
				code: 'INVALID_FILE_TYPE'
			})
		}

		if (code === 'INVALID_COOKIE_SIGNATURE') {
			return status(400, {
				error: 'Invalid cookie signature',
				code: 'INVALID_COOKIE_SIGNATURE'
			})
		}

		if (code === 'PARSE') {
			if (error instanceof Error) {
				if (error.cause instanceof AppError) {
					return formatAppError(error.cause, set.headers)
				}
				if (error.cause instanceof ElysiaCustomStatusResponse) {
					return formatCustomStatusError(error.cause)
				}
			}
			return status(400, {
				error: env.IS_PRODUCTION ? 'Malformed request payload' : error.message,
				code: 'PARSE_ERROR'
			})
		}

		if (code === 'NOT_FOUND') {
			return status(404, { error: 'Route not found', code: 'NOT_FOUND' })
		}

		if (
			typeof error === 'object' &&
			error !== null &&
			'status' in error &&
			typeof (error as { status: unknown }).status === 'number'
		) {
			const numericStatus = (error as { status: number }).status
			if (numericStatus >= 400 && numericStatus < 500) {
				const msg =
					!env.IS_PRODUCTION && error instanceof Error ? error.message : 'Request rejected'
				return status(numericStatus as HttpErrorStatus, { error: msg, code: 'HTTP_ERROR' })
			}
		}

		console.error('[relaybox:error]', error)
		const detail =
			!env.IS_PRODUCTION && error instanceof Error ? error.message : 'Internal server error'
		return status(500, { error: detail, code: 'INTERNAL_ERROR' })
	})
