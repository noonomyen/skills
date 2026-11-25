import cluster, { type Worker } from 'node:cluster'
import os from 'node:os'
import { parseArgs } from 'node:util'
import { createCoreService } from './apps/core-service'
import { createIngestService } from './apps/ingest-service'
import { createMonolithApp } from './apps/monolith'
import { env } from './env'
import { shutdownInfra, startInfra } from './infra/lifecycle'

const { values } = parseArgs({
	args: Bun.argv.slice(2),
	options: {
		service: { type: 'string', default: 'monolith' },
		precompile: { type: 'boolean', default: false },
		cluster: { type: 'boolean', default: false },
		routes: { type: 'boolean', default: false },
		'no-audit': { type: 'boolean', default: false }
	},
	strict: true
})

const enableAudit = !values['no-audit']
const precompile = env.IS_PRODUCTION || values.precompile

function selectApp() {
	switch (values.service) {
		case 'monolith':
			return createMonolithApp({ precompile, enableAudit })
		case 'ingest':
			return createIngestService({ precompile, enableAudit })
		case 'core':
			return createCoreService({ precompile, enableAudit })
		default:
			throw new Error(`Unknown --service "${values.service}". Expected monolith, ingest, or core.`)
	}
}

if (values.routes) {
	const instance = selectApp()
	console.log(`Registered ${instance.routes.length} routes:`)
	for (const route of instance.routes) {
		console.log(`  ${route.method} ${route.path}`)
	}
	process.exit(0)
}

if (values.cluster && cluster.isPrimary) {
	const workers = os.availableParallelism()
	const activeWorkers = new Set<Worker>()
	let stoppingCluster = false

	for (let i = 0; i < workers; i++) {
		const w = cluster.fork()
		activeWorkers.add(w)
	}

	cluster.on('exit', (worker, code, signal) => {
		activeWorkers.delete(worker)
		if (!stoppingCluster && signal !== 'SIGTERM' && signal !== 'SIGINT' && code !== 0) {
			console.error(`Worker ${worker.process.pid} exited unexpectedly (code=${code})`)
			process.exitCode = 1
		}
		if (activeWorkers.size === 0 && stoppingCluster) {
			process.exit(process.exitCode ?? 0)
		}
	})

	const stopCluster = () => {
		if (stoppingCluster) return
		stoppingCluster = true
		for (const w of activeWorkers) w.kill('SIGTERM')
		setTimeout(() => process.exit(1), 5000).unref?.()
	}
	process.on('SIGINT', stopCluster)
	process.on('SIGTERM', stopCluster)
} else {
	await startInfra(enableAudit)
	const instance = selectApp()
	let shuttingDown = false

	const shutdown = async () => {
		if (shuttingDown) return
		shuttingDown = true

		const hardExitTimer = setTimeout(() => {
			void instance.stop(true).finally(() => process.exit(1))
		}, 10_000)
		hardExitTimer.unref?.()

		const forceHttpTimer = setTimeout(() => {
			void instance.stop(true)
		}, 5000)
		forceHttpTimer.unref?.()

		let exitCode = 0
		try {
			await instance.stop()
		} catch (err) {
			console.error('HTTP stop failed:', err)
			exitCode = 1
		} finally {
			clearTimeout(forceHttpTimer)
			try {
				await shutdownInfra(enableAudit)
			} catch (err) {
				console.error('Infra shutdown failed:', err)
				exitCode = 1
			} finally {
				clearTimeout(hardExitTimer)
			}
		}
		process.exit(exitCode)
	}

	process.on('SIGINT', () => void shutdown())
	process.on('SIGTERM', () => void shutdown())

	instance.listen(
		{
			hostname: env.HOST,
			port: env.PORT,
			reusePort: values.cluster && process.platform === 'linux',
			development: !env.IS_PRODUCTION
		},
		(server) => {
			console.log(`RelayBox (${values.service}) listening on ${server.url} (pid=${process.pid})`)
		}
	)
}
