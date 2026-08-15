import type { EventBus, EventMap } from "./bus.js"

export type LogLevel = "info" | "warn" | "error"

export type FrameworkEvents = {
    log: { level: LogLevel; message: string; scope?: string }
    error: { scope: string; error: Error }
    "app:started": { plugins: string[]; workflows: string[] }
    "app:stopping": { reason: string }
    "app:stopped": { reason: string }
}

export type AppBus<TEvents extends EventMap> = EventBus<TEvents & FrameworkEvents>
