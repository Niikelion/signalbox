import { parseArgs } from "node:util"
import {
    describeOf,
    isRequired,
    isSecret,
    isSecretValue,
    Secret,
    type ConfigOf,
    type ConfigSchema,
    type ConfigStore,
    type InputOf,
    type JsonValue,
    type z,
} from "@signalbox/config"
import { SignalboxError, write } from "@signalbox/core"
import { FileKeyBackend, type KeyMaterial } from "@signalbox/secrets"
import { createServiceManager, type ServiceManager, type ServiceScope } from "./systemd.js"
import { readInputFile, readMasked, readPlain, readStream, selectOption } from "./terminal.js"

/** Something the `run` command can start â€” an app's `run()`. */
export interface Runnable {
    run: () => Promise<void>
}

/**
 * The descriptor a concrete app supplies to drive the shared service CLI.
 * @typeParam TSchema the app's Zod config schema
 */
export interface ServiceApp<TSchema extends ConfigSchema> {
    /** Binary/app name (config path, systemd unit, usage header). */
    appName: string
    /** One-line summary shown in `--help`. */
    tagline: string
    /** The config schema. */
    schema: TSchema
    /**
     * Build the config store.
     * @param path optional explicit config path
     */
    createStore: (path?: string) => ConfigStore<TSchema>
    /**
     * Build the runnable app from validated config (backs `run`).
     * @param config the validated config
     */
    createApp: (config: ConfigOf<TSchema>) => Runnable
    /**
     * Optional one-shot that applies state once and exits (backs `once`).
     * @param config the validated config
     */
    runOnce?: (config: ConfigOf<TSchema>) => Promise<unknown>
    /**
     * Optional inbound port to open from the gateway at `setup`.
     * @param config the (possibly partial) config
     */
    firewallPort?: (config: Partial<ConfigOf<TSchema>>) => number | undefined
}

const usage = (appName: string, tagline: string): string => `${appName} - ${tagline}

usage: ${appName} <command> [options]

lifecycle
  setup [--user]       install and start the systemd service
  teardown [--purge]   stop and remove it; --purge also drops the config
  --user               act on a per-user systemd unit instead of a system one (no root)
  start | stop | restart | status
  run                  run in the foreground (this is what systemd calls)
  once                 update the records a single time and exit

config
  config init          fill in the required values interactively
  config interactive   edit all fields, then Save or Discard
  config list          show the current values, secrets redacted
  config get <key>
  config reveal <key>  explicitly print one secret value
  config set <key> <value>             set a non-secret value
  config set <secret> [--stdin|--file] set a secret without argv exposure
  config unset <key>
  config rekey [--revoke-old]
  config keys list
  config keys prune <id...> [--yes]
  config path          print the config file location

options
  --config <path>      use a specific config file
  --stdin              read a secret value from standard input
  --file <path>        read a secret value from a UTF-8 file
  --revoke-old         delete the prior key after verified rekey
  --yes                confirm destructive non-interactive commands
  -h, --help           show this
`

const renderValue = (value: unknown): string => {
    if (Array.isArray(value)) return value.join(",")
    if (typeof value === "string") return value
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return value.toString()
    if (value === undefined || value === null) return ""
    return JSON.stringify(value)
}

interface ConfigCommandOptions {
    readonly file?: string
    readonly stdin: boolean
    readonly yes: boolean
    readonly revokeOld: boolean
    readonly scope: ServiceScope
    readonly service: ServiceManager
}

const confirm = async (question: string, yes: boolean): Promise<void> => {
    if (yes) return
    const answer = await readPlain(`${question} Type "yes" to continue: `)
    if (answer !== "yes") throw new SignalboxError("operation cancelled")
}

const keyMaterialsForService = async <TSchema extends ConfigSchema>(
    store: ConfigStore<TSchema>,
): Promise<{ readonly activeKeyId?: string; readonly materials: readonly KeyMaterial[] }> => {
    const inspection = await store.inspect()
    const referenced = Object.values(inspection.secrets)
        .map(secret => secret.keyId)
        .filter((keyId): keyId is string => keyId !== undefined)
    const inventory = await store.keyInventory()
    const keyIds = new Set([
        ...referenced,
        ...inventory.filter(item => item.state === "active" || item.state === "retired").map(item => item.id),
    ])
    const materials = await Promise.all([...keyIds].map(keyId => store.keyMaterial(keyId)))
    const activeKeyId = referenced[0] ?? inventory.find(item => item.state === "active")?.id
    return { ...(activeKeyId ? { activeKeyId } : {}), materials }
}

