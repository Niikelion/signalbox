import { PassThrough } from "node:stream"
import { describe, expect, it, vi } from "vitest"
import { readMasked, stripOneTerminalNewline } from "../src/terminal.js"

describe("secure terminal input", () => {
    it("removes exactly one terminal newline", () => {
        expect(stripOneTerminalNewline("secret\n")).toBe("secret")
        expect(stripOneTerminalNewline("secret\r\n")).toBe("secret")
        expect(stripOneTerminalNewline("secret\n\n")).toBe("secret\n")
        expect(stripOneTerminalNewline(" secret ")).toBe(" secret ")
    })

    it("supports masked cursor insertion without echoing plaintext", async () => {
        const input = new PassThrough() as PassThrough & NodeJS.ReadStream
        Object.assign(input, { isTTY: true, isRaw: false, setRawMode: vi.fn() })
        const output = new PassThrough() as PassThrough & NodeJS.WriteStream
        Object.assign(output, { isTTY: true })
        let rendered = ""
        output.on("data", chunk => {
            rendered += chunk.toString("utf8")
        })

        const answer = readMasked("token: ", input, output)
        input.write("ac\u001B[Db\r")

        await expect(answer).resolves.toBe("abc")
        expect(rendered).not.toContain("abc")
        expect(rendered).toContain("***")
    })
})
