import { randomBytes } from "node:crypto"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
    deriveKeyId,
    systemdActiveCredentialName,
    systemdCredentialName,
    systemdManifestName,
    SystemdCredentialKeySource,
} from "../src/index.js"

const directories: string[] = []
const temporaryDirectory = async (): Promise<string> => {
    const directory = await mkdtemp(join(tmpdir(), "signalbox-systemd-creds-"))
    directories.push(directory)
    return directory
}

afterEach(async () => {
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe("SystemdCredentialKeySource", () => {
    it("reads exact and active keys from a running service credential directory", async () => {
        const directory = await temporaryDirectory()
        const key = randomBytes(32)
        const id = deriveKeyId(key)
        await writeFile(join(directory, systemdActiveCredentialName("app")), id)
        await writeFile(join(directory, systemdCredentialName("app", id)), key)
        const source = new SystemdCredentialKeySource({ credentialDirectory: directory, archiveDirectories: [] })

        expect((await source.getKey("app"))?.id).toBe(id)
        expect(Array.from((await source.getKey("app", id))?.key ?? [])).toEqual(Array.from(key))
        expect(await source.getKey("app", deriveKeyId(randomBytes(32)))).toBeNull()
    })

    it("reads archive manifests and verifies decrypted key IDs", async () => {
        const directory = await temporaryDirectory()
        await mkdir(directory, { recursive: true })
        const key = randomBytes(32)
        const id = deriveKeyId(key)
        const credentialPath = join(directory, systemdCredentialName("app", id))
        await writeFile(credentialPath, "sealed")
        await writeFile(
            join(directory, systemdManifestName("app")),
            JSON.stringify({ version: 1, appName: "app", activeKeyId: id, keyIds: [id] }),
        )
        const decrypt = vi.fn(async () => key)
        const source = new SystemdCredentialKeySource({ archiveDirectories: [directory], decrypt })

        expect(await source.listKeyIds("app")).toEqual({ activeKeyId: id, keyIds: [id] })
        expect((await source.getKey("app"))?.id).toBe(id)
        expect(decrypt).toHaveBeenCalledWith(credentialPath)
    })
})
