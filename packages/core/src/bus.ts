export type EventMap = Record<string, unknown>

export type Listener<TPayload> = (payload: TPayload) => void | Promise<void>

export type Unsubscribe = () => void

export interface EventBus<TEvents extends EventMap> {
    on<TKey extends keyof TEvents>(event: TKey, listener: Listener<TEvents[TKey]>): Unsubscribe
    once<TKey extends keyof TEvents>(event: TKey, listener: Listener<TEvents[TKey]>): Unsubscribe
    off<TKey extends keyof TEvents>(event: TKey, listener: Listener<TEvents[TKey]>): void
    emit<TKey extends keyof TEvents>(event: TKey, payload: TEvents[TKey]): void
    pause(): void
    resume(): void
    readonly paused: boolean
    readonly buffered: number
    clear(): void
}

export interface EventBusOptions {
    paused?: boolean
    onListenerError?: (error: Error, event: string) => void
}

interface QueuedEvent {
    event: PropertyKey
    payload: unknown
}

export const createEventBus = <TEvents extends EventMap>(options: EventBusOptions = {}): EventBus<TEvents> => {
    const listeners = new Map<keyof TEvents, Set<Listener<never>>>()
    const queue: QueuedEvent[] = []

    let paused = options.paused ?? false
    let flushing = false

    const report = (error: unknown, event: PropertyKey): void => {
        const normalized = error instanceof Error ? error : new Error(String(error))
        options.onListenerError?.(normalized, String(event))
    }

    const dispatch = (event: PropertyKey, payload: unknown): void => {
        const set = listeners.get(event as keyof TEvents)
        if (!set) return

        for (const listener of [...set]) {
            try {
                const result = (listener as Listener<unknown>)(payload)
                if (result instanceof Promise) {
                    result.catch((error: unknown) => {
                        report(error, event)
                    })
                }
            } catch (error) {
                report(error, event)
            }
        }
    }

    const off: EventBus<TEvents>["off"] = (event, listener) => {
        const set = listeners.get(event)
        if (!set) return

        set.delete(listener)
        if (set.size === 0) listeners.delete(event)
    }

    const on: EventBus<TEvents>["on"] = (event, listener) => {
        const set = listeners.get(event) ?? new Set<Listener<never>>()
        set.add(listener)
        listeners.set(event, set)

        return () => {
            off(event, listener)
        }
    }

    return {
        on,
        off,
        once: (event, listener) => {
            const unsubscribe = on(event, (payload) => {
                unsubscribe()
                return listener(payload)
            })
            return unsubscribe
        },
        emit: (event, payload) => {
            if (paused) {
                queue.push({ event, payload })
                return
            }
            dispatch(event, payload)
        },
        pause: () => {
            paused = true
        },
        resume: () => {
            if (!paused) return
            paused = false
            if (flushing) return

            flushing = true
            try {
                while (queue.length > 0) {
                    const next = queue.shift()
                    if (!next) break
                    dispatch(next.event, next.payload)
                }
            } finally {
                flushing = false
            }
        },
        get paused() {
            return paused
        },
        get buffered() {
            return queue.length
        },
        clear: () => {
            listeners.clear()
            queue.length = 0
        },
    }
}