const removeFileFallbackKeys = async <TSchema extends ConfigSchema>(
    store: ConfigStore<TSchema>,
): Promise<readonly string[]> => {
    const backend = new FileKeyBackend({ configPath: store.path, warn: () => undefined })
    const removed: string[] = []
    for (const metadata of await backend.listKeys(store.appName)) {
        if (metadata.state === "staged") continue
        if (metadata.state === "active") await backend.retireKey(store.appName, metadata.id)
        await backend.deleteKey(store.appName, metadata.id)
        removed.push(metadata.id)
    }
    return removed
}

const sealForService = async <TSchema extends ConfigSchema>(
    store: ConfigStore<TSchema>,
    service: ServiceManager,
    scope: ServiceScope,
    watchPort?: number,
): Promise<void> => {
    const keys = await keyMaterialsForService(store)
    service.setupService({
        scope,
        configPath: store.path,
        ...(watchPort === undefined ? {} : { watchPort }),
        ...(keys.activeKeyId ? { activeKeyId: keys.activeKeyId } : {}),
        keys: keys.materials,
    })
    for (const material of keys.materials) {
        const verified = await store.keyMaterial(material.id)
        if (!Buffer.from(verified.key).equals(Buffer.from(material.key))) {
            throw new SignalboxError(`sealed credential ${material.id} failed config-store verification`)
        }
    }
    const removed = await removeFileFallbackKeys(store)
    if (removed.length > 0) write("info", `removed ${String(removed.length)} verified file-fallback key(s)`)
}

const validateStaged = (field: string, schema: z.ZodType, value: unknown): unknown => {
    const result = schema.safeParse(value)
    if (!result.success) {
        throw new SignalboxError(
            `invalid value for ${field}: ${result.error.issues.map(issue => issue.message).join(", ")}`,
        )
    }
    return result.data
}

const plaintextValues = <TSchema extends ConfigSchema>(values: Record<string, unknown>): Partial<InputOf<TSchema>> =>
    Object.fromEntries(
        Object.entries(values).map(([field, value]) => [field, isSecretValue(value) ? value.reveal() : value]),
    ) as Partial<InputOf<TSchema>>

const interactiveConfig = async <TSchema extends ConfigSchema>(store: ConfigStore<TSchema>): Promise<void> => {
    const shape = store.schema.shape as Record<string, z.ZodType>
    const fields = Object.entries(shape)
    const staged = (await store.readPartial()) as Record<string, unknown>
    let selected = 0
    for (;;) {
        const labels = fields.map(([field, schema]) => {
            const value = staged[field]
            const shown = isSecret(schema) && value !== undefined ? "[redacted]" : renderValue(value)
            return `${field}: ${shown || "(empty)"}`
        })
        labels.push("Save", "Discard")
        selected = await selectOption("config", labels, selected)
        if (selected === fields.length) {
            await store.save(plaintextValues<TSchema>(staged))
            write("info", `wrote ${store.path}`)
            return
        }
        if (selected === fields.length + 1) {
            write("info", "discarded config changes")
            return
        }
        const entry = fields[selected]
        if (!entry) continue
        const [field, schema] = entry
        const description = describeOf(schema)
        if (isSecret(schema)) {
            const raw = await readMasked(`${field}${description ? ` - ${description}` : ""}: `)
            const parsed = validateStaged(field, schema, store.coerce(field, raw))
            staged[field] = Secret.from(parsed as JsonValue)
        } else {
            const current = staged[field]
            const raw = await readPlain(`${field}${description ? ` - ${description}` : ""} [${renderValue(current)}]: `)
            if (raw !== "") staged[field] = validateStaged(field, schema, store.coerce(field, raw))
        }
    }
}

