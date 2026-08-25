import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { config, createConfigStore, field, type ConfigOf } from "@signalbox/config"
import { FileKeyBackend } from "@signalbox/secrets"
import { afterEach, describe, expect, it, vi } from "vitest"
import { runCli, type ServiceApp } from "../src/index"

const schema = config({ token: field().string().secret(), name: field().string() })
const directories: string[] = []

const fixture = async () => {
    const directory = await mkdtemp(join(tmpdir(), "service-cli-"))
    directories.push(directory)
    const configPath = join(directory, "config.json")
    const app: ServiceApp<typeof schema> = {
        appName: "cli-test",
        tagline: "test",
        schema,
        createStore: path => {
            const selected = path ?? configPath
            return createConfigStore({
                appName: "cli-test",
                schema,
                path: selected,
                keySource: new FileKeyBackend({ configPath: selected, warn: vi.fn() }),
            })
        },
        createApp: (_config: ConfigOf<typeof schema>) => ({ run: async () => undefined }),
    }
    return { app, configPath }
}

afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe("secure config commands", () => {
    it("rejects secret plaintext passed in argv", async () => {
        const { app, configPath } = await fixture()
        await expect(runCli(app, ["config", "set", "token", "leaked-value", "--config", configPath])).rejects.toThrow(
            "must not be passed as a positional argument",
        )
    })

    it("sets a secret from a file and reveals it only through the explicit command", async () => {
        const { app, configPath } = await fixture()
        const inputPath = join(configPath, "..", "token.txt")
        await writeFile(inputPath, "file-secret-value\n")
        await runCli(app, ["config", "set", "token", "--file", inputPath, "--config", configPath])
        await runCli(app, ["config", "set", "name", "example", "--config", configPath])

        const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
        await runCli(app, ["config", "get", "token", "--config", configPath])
        expect(String(output.mock.calls.at(-1)?.[0])).toBe("[redacted]\n")
        await runCli(app, ["config", "reveal", "token", "--config", configPath])
        expect(String(output.mock.calls.at(-1)?.[0])).toBe("file-secret-value\n")
    })

    it("rekeys an uninstalled config without invoking systemd", async () => {
        const { app, configPath } = await fixture()
        const store = app.createStore(configPath)
        await store.save({ token: "rotate-from-cli", name: "example" })
        const oldKeyId = (await store.inspect()).secrets["token"]?.keyId

        await runCli(app, ["config", "rekey", "--config", configPath])

        const updated = app.createStore(configPath)
        expect((await updated.load()).token.reveal()).toBe("rotate-from-cli")
        expect((await updated.inspect()).secrets["token"]?.keyId).not.toBe(oldKeyId)
    })
})
