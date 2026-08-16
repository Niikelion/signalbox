import { makeFlow, type Flow } from "./flow.js"

export type EventMap = Record<string, unknown>

export type Listener<TPayload> = (payload: TPayload) => void | Promise<void>

export type Unsubscribe = () => void

export interface ReadChannel<TEvents extends EventMap> {
    on<TKey extends keyof TEvents>(event: TKey, listener: Listener<TEvents[TKey]>): Unsubscribe
    once<TKey extends keyof TEvents>(event: TKey, listener: Listener<TEvents[TKey]>): Unsubscribe
    off<TKey extends keyof TEvents>(event: TKey, listener: Listener<TEvents[TKey]>): void
    flow<TKey extends keyof TEvents>(event: TKey): Flow<TEvents[TKey]>
}

export interface Channel<TEvents extends EventMap> extends ReadChannel<TEvents> {
    emit<TKey extends keyof TEvents>(event: TKey, payload: TEvents[TKey]): void
}

export interface Bus {
    channel<TEvents extends EventMap>(id: string): Channel<TEvents>
    pause(): void
    resume(): void
    clear(): void
    readonly paused: boolean
    readonly buffered: number
}

export interface BusOptions {
    paused?: boolean
    onListenerError?: (error: Error, channel: string, event: string) => void
}

interface QueuedEvent {
    channelId: string
    event: PropertyKey
    payload: unknown
}

export const createBus = (options: BusOptions = {}): Bus => {
    const channels = new Map<string, Map<PropertyKey, Set<Listener<never>>>>()
    const queue: QueuedEvent[] = []

    let paused = options.paused ?? false
    let flushing = false

    const report = (error: unknown, channelId: string, event: PropertyKey): void => {
        const normalized = error instanceof Error ? error : new Error(String(error))
        options.onListenerError?.(normalized, channelId, String(event))
    }

    const dispatch = (channelId: string, event: PropertyKey, payload: unknown): void => {
        const set = channels.get(channelId)?.get(event)
        if (!set) return

        for (const listener of [...set]) {
            try {
                const result = (listener as Listener<unknown>)(payload)
                if (result instanceof Promise) {
                    result.catch((error: unknown) => {
                        report(error, channelId, event)
                    })
                }
            } catch (error) {
                report(error, channelId, event)
            }
        }
    }

    const listenersFor = (channelId: string): Map<PropertyKey, Set<Listener<never>>> => {
        const existing = channels.get(channelId)
        if (existing) return existing
        const created = new Map<PropertyKey, Set<Listener<never>>>()
        channels.set(channelId, created)
        return created
    }

    const channel = <TEvents extends EventMap>(channelId: string): Channel<TEvents> => {
        const off = <TKey extends keyof TEvents>(event: TKey, listener: Listener<TEvents[TKey]>): void => {
            const map = channels.get(channelId)
            const set = map?.get(event)
            if (!set) return
            set.delete(listener)
            if (set.size === 0) map?.delete(event)
        }

        const on = <TKey extends keyof TEvents>(event: TKey, listener: Listener<TEvents[TKey]>): Unsubscribe => {
            const map = listenersFor(channelId)
            const set = map.get(event) ?? new Set<Listener<never>>()
            set.add(listener)
            map.set(event, set)
            return () => {
                off(event, listener)
            }
        }

        return {
            on,
            off,
            flow: (event) =>
                makeFlow((emit) => {
                    on(event, (payload) => {
                        emit(payload)
                    })
                }),
            once: (event, listener) => {
                const unsubscribe = on(event, (payload) => {
                    unsubscribe()
                    return listener(payload)
                })
                return unsubscribe
            },
            emit: (event, payload) => {
                if (paused) {
                    queue.push({ channelId, event: event, payload })
                    return
                }
                dispatch(channelId, event, payload)
            },
        }
    }

    return {
        channel,
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
                    dispatch(next.channelId, next.event, next.payload)
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
            channels.clear()
            queue.length = 0
        },
    }
}
