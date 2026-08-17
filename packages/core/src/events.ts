/** Log severity. */
export type LogLevel = "info" | "warn" | "error"

/** The channel id the framework uses for its log/error events. */
export const FRAMEWORK_CHANNEL = "framework"

/** Built-in framework events, carried on the framework channel. */
export type FrameworkEvents = {
    /** A log line (surfaced via `ctx.log`). */
    log: { level: LogLevel; message: string; scope?: string }
    /** A scoped error (surfaced via `ctx.fail`). */
    error: { scope: string; error: Error }
}
