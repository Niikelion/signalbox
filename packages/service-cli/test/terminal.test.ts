import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it } from "vitest"
import { readInputFile, readStream, stripOneTerminalNewline } from "../src/terminal"

const directories: string[] = []

afterEach(async () => {
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe("secure terminal input", () => {
    it("removes exactly one terminal newline", () => {
        expect(stripOneTerminalNewline("secret\n")).toBe("secret")
        expect(stripOneTerminalNewline("secret\r\n")).toBe("secret")
        expect(stripOneTerminalNewline("secret\n\n")).toBe("secret\n")
        expect(stripOneTerminalNewline(" secret ")).toBe(" secret ")
    })

    it("reads a secret from a stream and strips one trailing newline", async () => {
        const input = new PassThrough()
        input.end("stream-secret\n")
        expect(await readStream(input)).toBe("stream-secret")
    })

    it("reads a secret from a UTF-8 file and strips one trailing newline", async () => {
        const directory = await mkdtemp(join(tmpdir(), "terminal-"))
        directories.push(directory)
        const path = join(directory, "secret.txt")
        await writeFile(path, "file-secret\n")
        expect(await readInputFile(path)).toBe("file-secret")
    })
})
