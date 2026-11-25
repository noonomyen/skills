import { Elysia } from 'elysia'
import { BlockList, isIP } from 'node:net'
import { env } from '../env'

const REQUEST_ID_RE = /^[a-zA-Z0-9._-]{1,128}$/
const HEX_V4_TAIL_RE = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/

export function buildTrustedProxyBlockList(trustedProxies: readonly string[]): BlockList | null {
	if (trustedProxies.length === 0) return null
	const list = new BlockList()
	for (const entry of trustedProxies) {
		const trimmed = entry.trim().toLowerCase()
		if (!trimmed) continue
		const slashIdx = trimmed.indexOf('/')
		if (slashIdx !== -1) {
			const netAddr = trimmed.slice(0, slashIdx)
			const prefixRaw = trimmed.slice(slashIdx + 1)
			if (!/^\d+$/.test(prefixRaw)) {
				throw new RangeError(`Invalid CIDR prefix in trusted proxies: "${entry}"`)
			}
			const prefix = Number(prefixRaw)
			const ver = isIP(netAddr)
			if (ver === 4) {
				if (prefix < 0 || prefix > 32) {
					throw new RangeError(`IPv4 CIDR prefix must be between 0 and 32: "${entry}"`)
				}
				list.addSubnet(netAddr, prefix, 'ipv4')
			} else if (ver === 6) {
				if (prefix < 0 || prefix > 128) {
					throw new RangeError(`IPv6 CIDR prefix must be between 0 and 128: "${entry}"`)
				}
				if (netAddr.startsWith('::ffff:') && prefix >= 96) {
					const mappedV4 = normalizeIp(netAddr)
					if (isIP(mappedV4) === 4) {
						list.addSubnet(mappedV4, prefix - 96, 'ipv4')
						continue
					}
				}
				list.addSubnet(netAddr, prefix, 'ipv6')
			} else {
				throw new RangeError(`Invalid CIDR address in trusted proxies: "${entry}"`)
			}
			continue
		}
		const clean = normalizeIp(trimmed)
		const ver = isIP(clean)
		if (ver === 0) {
			throw new RangeError(`Invalid IP address in trusted proxies: "${entry}"`)
		}
		list.addAddress(clean, ver === 6 ? 'ipv6' : 'ipv4')
	}
	return list
}

const defaultTrustedProxyBlockList = buildTrustedProxyBlockList(env.TRUSTED_PROXY_LIST)

export function normalizeIp(raw: string | undefined): string {
	if (!raw) return 'unknown'
	let ip = raw.trim().toLowerCase()
	if (!ip) return 'unknown'

	if (ip.startsWith('[')) {
		const end = ip.indexOf(']')
		if (end === -1) return 'unknown'
		const rest = ip.slice(end + 1)
		if (rest.length > 0 && !/^:\d+$/.test(rest)) return 'unknown'
		ip = ip.slice(1, end)
	}

	const zoneIdx = ip.indexOf('%')
	if (zoneIdx !== -1) ip = ip.slice(0, zoneIdx)

	if (ip.startsWith('::ffff:')) {
		const tail = ip.slice(7)
		if (isIP(tail) === 4) {
			ip = tail
		} else {
			const hexMatch = HEX_V4_TAIL_RE.exec(tail)
			if (hexMatch) {
				const hi = parseInt(hexMatch[1]!, 16)
				const lo = parseInt(hexMatch[2]!, 16)
				ip = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
			}
		}
	}

	if (isIP(ip) === 0) {
		const firstColon = ip.indexOf(':')
		if (firstColon !== -1 && ip.indexOf(':', firstColon + 1) === -1) {
			ip = ip.slice(0, firstColon)
		}
	}

	return isIP(ip) !== 0 ? ip : 'unknown'
}

function isTrustedProxyIp(
	ip: string,
	trustedProxies: readonly string[] | BlockList
): boolean {
	if (ip === 'unknown') return false
	const ver = isIP(ip)
	if (ver === 0) return false
	if (trustedProxies instanceof BlockList) {
		return trustedProxies.check(ip, ver === 6 ? 'ipv6' : 'ipv4')
	}
	if (trustedProxies.length === 0) return false
	const built = buildTrustedProxyBlockList(trustedProxies)
	return built ? built.check(ip, ver === 6 ? 'ipv6' : 'ipv4') : false
}

