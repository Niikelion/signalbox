import { spawn } from "node:child_process"
import { open, rm } from "node:fs/promises"
import { isSecretValue, type ConfigOf, type ConfigSchema, type ConfigStore, type InputOf } from "@signalbox/config"
import { SignalboxError } from "@signalbox/core"

const TRANSFER_FORMAT = "signalbox-config"
const TRANSFER_VERSION = 1
const MAX_TRANSFER_BYTES = 16 * 1024 * 1024

interface ConfigTransferBundle {
    readonly format: typeof TRANSFER_FORMAT
    readonly version: typeof TRANSFER_VERSION
    readonly appName: string
    readonly exportedAt: string
    readonly config: Record<string, unknown>
}

export interface AgeRunner {
    encrypt(
        plaintext: string,
        options: { readonly recipient?: string; readonly recipientsFile?: string },
    ): Promise<string>
    decrypt(path: string, identity: string): Promise<string>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)

const collectOutput = (stream: NodeJS.ReadableStream): Promise<Buffer> =>
    new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        let size = 0
        stream.on("data", (chunk: Buffer | string) => {
            const buffer = Buffer.from(chunk)
            size += buffer.length
            if (size > MAX_TRANSFER_BYTES) {
                reject(new SignalboxError(`age output exceeds ${String(MAX_TRANSFER_BYTES)} bytes`))
                return
            }
            chunks.push(buffer)
        })
        stream.once("end", () => {
            resolve(Buffer.concat(chunks))
        })
        stream.once("error", reject)
    })

const runAge = async (executable: string, args: readonly string[], input?: string): Promise<string> =>
    new Promise((resolve, reject) => {
        const child = spawn(executable, [...args], {
            stdio: [input === undefined ? "inherit" : "pipe", "pipe", "inherit"],
            windowsHide: true,
        })
        const stdout = child.stdout
        if (!stdout) {
            reject(new SignalboxError("cannot capture age output"))
            return
        }
        const output = collectOutput(stdout)
        child.once("error", error => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                reject(
                    new SignalboxError(
                        `age executable "${executable}" was not found`,
                        "install age from https://github.com/FiloSottile/age/releases or set SIGNALBOX_AGE_EXECUTABLE",
                    ),
                )
                return
            }
            reject(error)
        })
        child.once("close", code => {
            if (code !== 0) {
                reject(new SignalboxError(`age exited with code ${String(code)}`))
                return
            }
            void output.then(buffer => {
                resolve(buffer.toString("utf8"))
            }, reject)
        })
        if (input !== undefined) child.stdin?.end(input, "utf8")
    })

export const createAgeRunner = (executable = process.env["SIGNALBOX_AGE_EXECUTABLE"] ?? "age"): AgeRunner => ({
    encrypt: async (plaintext, options) => {
        const recipientArgs = options.recipient
            ? ["--recipient", options.recipient]
            : options.recipientsFile
              ? ["--recipients-file", options.recipientsFile]
              : []
        if (recipientArgs.length === 0) throw new SignalboxError("config export needs an age or SSH recipient")
        return runAge(executable, ["--encrypt", "--armor", ...recipientArgs], plaintext)
    },
    decrypt: async (path, identity) => runAge(executable, ["--decrypt", "--identity", identity, path]),
})

const plaintextConfig = <TSchema extends ConfigSchema>(config: ConfigOf<TSchema>): Record<string, unknown> =>
    Object.fromEntries(
        Object.entries(config as Record<string, unknown>).map(([field, value]) => [
            field,
            isSecretValue(value) ? value.reveal() : value,
        ]),
    )

export const createConfigTransferBundle = async <TSchema extends ConfigSchema>(
    store: ConfigStore<TSchema>,
    now: Date = new Date(),
): Promise<string> => {
    const bundle: ConfigTransferBundle = {
        format: TRANSFER_FORMAT,
        version: TRANSFER_VERSION,
        appName: store.appName,
        exportedAt: now.toISOString(),
        config: plaintextConfig(await store.load()),
    }
    return JSON.stringify(bundle)
}

const parseConfigTransferBundle = <TSchema extends ConfigSchema>(
    store: ConfigStore<TSchema>,
    plaintext: string,
): InputOf<TSchema> => {
    let parsed: unknown
    try {
        parsed = JSON.parse(plaintext)
    } catch {
        throw new SignalboxError("decrypted config transfer is not valid JSON")
    }
    if (!isRecord(parsed) || parsed["format"] !== TRANSFER_FORMAT || parsed["version"] !== TRANSFER_VERSION) {
        throw new SignalboxError("unsupported config transfer format or version")
    }
    const bundleAppName = parsed["appName"]
    if (typeof bundleAppName !== "string" || bundleAppName !== store.appName) {
        const source = typeof bundleAppName === "string" ? bundleAppName : "an unknown app"
        throw new SignalboxError(`config transfer belongs to ${source}, not ${store.appName}`)
    }
    const config = parsed["config"]
    if (!isRecord(config)) throw new SignalboxError("config transfer has no valid config object")
    const known = new Set(Object.keys(store.schema.shape))
    const unknown = Object.keys(config).filter(key => !known.has(key))
    if (unknown.length > 0) throw new SignalboxError(`config transfer contains unknown key(s): ${unknown.join(", ")}`)
    const result = store.schema.safeParse(config)
    if (!result.success) {
        const issues = result.error.issues.map(issue => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        throw new SignalboxError(`config transfer is invalid: ${issues.join("; ")}`)
    }
    return result.data as InputOf<TSchema>
}

const writeNewFile = async (path: string, content: () => Promise<string>): Promise<void> => {
    let created = false
    try {
        const handle = await open(path, "wx", 0o600)
        created = true
        try {
            await handle.writeFile(await content(), "utf8")
            await handle.sync()
        } finally {
            await handle.close()
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new SignalboxError(`refusing to overwrite existing transfer file ${path}`)
        }
        if (created) await rm(path, { force: true })
        throw error
    }
}

export const exportConfigTransfer = async <TSchema extends ConfigSchema>(
    store: ConfigStore<TSchema>,
    options: {
        readonly output: string
        readonly recipient?: string
        readonly recipientsFile?: string
        readonly age?: AgeRunner
    },
): Promise<void> => {
    if (options.recipient && options.recipientsFile) {
        throw new SignalboxError("--recipient and --recipients-file are mutually exclusive")
    }
    if (!options.recipient && !options.recipientsFile) {
        throw new SignalboxError("config export needs --recipient or --recipients-file")
    }
    await writeNewFile(options.output, async () => {
        const plaintext = await createConfigTransferBundle(store)
        return (options.age ?? createAgeRunner()).encrypt(plaintext, {
            ...(options.recipient ? { recipient: options.recipient } : {}),
            ...(options.recipientsFile ? { recipientsFile: options.recipientsFile } : {}),
        })
    })
}

export const importConfigTransfer = async <TSchema extends ConfigSchema>(
    store: ConfigStore<TSchema>,
    options: { readonly input: string; readonly identity: string; readonly age?: AgeRunner },
): Promise<void> => {
    const plaintext = await (options.age ?? createAgeRunner()).decrypt(options.input, options.identity)
    await store.save(parseConfigTransferBundle(store, plaintext))
}
