export type LogLevel = "info" | "warn" | "error"

export const FRAMEWORK_CHANNEL = "framework"

export type FrameworkEvents = {
    log: { level: LogLevel; message: string; scope?: string }
    error: { scope: string; error: Error }
}