const configCommand = async <TSchema extends ConfigSchema>(
    store: ConfigStore<TSchema>,
    args: string[],
    options: ConfigCommandOptions,
): Promise<void> => {
    const shape = store.schema.shape as Record<string, z.ZodType>
    const fields = Object.entries(shape)

    const requireKey = (value: string | undefined): string => {
        if (value && value in shape) return value
        throw new SignalboxError(`unknown config key "${value ?? ""}"`, `known keys: ${Object.keys(shape).join(", ")}`)
    }

    const [action, key, ...rest] = args

    switch (action) {
        case "path":
            process.stdout.write(`${store.path}\n`)
            return

        case "list": {
            const inspection = await store.inspect()
            process.stdout.write(`${JSON.stringify(inspection.values, null, 4)}\n`)
            return
        }

        case "get": {
            if (!key) throw new SignalboxError("config get needs a key")
            requireKey(key)
            const value = (await store.inspect()).values[key]
            process.stdout.write(`${renderValue(value)}\n`)
            return
        }

        case "reveal": {
            if (!key) throw new SignalboxError("config reveal needs a key")
            const field = requireKey(key)
            const fieldSchema = shape[field]
            if (!fieldSchema) throw new SignalboxError(`unknown config key "${field}"`)
            if (!isSecret(fieldSchema)) {
                throw new SignalboxError(`config reveal accepts only secret fields; ${field} is not secret`)
            }
            const value = ((await store.load()) as Record<string, unknown>)[field]
            if (!isSecretValue(value)) throw new SignalboxError(`secret config field ${field} is absent`)
            process.stdout.write(`${renderValue(value.reveal())}\n`)
            return
        }

        case "set": {
            const field = requireKey(key)
            const fieldSchema = shape[field]
            if (!fieldSchema) throw new SignalboxError(`unknown config key "${field}"`)
            const secretField = isSecret(fieldSchema)
            if (secretField) {
                if (rest.length > 0) {
                    throw new SignalboxError(
                        `secret ${field} must not be passed as a positional argument`,
                        `use an interactive prompt, --stdin, or --file <path>`,
                    )
                }
                if (options.stdin && options.file) throw new SignalboxError("--stdin and --file are mutually exclusive")
                const raw = options.stdin
                    ? await readStream()
                    : options.file
                      ? await readInputFile(options.file)
                      : await readMasked(`${field}: `)
                await store.set(field, raw)
            } else {
                if (options.stdin || options.file) {
                    throw new SignalboxError("--stdin and --file are supported only for secret fields")
                }
                if (rest.length === 0) throw new SignalboxError("config set needs a key and a value")
                await store.set(field, rest.join(" "))
            }
            write("info", `set ${field} in ${store.path}`)
            return
        }

        case "unset": {
            const field = requireKey(key)
            await store.unset(field)
            write("info", `unset ${field} in ${store.path}`)
            return
        }

        case "rekey": {
            const installed = options.service.isInstalled(options.scope)
            const result = await store.rekey({
                revokeOld: options.revokeOld,
                ...(installed ? { verify: async () => sealForService(store, options.service, options.scope) } : {}),
            })
            if (installed) await removeFileFallbackKeys(store)
            if (installed && options.revokeOld) options.service.deleteSealedKeys(options.scope, result.oldKeyIds)
            write("info", `rekeyed config to ${result.newKeyId} using ${result.backend}`)
            if (result.externalKeyIds.length > 0 && !options.revokeOld) {
                write("info", `retained external key(s): ${result.externalKeyIds.join(", ")}`)
            }
            return
        }

        case "keys": {
            if (key === "list") {
                process.stdout.write(`${JSON.stringify(await store.keyInventory(), null, 4)}\n`)
                return
            }
            if (key === "prune") {
                if (rest.length === 0) throw new SignalboxError("config keys prune needs one or more key IDs")
                const inventory = await store.keyInventory()
                const selected = rest.map(keyId => {
                    const entries = inventory.filter(item => item.id === keyId)
                    if (entries.length === 0) throw new SignalboxError(`key ${keyId} was not found`)
                    if (entries.some(item => item.referenced || item.state !== "retired")) {
                        throw new SignalboxError(`key ${keyId} is referenced, active, or staged and cannot be pruned`)
                    }
                    return { keyId, entries }
                })
                await confirm(`Delete retired key(s) ${rest.join(", ")}?`, options.yes)
                const managed = selected
                    .filter(item => item.entries.some(entry => entry.managed))
                    .map(item => item.keyId)
                const sealed = selected
                    .filter(item => item.entries.some(entry => entry.backend === "systemd-creds"))
                    .map(item => item.keyId)
                if (managed.length > 0) await store.pruneKeys(managed)
                if (sealed.length > 0) options.service.deleteSealedKeys(options.scope, sealed)
                write("info", `pruned key(s): ${rest.join(", ")}`)
                return
            }
            throw new SignalboxError("config keys expects list or prune")
        }

        case "init": {
            const current = (await store.readPartial()) as Record<string, unknown>
            for (const [field, fieldSchema] of fields) {
                if (!isRequired(fieldSchema)) continue

                const existing = current[field]
                const shown =
                    isSecret(fieldSchema) && existing
                        ? "(set)"
                        : Array.isArray(existing)
                          ? existing.join(",")
                          : existing
                const suffix = existing !== undefined ? ` [${String(shown)}]` : ""
                const question = `${field} - ${describeOf(fieldSchema) ?? ""}${suffix}: `
                const answer = isSecret(fieldSchema) ? await readMasked(question) : await readPlain(question)
                if (answer) {
                    const parsed = validateStaged(field, fieldSchema, store.coerce(field, answer))
                    current[field] = isSecret(fieldSchema) ? Secret.from(parsed as JsonValue) : parsed
                }
            }
            await store.save(plaintextValues<TSchema>(current))
            write("info", `wrote ${store.path}`)
            return
        }

        case "interactive":
            await interactiveConfig(store)
            return

        default:
            throw new SignalboxError(
                `unknown config command "${action ?? ""}"`,
                "expected one of: init, interactive, list, get, reveal, set, unset, rekey, keys, path",
            )
    }
}