export function resolveClientIp(
	request: Request,
	remoteAddress: string | undefined,
	trustedProxies: readonly string[] | BlockList = defaultTrustedProxyBlockList ?? []
): string {
	const peer = normalizeIp(remoteAddress)
	if (isTrustedProxyIp(peer, trustedProxies)) {
		const forwarded = request.headers.get('x-forwarded-for')
		if (forwarded !== null) {
			const hops = forwarded
				.split(',')
				.map((h) => normalizeIp(h))
				.filter((h) => h !== 'unknown')
			for (let i = hops.length - 1; i >= 0; i--) {
				const hop = hops[i]!
				if (!isTrustedProxyIp(hop, trustedProxies)) return hop
			}
			return peer
		}
		const realIp = request.headers.get('x-real-ip')
		if (realIp) {
			const normalized = normalizeIp(realIp)
			if (normalized !== 'unknown') return normalized
		}
	}
	return peer
}

function resolveExpectedScheme(request: Request): 'http:' | 'https:' {
	if (env.IS_PRODUCTION) return 'https:'
	const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
	if (proto === 'https' || proto === 'http') return `${proto}:`
	try {
		const reqProto = new URL(request.url).protocol
		return reqProto === 'https:' ? 'https:' : 'http:'
	} catch {
		return 'http:'
	}
}

function isAllowedOriginUrl(rawUrl: string, request: Request): boolean {
	let parsed: URL
	try {
		parsed = new URL(rawUrl)
	} catch {
		return false
	}

	if (parsed.protocol !== resolveExpectedScheme(request)) return false

	const candidateHost = parsed.host.toLowerCase()
	if (env.ALLOWED_HOST_LIST.length > 0) {
		return env.ALLOWED_HOST_LIST.includes(candidateHost)
	}
	const hostHeader = request.headers.get('host')?.toLowerCase()
	return hostHeader ? candidateHost === hostHeader : false
}

export function isTrustedOrigin(request: Request, requireExplicitOrigin = false): boolean {
	const secFetchSite = request.headers.get('sec-fetch-site')?.toLowerCase()
	if (secFetchSite === 'cross-site') return false

	const originHeader = request.headers.get('origin')
	if (originHeader) return isAllowedOriginUrl(originHeader, request)

	if (requireExplicitOrigin) return false

	const refererHeader = request.headers.get('referer')
	if (refererHeader) return isAllowedOriginUrl(refererHeader, request)

	return true
}

function buildSecurityHeaders(requestId: string): Record<string, string> {
	const out: Record<string, string> = {
		'x-content-type-options': 'nosniff',
		'referrer-policy': 'no-referrer',
		'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
		'x-request-id': requestId
	}
	if (env.IS_PRODUCTION) {
		out['strict-transport-security'] = 'max-age=31536000; includeSubDomains'
	}
	return out
}

export const securityPlugin = new Elysia({ name: 'plugin:security' })
	.decorate(
		'getClientIp',
		(request: Request, server: { requestIP(req: Request): { address: string } | null } | null) =>
			resolveClientIp(
				request,
				server?.requestIP(request)?.address,
				defaultTrustedProxyBlockList ?? []
			)
	)
	.onRequest(({ request, set }) => {
		const incomingId = request.headers.get('x-request-id')
		const reqId = incomingId && REQUEST_ID_RE.test(incomingId) ? incomingId : Bun.randomUUIDv7()
		const secHeaders = buildSecurityHeaders(reqId)

		if (env.ALLOWED_HOST_LIST.length > 0) {
			const hostHeader = request.headers.get('host')?.toLowerCase()
			if (!hostHeader) {
				return new Response(JSON.stringify({ error: 'Missing Host header', code: 'BAD_REQUEST' }), {
					status: 400,
					headers: { ...secHeaders, 'content-type': 'application/json' }
				})
			}
			if (!env.ALLOWED_HOST_LIST.includes(hostHeader)) {
				return new Response(JSON.stringify({ error: 'Host not allowed', code: 'FORBIDDEN_HOST' }), {
					status: 403,
					headers: { ...secHeaders, 'content-type': 'application/json' }
				})
			}
		}

		for (const [k, v] of Object.entries(secHeaders)) {
			set.headers[k] = v
		}
	})
