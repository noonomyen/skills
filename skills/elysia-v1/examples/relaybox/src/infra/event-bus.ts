export interface WorkspaceEvent {
	id: string
	workspaceId: string
	source: string
	eventType: string
	payload: unknown
	deliveryStatus: string
	createdAt: number
}

type Listener = (event: WorkspaceEvent) => void

class WorkspaceEventBus {
	private readonly listeners = new Map<string, Set<Listener>>()

	subscribe(workspaceId: string, listener: Listener): () => void {
		let set = this.listeners.get(workspaceId)
		if (!set) {
			set = new Set()
			this.listeners.set(workspaceId, set)
		}
		set.add(listener)

		return () => {
			const current = this.listeners.get(workspaceId)
			if (!current) return
			current.delete(listener)
			if (current.size === 0) this.listeners.delete(workspaceId)
		}
	}

	publish(event: WorkspaceEvent): void {
		const set = this.listeners.get(event.workspaceId)
		if (!set) return
		for (const listener of [...set]) {
			try {
				listener(event)
			} catch (err) {
				console.error('WorkspaceEventBus listener failed:', err)
			}
		}
	}
}

export const eventBus = new WorkspaceEventBus()