/**
 * Run the shared service CLI (config commands, systemd lifecycle, run/once) for one app.
 * @typeParam TSchema the app's Zod config schema
 * @param app the app descriptor
 * @param argv the CLI arguments (without node/script)
 */
export const runCli = async <TSchema extends ConfigSchema>(app: ServiceApp<TSchema>, argv: string[]): Promise<void> => {
    const { values, positionals } = parseArgs({
        args: argv,
        options: {
            config: { type: "string" },
            file: { type: "string" },
            stdin: { type: "boolean", default: false },
            purge: { type: "boolean", default: false },
            yes: { type: "boolean", default: false },
            "revoke-old": { type: "boolean", default: false },
            user: { type: "boolean", default: false },
            help: { type: "boolean", short: "h", default: false },
        },
        allowPositionals: true,
        strict: true,
    })

    const [command, ...rest] = positionals
    if (values.help || !command) {
        process.stdout.write(usage(app.appName, app.tagline))
        return
    }

    const scope: ServiceScope = values.user ? "user" : "system"
    const store = app.createStore(values.config)
    const service = createServiceManager(app.appName)

    switch (command) {
        case "config":
            await configCommand(store, rest, {
                ...(values.file ? { file: values.file } : {}),
                stdin: values.stdin,
                yes: values.yes,
                revokeOld: values["revoke-old"],
                scope,
                service,
            })
            return

        case "setup": {
            const config = await store.load()
            await sealForService(store, service, scope, app.firewallPort?.(config))
            return
        }

        case "teardown": {
            const partial = (await store.inspect()).values as Partial<ConfigOf<TSchema>>
            if (values.purge) {
                const inventory = await store.keyInventory()
                const targets = [store.path, ...inventory.map(item => `${item.backend}:${item.id}`)]
                await confirm(
                    `Purge config and managed keys?\n${targets.map(target => `  ${target}`).join("\n")}\n`,
                    values.yes,
                )
                await store.purge()
                service.purgeSealedCredentials(scope)
                const external = inventory
                    .filter(item => !item.managed && item.backend !== "systemd-creds")
                    .map(item => item.id)
                if (external.length > 0) {
                    write("warn", `external environment keys cannot be deleted: ${external.join(", ")}`)
                }
            }
            service.teardownService({
                scope,
                purge: values.purge,
                configPath: store.path,
                watchPort: app.firewallPort?.(partial),
            })
            return
        }

        case "start":
        case "stop":
        case "restart":
            service.controlService(scope, command)
            return

        case "status":
            process.stdout.write(service.serviceStatus(scope))
            return

        case "run": {
            const runnable = app.createApp(await store.load())
            await runnable.run()
            return
        }

        case "once": {
            if (!app.runOnce) {
                throw new SignalboxError(`${app.appName} does not support the once command`)
            }
            await app.runOnce(await store.load())
            return
        }

        default:
            throw new SignalboxError(`unknown command "${command}"`, "run with --help to see the available commands")
    }
}

/**
 * {@link runCli} over `process.argv`, with SignalboxError-aware error reporting and exit code.
 * @typeParam TSchema the app's Zod config schema
 * @param app the app descriptor
 */
export const runCliMain = async <TSchema extends ConfigSchema>(app: ServiceApp<TSchema>): Promise<void> => {
    try {
        await runCli(app, process.argv.slice(2))
    } catch (error) {
        if (error instanceof SignalboxError) {
            write("error", error.message)
            if (error.hint) write("error", `hint: ${error.hint}`)
        } else {
            write("error", error instanceof Error ? error.message : String(error))
        }
        process.exitCode = 1
    }
}
