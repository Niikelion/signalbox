import type { EventMap } from "./bus.js"
import type { AppBus, LogLevel } from "./events.js"

export class FlowKitError extends Error {
    constructor(
        message: string,
        readonly hint?: string,
    ) {
        super(message)
        this.name = "FlowKitError"
    }
}

export const toError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)))

const stamp = (): string => new Date().toISOString().replace("T", " ").slice(0, 19)

/** Timestamped write to stdout/stderr. Under systemd this lands in the journal. */
export const write = (level: LogLevel, message: string): void => {
    const line = `${stamp()}  ${message}\n`
    if (level === "error") process.stderr.write(line)
    else process.stdout.write(line)
}

/** Print every `log` and `error` event the bus carries. Returns an unsubscribe. */
export const attachConsoleLogger = <TEvents extends EventMap>(bus: AppBus<TEvents>): (() => void) => {
    const offLog = bus.on("log", ({ level, message, scope }) => {
        write(level, scope ? `[${scope}] ${message}` : message)
    })
    const offError = bus.on("error", ({ scope, error }) => {
        write("error", `[${scope}] ${error.message}`)
    })

    return () => {
        offLog()
        offError()
    }
}
