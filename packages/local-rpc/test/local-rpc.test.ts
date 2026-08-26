import { execFile } from "node:child_process"
import { chmod, mkdtemp, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { createApp, type NoEvents } from "@signalbox/core"
import { createPermissionExecution, entityRef } from "@signalbox/permissions"
import { afterEach, describe, expect, it } from "vitest"
import { z } from "zod"
import {
    createLocalRpcClient,
    defineLocalRpcMethod,
    localRpcPlugin,
    LocalRpcError,
    type LocalRpcPeer,
} from "../src/index"

const linuxIt = process.platform === "linux" ? it : it.skip
const linuxRootIt = process.platform === "linux" && process.getuid?.() === 0 ? it : it.skip
const execFileAsync = promisify(execFile)
const apps: Array<{ stop: () => Promise<void> }> = []

const testPermissions = () => {
    const permissions = createPermissionExecution()
    return {
        runtime: permissions.runtime,
        core: permissions.core,
        host: permissions.identities.issue({ principal: entityRef("system", "local-rpc-test") }),
    }
}

afterEach(async () => {
    await Promise.all(apps.splice(0).map(app => app.stop()))
})

describe("local RPC plugin", () => {
    linuxIt("should serve typed calls with kernel peer identity", async () => {
        const directory = await mkdtemp(join(tmpdir(), "signalbox-local-rpc-"))
        const socketPath = join(directory, "rpc.sock")
        const echo = defineLocalRpcMethod({
            method: "test.echo",
            request: z.object({ value: z.string() }),
            response: z.object({ value: z.string(), uid: z.number(), idempotencyKey: z.string().optional() }),
        })
        let observedPeer: LocalRpcPeer | undefined
        const rpc = localRpcPlugin({ socketPath, mode: 0o660 })
        rpc.route(echo, (input, context) => {
            observedPeer = context.peer
            return { ...input, uid: context.peer.uid, idempotencyKey: context.idempotencyKey }
        })
        const app = createApp<NoEvents, { rpc: typeof rpc }>({
            name: "local-rpc-test",
            permissions: testPermissions(),
            logging: false,
            plugins: { rpc },
            workflows: [],
        })
        apps.push(app)
        await app.start()

        const result = await createLocalRpcClient({ socketPath }).call(echo, { value: "hello" }, {
            idempotencyKey: "operation-1",
        })

        expect(result).toEqual({ value: "hello", uid: process.getuid?.(), idempotencyKey: "operation-1" })
        expect(observedPeer?.uid).toBe(process.getuid?.())
        expect(observedPeer?.gid).toBe(process.getgid?.())
        expect(observedPeer?.pid).toBe(process.pid)
        expect(observedPeer?.supplementaryGids).toContain(process.getgid?.())
        expect((await stat(socketPath)).mode & 0o777).toBe(0o660)

        await app.stop()
        apps.splice(apps.indexOf(app), 1)
        await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" })
    })

    linuxIt("should return structured handler errors", async () => {
        const directory = await mkdtemp(join(tmpdir(), "signalbox-local-rpc-"))
        const socketPath = join(directory, "rpc.sock")
        const denied = defineLocalRpcMethod({
            method: "test.denied",
            request: z.object({}),
            response: z.object({ ok: z.boolean() }),
        })
        const rpc = localRpcPlugin({ socketPath })
        rpc.route(denied, () => {
            throw new LocalRpcError("DENIED", "caller is not allowed", { retryable: false })
        })
        const app = createApp<NoEvents, { rpc: typeof rpc }>({
            name: "local-rpc-errors",
            permissions: testPermissions(),
            logging: false,
            plugins: { rpc },
            workflows: [],
        })
        apps.push(app)
        await app.start()

        await expect(createLocalRpcClient({ socketPath }).call(denied, {})).rejects.toMatchObject({
            code: "DENIED",
            message: "caller is not allowed",
            retryable: false,
        })
    })

    linuxRootIt("should reject a caller outside the socket group", async () => {
        const directory = await mkdtemp(join(tmpdir(), "signalbox-local-rpc-"))
        await chmod(directory, 0o755)
        const socketPath = join(directory, "rpc.sock")
        const ping = defineLocalRpcMethod({
            method: "test.ping",
            request: z.object({}),
            response: z.object({ ok: z.boolean() }),
        })
        const rpc = localRpcPlugin({ socketPath, owner: 0, group: 0, mode: 0o660 })
        rpc.route(ping, () => ({ ok: true }))
        const app = createApp<NoEvents, { rpc: typeof rpc }>({
            name: "local-rpc-permissions",
            permissions: testPermissions(),
            logging: false,
            plugins: { rpc },
            workflows: [],
        })
        apps.push(app)
        await app.start()

        const probe = `
            const net = require("node:net")
            const socket = net.createConnection(process.argv[1])
            socket.once("connect", () => process.exit(2))
            socket.once("error", error => process.exit(error.code === "EACCES" ? 0 : 3))
        `
        await expect(
            execFileAsync("setpriv", [
                "--reuid=65534",
                "--regid=65534",
                "--clear-groups",
                process.execPath,
                "-e",
                probe,
                socketPath,
            ]),
        ).resolves.toBeDefined()
    })

    it("should reject duplicate method registrations", () => {
        const method = defineLocalRpcMethod({
            method: "test.duplicate",
            request: z.object({}),
            response: z.object({}),
        })
        const rpc = localRpcPlugin({ socketPath: "/tmp/unused.sock" })
        rpc.route(method, input => input)

        expect(() => rpc.route(method, input => input)).toThrow("registered twice")
    })
})
