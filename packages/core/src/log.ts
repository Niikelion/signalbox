import type { ReadChannel } from "./bus.js"
import type { FrameworkEvents, LogLevel } from "./events.js"

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

export const write = (level: LogLevel, message: string): void => {
    const line = `${stamp()}  ${message}\n`
    if (level === "error") process.stderr.write(line)
    else process.stdout.write(line)
}

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
