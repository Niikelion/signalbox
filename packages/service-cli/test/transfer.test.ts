import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { config, createConfigStore, field } from "@signalbox/config"
import { FileKeyBackend } from "@signalbox/secrets"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
    createConfigTransferBundle,
    exportConfigTransfer,
    importConfigTransfer,
    type AgeRunner,
} from "../src/index"

const schema = config({ token: field().string().secret(), name: field().string() })
const directories: string[] = []

const storeAt = (appName: string, path: string) =>
    createConfigStore({
        appName,
        schema,
        path,
        keySource: new FileKeyBackend({ configPath: path, warn: vi.fn() }),
    })

class MemoryAge implements AgeRunner {
    plaintext = ""
    recipient: string | undefined
    identity: string | undefined

    async encrypt(
        plaintext: string,
        options: { readonly recipient?: string; readonly recipientsFile?: string },
    ): Promise<string> {
        this.plaintext = plaintext
        this.recipient = options.recipient
        return "-----BEGIN AGE ENCRYPTED FILE-----\ntest\n-----END AGE ENCRYPTED FILE-----\n"
    }

    async decrypt(_path: string, identity: string): Promise<string> {
        this.identity = identity
        return this.plaintext
    }
}

const fixture = async () => {
    const directory = await mkdtemp(join(tmpdir(), "config-transfer-"))
    directories.push(directory)
    return {
        source: storeAt("transfer-test", join(directory, "source", "config.json")),
        destination: storeAt("transfer-test", join(directory, "destination", "config.json")),
        output: join(directory, "transfer.age"),
    }
}

afterEach(async () => {
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe("config transfer", () => {
    it("imports through the destination store and re-encrypts secrets under its local key", async () => {
        const { source, destination, output } = await fixture()
        const age = new MemoryAge()
        await source.save({ token: "portable-secret", name: "instance one" })
        const sourceKeyId = (await source.inspect()).secrets["token"]?.keyId

        await exportConfigTransfer(source, {
            output,
            recipient: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest recipient",
            age,
        })
        await importConfigTransfer(destination, { input: output, identity: "protected-id_ed25519", age })

        expect(age.recipient?.startsWith("ssh-ed25519 ")).toBe(true)
        expect(age.identity).toBe("protected-id_ed25519")
        expect(await readFile(output, "utf8")).toContain("BEGIN AGE ENCRYPTED FILE")
        expect((await destination.load()).token.reveal()).toBe("portable-secret")
        expect((await destination.load()).name).toBe("instance one")
        const destinationInspection = await destination.inspect()
        expect(destinationInspection.secrets["token"]?.state).toBe("encrypted")
        expect(destinationInspection.secrets["token"]?.keyId).not.toBe(sourceKeyId)
        expect(await readFile(destination.path, "utf8")).not.toContain("portable-secret")
    })

    it("rejects a bundle created for a different app", async () => {
        const { source, output } = await fixture()
        const age = new MemoryAge()
        await source.save({ token: "portable-secret", name: "instance one" })
        age.plaintext = await createConfigTransferBundle(source, new Date("2026-08-23T00:00:00.000Z"))
        const other = storeAt("other-app", join(output, "..", "other", "config.json"))

        await expect(importConfigTransfer(other, { input: output, identity: "id", age })).rejects.toThrow(
            "belongs to transfer-test, not other-app",
        )
        expect(await other.exists()).toBe(false)
    })

    it("refuses to overwrite an existing export file", async () => {
        const { source, output } = await fixture()
        const age = new MemoryAge()
        await source.save({ token: "portable-secret", name: "instance one" })
        await writeFile(output, "keep-existing")

        await expect(
            exportConfigTransfer(source, { output, recipient: "age1recipient", age }),
        ).rejects.toThrow("refusing to overwrite")
        expect(await readFile(output, "utf8")).toBe("keep-existing")
    })

    it("requires exactly one recipient source", async () => {
        const { source, output } = await fixture()
        await source.save({ token: "portable-secret", name: "instance one" })

        await expect(
            exportConfigTransfer(source, {
                output,
                recipient: "age1recipient",
                recipientsFile: "recipients.txt",
                age: new MemoryAge(),
            }),
        ).rejects.toThrow("mutually exclusive")
    })
})
