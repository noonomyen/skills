import type { UserRole } from '../../generated/prisma/client'
import { getPrisma } from '../../infra/db'

export interface PublicUserRecord {
	id: string
	email: string
	role: UserRole
	disabled: boolean
	createdAt: number
}

export interface AuthUserRecord extends PublicUserRecord {
	passwordHash: string
}

export interface SessionRecord {
	id: string
	userId: string
	revoked: boolean
	expiresAt: Date
}

const USER_PUBLIC_SELECT = {
	id: true,
	email: true,
	role: true,
	disabled: true,
	createdAt: true
} as const

const USER_AUTH_SELECT = {
	...USER_PUBLIC_SELECT,
	passwordHash: true
} as const

function toPublicUser(row: {
	id: string
	email: string
	role: UserRole
	disabled: boolean
	createdAt: Date
}): PublicUserRecord {
	return {
		id: row.id,
		email: row.email,
		role: row.role,
		disabled: row.disabled,
		createdAt: row.createdAt.getTime()
	}
}

export abstract class AuthRepository {
	static async createUser(input: {
		id: string
		email: string
		passwordHash: string
		role: UserRole
	}): Promise<void> {
		await getPrisma().user.create({
			data: {
				id: input.id,
				email: input.email,
				passwordHash: input.passwordHash,
				role: input.role
			}
		})
	}

	static async deleteUser(id: string): Promise<void> {
		await getPrisma().user.deleteMany({ where: { id } })
	}

	static async findAuthUserByEmail(email: string): Promise<AuthUserRecord | null> {
		const row = await getPrisma().user.findUnique({ where: { email }, select: USER_AUTH_SELECT })
		if (!row) return null
		return {
			...toPublicUser(row),
			passwordHash: row.passwordHash
		}
	}

	static async findPublicUserById(id: string): Promise<PublicUserRecord | null> {
		const row = await getPrisma().user.findUnique({ where: { id }, select: USER_PUBLIC_SELECT })
		return row ? toPublicUser(row) : null
	}

	static async createSession(input: {
		id: string
		userId: string
		userAgent: string
		ip: string
		expiresAt: Date
	}): Promise<void> {
		await getPrisma().session.create({
			data: {
				id: input.id,
				userId: input.userId,
				userAgent: input.userAgent,
				ip: input.ip,
				expiresAt: input.expiresAt
			}
		})
	}

	static async deleteSession(sessionId: string): Promise<void> {
		await getPrisma().session.deleteMany({ where: { id: sessionId } })
	}

	static async findSessionById(sessionId: string): Promise<SessionRecord | null> {
		return getPrisma().session.findUnique({
			where: { id: sessionId },
			select: { id: true, userId: true, revoked: true, expiresAt: true }
		})
	}

	static async revokeSession(sessionId: string): Promise<void> {
		await getPrisma().session.updateMany({
			where: { id: sessionId },
			data: { revoked: true }
		})
	}

	static async getStats(): Promise<{ users: number; activeSessions: number }> {
		const prisma = getPrisma()
		const now = new Date()
		const [users, activeSessions] = await Promise.all([
			prisma.user.count(),
			prisma.session.count({ where: { revoked: false, expiresAt: { gt: now } } })
		])
		return { users, activeSessions }
	}
}
