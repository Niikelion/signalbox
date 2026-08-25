import { redact } from "@signalbox/secrets"
import type { ReadChannel } from "./bus"
import type { FrameworkEvents, LogLevel } from "./events"

/** An error carrying an optional user-facing hint (shown by the CLI). */
export class SignalboxError extends Error {
    /**
     * @param message the error message
     * @param hint an optional actionable hint
     */
    constructor(
        message: string,
        readonly hint?: string,
    ) {
        super(message)
        this.name = "SignalboxError"
    }
}

/**
 * Coerce any thrown value into an Error.
 * @param value the thrown value
 */
export const toError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)))

/** Coerce a thrown value into an Error and return a sanitized copy. */
export const sanitizeError = (value: unknown): Error => redact(toError(value))

const stamp = (): string => new Date().toISOString().replace("T", " ").slice(0, 19)

/**
 * Write a timestamped line to stdout (or stderr for errors).
 * @param level severity
 * @param message the message
 */
export const write = (level: LogLevel, message: string): void => {
    const line = `${stamp()}  ${redact(message)}\n`
    if (level === "error") process.stderr.write(line)
    else process.stdout.write(line)
}

/**
 * Subscribe a console logger to a framework channel.
 * @param channel the framework log/error channel
 * @returns a function that detaches the logger
 */
export const attachConsoleLogger = (channel: ReadChannel<FrameworkEvents>): (() => void) => {
    const offLog = channel.on("log", ({ level, message, scope }) => {
        write(level, scope ? `[${scope}] ${message}` : message)
    })
    const offError = channel.on("error", ({ scope, error }) => {
        write("error", `[${scope}] ${error.message}`)
    })

    return () => {
        offLog()
        offError()
    }
}
