import { makeFlow, type Flow } from "@/flow"

/** An event map: event name → payload type. */
export type EventMap = Record<string, unknown>

/** The empty event map, for apps whose workflows own no app-level events. */
export type NoEvents = Record<string, never>

/**
 * An event listener.
 * @typeParam TPayload the event payload type
 */
export type Listener<TPayload> = (payload: TPayload) => void | Promise<void>

/** Cancels a subscription. */
export type Unsubscribe = () => void

/**
 * The read side of a typed channel.
 * @typeParam TEvents the channel's event map
 */
export interface ReadChannel<TEvents extends EventMap> {
    /**
     * Subscribe to an event.
     * @typeParam TKey the event name
     * @param event the event name
     * @param listener called with each payload
     * @returns an unsubscribe function
     */
    on<TKey extends keyof TEvents>(event: TKey, listener: Listener<TEvents[TKey]>): Unsubscribe
    /**
     * Subscribe to the next occurrence only.
     * @typeParam TKey the event name
     * @param event the event name
     * @param listener called once
     */
    once<TKey extends keyof TEvents>(event: TKey, listener: Listener<TEvents[TKey]>): Unsubscribe
    /**
     * Remove a specific listener.
     * @typeParam TKey the event name
     * @param event the event name
     * @param listener the listener to remove
     */
    off<TKey extends keyof TEvents>(event: TKey, listener: Listener<TEvents[TKey]>): void
    /**
     * Start a {@link Flow} from an event.
     * @typeParam TKey the event name
     * @param event the event name
     */
    flow<TKey extends keyof TEvents>(event: TKey): Flow<TEvents[TKey]>
}

/**
 * A typed channel: the read side plus `emit`.
 * @typeParam TEvents the channel's event map
 */
export interface Channel<TEvents extends EventMap> extends ReadChannel<TEvents> {
    /**
     * Emit an event.
     * @typeParam TKey the event name
     * @param event the event name
     * @param payload the payload
     */
    emit<TKey extends keyof TEvents>(event: TKey, payload: TEvents[TKey]): void
}

/** The runtime event bus: many typed channels over one ordered queue and pause/resume. */
export interface Bus {
    /**
     * Get a typed channel by id (created on first use).
     * @typeParam TEvents the channel's event map
     * @param id the channel id
     */
    channel<TEvents extends EventMap>(id: string): Channel<TEvents>
    /** Buffer emitted events instead of dispatching them. */
    pause(): void
    /** Resume dispatch, flushing buffered events in order. */
    resume(): void
    /** Remove all listeners and drop buffered events. */
    clear(): void
    /** Whether the bus is currently paused. */
    readonly paused: boolean
    /** Number of currently buffered events. */
    readonly buffered: number
}

/** Options for {@link createBus}. */
export interface BusOptions {
    /** Start paused (default false). */
    paused?: boolean
    /** Called when a listener throws or rejects. */
    onListenerError?: (error: Error, channel: string, event: string) => void
}

interface QueuedEvent {
    channelId: string
    event: PropertyKey
    payload: unknown
}

/**
 * Create an event bus.
 * @param options bus options
 */
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
            flow: event =>
                makeFlow(emit => {
                    on(event, payload => {
                        emit(payload)
                    })
                }),
            once: (event, listener) => {
                const unsubscribe = on(event, payload => {
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
