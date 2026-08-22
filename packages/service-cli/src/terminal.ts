import { readFile } from "node:fs/promises"
import { emitKeypressEvents, type Key } from "node:readline"
import { createInterface as createPromiseInterface } from "node:readline/promises"
import { SignalboxError } from "@signalbox/core"

export const stripOneTerminalNewline = (value: string): string => value.replace(/(?:\r\n|\n)$/u, "")

export const readStream = async (input: NodeJS.ReadableStream = process.stdin): Promise<string> => {
    const chunks: Buffer[] = []
    for await (const chunk of input as AsyncIterable<Buffer | string>) chunks.push(Buffer.from(chunk))
    return stripOneTerminalNewline(Buffer.concat(chunks).toString("utf8"))
}

export const readInputFile = async (path: string): Promise<string> =>
    stripOneTerminalNewline(await readFile(path, "utf8"))

export const readPlain = async (
    question: string,
    input: NodeJS.ReadableStream = process.stdin,
    output: NodeJS.WritableStream = process.stdout,
): Promise<string> => {
    const rl = createPromiseInterface({ input, output })
    try {
        return await rl.question(question)
    } finally {
        rl.close()
    }
}

const requireTty = (input: NodeJS.ReadStream): void => {
    if (!input.isTTY || typeof input.setRawMode !== "function") {
        throw new SignalboxError("masked input needs an interactive terminal", "use --stdin or --file instead")
    }
}

const rawKeys = <T>(
    input: NodeJS.ReadStream,
    output: NodeJS.WriteStream,
    onKey: (text: string, key: Key, finish: (value: T) => void, fail: (error: Error) => void) => void,
): Promise<T> => {
    requireTty(input)
    emitKeypressEvents(input)
    const wasRaw = input.isRaw
    input.setRawMode(true)
    input.resume()
    return new Promise<T>((resolve, reject) => {
        const cleanup = (): void => {
            input.off("keypress", listener)
            output.off("error", fail)
            input.setRawMode(wasRaw)
        }
        const finish = (value: T): void => {
            cleanup()
            resolve(value)
        }
        const fail = (error: Error): void => {
            cleanup()
            reject(error)
        }
        const listener = (text: string, key: Key): void => {
            onKey(text, key, finish, fail)
        }
        input.on("keypress", listener)
        output.once("error", fail)
    })
}

export const readMasked = async (
    question: string,
    input: NodeJS.ReadStream = process.stdin,
    output: NodeJS.WriteStream = process.stdout,
): Promise<string> => {
    const characters: string[] = []
    let cursor = 0
    const render = (): void => {
        const right = characters.length - cursor
        output.write(`\r\u001B[2K${question}${"*".repeat(characters.length)}${right > 0 ? `\u001B[${right}D` : ""}`)
    }
    render()
    return rawKeys<string>(input, output, (text, key, finish, fail) => {
        if (key.ctrl && key.name === "c") {
            output.write("\n")
            fail(new SignalboxError("input cancelled"))
            return
        }
        if (key.name === "return" || key.name === "enter") {
            output.write("\n")
            finish(characters.join(""))
            return
        }
        if (key.name === "left") cursor = Math.max(0, cursor - 1)
        else if (key.name === "right") cursor = Math.min(characters.length, cursor + 1)
        else if (key.name === "home") cursor = 0
        else if (key.name === "end") cursor = characters.length
        else if (key.name === "backspace" && cursor > 0) {
            characters.splice(cursor - 1, 1)
            cursor -= 1
        } else if (key.name === "delete" && cursor < characters.length) characters.splice(cursor, 1)
        else if (!key.ctrl && !key.meta && text && !text.startsWith("\u001B")) {
            const inserted = Array.from(text)
            characters.splice(cursor, 0, ...inserted)
            cursor += inserted.length
        }
        render()
    })
}

export const selectOption = async (
    question: string,
    options: readonly string[],
    initial = 0,
    input: NodeJS.ReadStream = process.stdin,
    output: NodeJS.WriteStream = process.stdout,
): Promise<number> => {
    if (options.length === 0) throw new Error("selectOption needs at least one option")
    let selected = Math.max(0, Math.min(options.length - 1, initial))
    const render = (): void => {
        output.write(`\r\u001B[2K${question} ${options[selected]}  (↑/↓, Enter)`)
    }
    render()
    return rawKeys<number>(input, output, (_text, key, finish, fail) => {
        if (key.ctrl && key.name === "c") {
            output.write("\n")
            fail(new SignalboxError("input cancelled"))
            return
        }
        if (key.name === "up") selected = (selected - 1 + options.length) % options.length
        else if (key.name === "down") selected = (selected + 1) % options.length
        else if (key.name === "return" || key.name === "enter") {
            output.write("\n")
            finish(selected)
            return
        }
        render()
    })
}
