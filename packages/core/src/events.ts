import type { EventBus, EventMap } from "./bus.js"

export type LogLevel = "info" | "warn" | "error"

/** Events every FlowKit app gets for free, on top of whatever it declares itself. */
export type FrameworkEvents = {
    log: { level: LogLevel; message: string; scope?: string }
    error: { scope: string; error: Error }
    "app:started": { plugins: string[]; workflows: string[] }
    "app:stopping": { reason: string }
    "app:stopped": { reason: string }
}

/** The bus an app actually sees: its own events plus the framework's. */
export type AppBus<TEvents extends EventMap> = EventBus<TEvents & FrameworkEvents>
