import { readFile } from "node:fs/promises"
import * as p from "@clack/prompts"
import { SignalboxError } from "@signalbox/core"

export const stripOneTerminalNewline = (value: string): string => value.replace(/(?:\r\n|\n)$/u, "")

export const readStream = async (input: NodeJS.ReadableStream = process.stdin): Promise<string> => {
    const chunks: Buffer[] = []
    for await (const chunk of input as AsyncIterable<Buffer | string>) chunks.push(Buffer.from(chunk))
    return stripOneTerminalNewline(Buffer.concat(chunks).toString("utf8"))
}

export const readInputFile = async (path: string): Promise<string> =>
    stripOneTerminalNewline(await readFile(path, "utf8"))

/** Turn a clack prompt result into a value, mapping a cancel (Ctrl-C/Esc) into a SignalboxError. */
const unwrap = <T>(value: T | symbol): T => {
    if (p.isCancel(value)) throw new SignalboxError("input cancelled")
    return value
}

const requireTty = (): void => {
    if (!process.stdin.isTTY) {
        throw new SignalboxError("interactive input needs a terminal", "use --stdin or --file instead")
    }
}

/**
 * Prompt for a line of plain text.
 * @param question the message to show
 * @param initial an optional value to pre-fill and edit
 */
export const readPlain = async (question: string, initial?: string): Promise<string> => {
    requireTty()
    return unwrap(
        await p.text({
            message: question,
            ...(initial !== undefined && initial !== "" ? { initialValue: initial } : {}),
        }),
    )
}

/**
 * Prompt for a secret without echoing it.
 * @param question the message to show
 */
export const readMasked = async (question: string): Promise<string> => {
    requireTty()
    return unwrap(await p.password({ message: question }))
}

/**
 * Ask a yes/no question.
 * @param question the message to show
 */
export const readConfirm = async (question: string): Promise<boolean> => {
    requireTty()
    return unwrap(await p.confirm({ message: question, initialValue: false }))
}

/**
 * Present a single-select list and return the chosen index.
 * @param question the message to show above the list
 * @param options the row labels, in order
 * @param initial the index highlighted first
 */
export const selectOption = async (question: string, options: readonly string[], initial = 0): Promise<number> => {
    if (options.length === 0) throw new Error("selectOption needs at least one option")
    requireTty()
    const bounded = Math.max(0, Math.min(options.length - 1, initial))
    return unwrap(
        await p.select({
            message: question,
            initialValue: bounded,
            options: options.map((label, index) => ({ value: index, label })),
        }),
    )
}
