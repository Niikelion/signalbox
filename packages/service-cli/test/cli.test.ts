import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { config, createConfigStore, field, type ConfigOf } from "@signalbox/config"
import { FileKeyBackend } from "@signalbox/secrets"
import { afterEach, describe, expect, it, vi } from "vitest"
import { runCli, type ServiceAdapter, type ServiceApp } from "../src/index"

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
    it("awaits asynchronous app construction for run", async () => {
        const { app, configPath } = await fixture()
        const store = app.createStore(configPath)
        await store.save({ token: "runtime-secret", name: "runtime" })
        const run = vi.fn(async () => undefined)

        await runCli(
            {
                ...app,
                createApp: async () => {
                    await Promise.resolve()
                    return { run }
                },
            },
            ["run", "--config", configPath],
        )

        expect(run).toHaveBeenCalledOnce()
    })

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

    it("dispatches an app-supplied custom command with loaded config and args", async () => {
        const { app, configPath } = await fixture()
        const store = app.createStore(configPath)
        await store.save({ token: "runtime-secret", name: "runtime" })
        const run = vi.fn(async () => undefined)

        await runCli({ ...app, commands: { sync: { summary: "sync it", run } } }, ["sync", "now", "--config", configPath])

        expect(run).toHaveBeenCalledOnce()
        const context = run.mock.calls[0]?.[0] as { config: { name: string }; args: string[] }
        expect(context.config.name).toBe("runtime")
        expect(context.args).toEqual(["now"])
    })

    it("rejects a custom command that collides with a built-in", async () => {
        const { app, configPath } = await fixture()
        await expect(
            runCli(
                { ...app, commands: { run: { summary: "no", run: async () => undefined } } },
                ["status", "--config", configPath],
            ),
        ).rejects.toThrow("collides with a built-in")
    })

    it("lists custom commands in --help", async () => {
        const { app } = await fixture()
        const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
        await runCli({ ...app, commands: { sync: { summary: "sync it", run: async () => undefined } } }, ["--help"])
        expect(String(output.mock.calls.at(-1)?.[0])).toContain("sync it")
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

const makeAdapter = () => {
    const calls = {
        isInstalled: vi.fn(async () => false),
        setup: vi.fn(async () => undefined),
        teardown: vi.fn(async () => undefined),
        control: vi.fn(async () => undefined),
        status: vi.fn(async () => "SERVICE STATUS\n"),
        removeCredentials: vi.fn(async () => undefined),
        purgeCredentials: vi.fn(async () => undefined),
    }
    const adapter: ServiceAdapter<ConfigOf<typeof schema>> = {
        scopes: [
            { name: "system", description: "system-wide" },
            { name: "user", description: "per-user" },
        ],
        defaultScope: "system",
        ...calls,
    }
    return { adapter, calls }
}

describe("service adapter dispatch", () => {
    it("omits lifecycle commands from help when no adapter is supplied", async () => {
        const { app } = await fixture()
        const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
        await runCli(app, ["--help"])
        const help = output.mock.calls.map(call => String(call[0])).join("")
        expect(help).toContain("run")
        expect(help).not.toContain("setup")
        expect(help).not.toContain("teardown")
    })

    it("lists lifecycle commands in help when an adapter is supplied", async () => {
        const { app } = await fixture()
        const { adapter } = makeAdapter()
        const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
        await runCli(app, ["--help"], { service: adapter })
        const help = output.mock.calls.map(call => String(call[0])).join("")
        expect(help).toContain("setup")
        expect(help).toContain("status")
    })

    it("rejects lifecycle commands when no adapter is supplied", async () => {
        const { app, configPath } = await fixture()
        await expect(runCli(app, ["status", "--config", configPath])).rejects.toThrow()
    })

    it("selects the default scope when --scope is omitted", async () => {
        const { app, configPath } = await fixture()
        const { adapter, calls } = makeAdapter()
        await runCli(app, ["restart", "--config", configPath], { service: adapter })
        expect(calls.control).toHaveBeenCalledOnce()
        expect(calls.control.mock.calls[0]?.[0]).toMatchObject({ appName: "cli-test", scope: "system" })
        expect(calls.control.mock.calls[0]?.[1]).toBe("restart")
    })

    it("passes an explicit scope through to the adapter", async () => {
        const { app, configPath } = await fixture()
        const { adapter, calls } = makeAdapter()
        await runCli(app, ["status", "--scope", "user", "--config", configPath], { service: adapter })
        expect(calls.status).toHaveBeenCalledOnce()
        expect(calls.status.mock.calls[0]?.[0]).toMatchObject({ scope: "user" })
    })

    it("rejects an unknown scope before reaching the adapter", async () => {
        const { app, configPath } = await fixture()
        const { adapter, calls } = makeAdapter()
        await expect(
            runCli(app, ["status", "--scope", "bogus", "--config", configPath], { service: adapter }),
        ).rejects.toThrow("unknown scope")
        expect(calls.status).not.toHaveBeenCalled()
    })

    it("rejects invalid adapter metadata before dispatch", async () => {
        const { app, configPath } = await fixture()
        const { adapter, calls } = makeAdapter()
        await expect(
            runCli(app, ["status", "--config", configPath], { service: { ...adapter, defaultScope: "nope" } }),
        ).rejects.toThrow("defaultScope")
        expect(calls.status).not.toHaveBeenCalled()
    })

    it("prints status output verbatim through the adapter", async () => {
        const { app, configPath } = await fixture()
        const { adapter, calls } = makeAdapter()
        const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
        await runCli(app, ["status", "--config", configPath], { service: adapter })
        expect(calls.status).toHaveBeenCalledOnce()
        expect(output.mock.calls.map(call => String(call[0])).join("")).toContain("SERVICE STATUS")
    })

    it("propagates adapter setup failures", async () => {
        const { app, configPath } = await fixture()
        const store = app.createStore(configPath)
        await store.save({ token: "secret", name: "example" })
        const { adapter, calls } = makeAdapter()
        calls.setup.mockRejectedValueOnce(new Error("setup blew up"))
        await expect(runCli(app, ["setup", "--config", configPath], { service: adapter })).rejects.toThrow(
            "setup blew up",
        )
    })
})
