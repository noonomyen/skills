import { CryptoHasher } from 'bun'
import { getCacheStore } from '../src/infra/cache'

export function signWebhook(input: {
	workspaceId: string
	bodyText: string
	secret: string
	ts?: number
	method?: string
	path?: string
}) {
	const method = input.method ?? 'POST'
	const path = input.path ?? `/api/webhooks/ingest/${input.workspaceId}`
	const ts = input.ts ?? Math.floor(Date.now() / 1000)
	const hex = new CryptoHasher('sha256', input.secret)
		.update(`${method}\n${path}\n${input.workspaceId}\n${ts}.`)
		.update(input.bodyText)
		.digest('hex')
	return { ts: String(ts), sig: `sha256=${hex}` }
}

export async function registerAndCreateWorkspace(
	app: { handle(req: Request): Response | Promise<Response> },
	emailPrefix: string,
	workspaceId?: string
): Promise<{
	userId: string
	email: string
	accessToken: string
	refreshToken: string
	workspaceId: string
	webhookSecret: string
}> {
	const bucket = Math.floor(Math.floor(Date.now() / 1000) / 60)
	await getCacheStore().del(`rl:auth-register:unknown:${bucket}`)

	const email = `${emailPrefix}-${Bun.randomUUIDv7()}@example.com`
	const reg = await app.handle(
		new Request('http://localhost/api/auth/register', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ email, password: 'Password123!' })
		})
	)
	if (reg.status !== 201) {
		throw new Error(`Fixture register failed (${reg.status}): ${await reg.text()}`)
	}
	const regData = (await reg.json()) as {
		accessToken: string
		refreshToken: string
		user: { id: string }
	}
	const wsRes = await app.handle(
		new Request('http://localhost/api/workspaces', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${regData.accessToken}`
			},
			body: JSON.stringify({
				id: workspaceId ?? `ws-${Bun.randomUUIDv7().slice(0, 12)}`,
				name: 'Test Workspace'
			})
		})
	)
	if (wsRes.status !== 201) {
		throw new Error(`Fixture workspace creation failed (${wsRes.status}): ${await wsRes.text()}`)
	}
	const wsData = (await wsRes.json()) as { id: string; webhookSecret: string }
	return {
		userId: regData.user.id,
		email,
		accessToken: regData.accessToken,
		refreshToken: regData.refreshToken,
		workspaceId: wsData.id,
		webhookSecret: wsData.webhookSecret
	}
}
