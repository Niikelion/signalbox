import { Command, CommanderError } from "commander"
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
import { createServiceManager, type ServiceManager, type ServiceScope, type SystemServiceProfile } from "./systemd"
import { readInputFile, readMasked, readPlain, readStream, selectOption } from "./terminal"
import { exportConfigTransfer, importConfigTransfer } from "./transfer"

/** Something the `run` command can start â€” an app's `run()`. */
export interface Runnable {
    run: () => Promise<void>
}

/**
 * What an app-supplied custom command receives when it runs.
 * @typeParam TSchema the app's Zod config schema
 */
export interface ServiceCommandContext<TSchema extends ConfigSchema> {
    /** The validated config, loaded from the store. */
    config: ConfigOf<TSchema>
    /** The config store, for commands that need to write or inspect it. */
    store: ConfigStore<TSchema>
    /** Positional arguments that followed the command name. */
    args: string[]
}

/**
 * An app-supplied command added to the shared CLI alongside the built-ins.
 * @typeParam TSchema the app's Zod config schema
 */
export interface ServiceCommand<TSchema extends ConfigSchema> {
    /** One-line summary shown in `--help`. */
    summary: string
    /**
     * Run the command.
     * @param context the loaded config, store, and positional arguments
     */
    run: (context: ServiceCommandContext<TSchema>) => Promise<void>
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
    createApp: (config: ConfigOf<TSchema>) => Runnable | Promise<Runnable>
    /**
     * Optional app-supplied commands, keyed by command name, added to the
     * built-in commands. Names that collide with a built-in are rejected.
     */
    commands?: Record<string, ServiceCommand<TSchema>>
    /**
     * Optional inbound port to open from the gateway at `setup`.
     * @param config the (possibly partial) config
     */
    firewallPort?: (config: Partial<ConfigOf<TSchema>>) => number | undefined
    /** Narrow customizations for the generated systemd service. */
    systemService?: SystemServiceProfile
}

const BUILTIN_COMMANDS = ["config", "setup", "teardown", "start", "stop", "restart", "status", "run"] as const

const renderValue = (value: unknown): string => {
    if (Array.isArray(value)) return value.join(",")
    if (typeof value === "string") return value
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return value.toString()
    if (value === undefined || value === null) return ""
    return JSON.stringify(value)
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

const initConfig = async <TSchema extends ConfigSchema>(store: ConfigStore<TSchema>): Promise<void> => {
    const fields = Object.entries(store.schema.shape as Record<string, z.ZodType>)
    const current = (await store.readPartial()) as Record<string, unknown>
    for (const [field, fieldSchema] of fields) {
        if (!isRequired(fieldSchema)) continue
        const existing = current[field]
        const shown =
            isSecret(fieldSchema) && existing ? "(set)" : Array.isArray(existing) ? existing.join(",") : existing
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
}

/** Global options that every leaf command accepts, so they may appear after the command name. */
interface GlobalOptions {
    readonly config?: string
    readonly user?: boolean
}

/**
 * Build the commander program for one app: global options, systemd lifecycle,
 * the `config` command group, `run`, and any app-supplied custom commands.
 */
const buildProgram = <TSchema extends ConfigSchema>(
    app: ServiceApp<TSchema>,
    commands: Record<string, ServiceCommand<TSchema>>,
): Command => {
    const program = new Command()
    // Throw instead of calling process.exit so runCli stays testable and runCliMain owns reporting.
    program.exitOverride()
    // Suppress commander's own stderr; runCliMain prints errors uniformly. Help still goes to stdout.
    program.configureOutput({ writeErr: () => undefined })
    program.name(app.appName).description(app.tagline).helpCommand(false)

    const shape = app.schema.shape as Record<string, z.ZodType>
    const requireKey = (value: string): string => {
        if (value in shape) return value
        throw new SignalboxError(`unknown config key "${value}"`, `known keys: ${Object.keys(shape).join(", ")}`)
    }
    const schemaOf = (field: string): z.ZodType => {
        const schema = shape[field]
        if (!schema) throw new SignalboxError(`unknown config key "${field}"`)
        return schema
    }

    // Add the shared --config/--user options so they may appear after the command name.
    const withContext = (command: Command): Command =>
        command
            .option("--config <path>", "use a specific config file")
            .option("--user", "act on a per-user systemd unit instead of a system one (no root)")

    // Build the per-invocation store/service/scope from a command's global options.
    const ctxOf = (command: Command): { store: ConfigStore<TSchema>; service: ServiceManager; scope: ServiceScope } => {
        const opts = command.opts<GlobalOptions>()
        return {
            store: app.createStore(opts.config),
            service: createServiceManager(app.appName, {
                description: app.tagline,
                ...(app.systemService ? { systemService: app.systemService } : {}),
            }),
            scope: opts.user ? "user" : "system",
        }
    }

    // ---- lifecycle -------------------------------------------------------
    withContext(program.command("setup"))
        .description("install and start the systemd service")
        .action(async function (this: Command) {
            const { store, service, scope } = ctxOf(this)
            const config = await store.load()
            await sealForService(store, service, scope, app.firewallPort?.(config))
        })

    withContext(program.command("teardown"))
        .description("stop and remove the service; --purge also drops the config")
        .option("--purge", "also delete the config and managed keys")
        .option("--yes", "confirm destructive non-interactive commands")
        .action(async function (this: Command) {
            const { store, service, scope } = ctxOf(this)
            const opts = this.opts<{ purge?: boolean; yes?: boolean }>()
            const partial = (await store.inspect()).values as Partial<ConfigOf<TSchema>>
            if (opts.purge) {
                const inventory = await store.keyInventory()
                const targets = [store.path, ...inventory.map(item => `${item.backend}:${item.id}`)]
                await confirm(
                    `Purge config and managed keys?\n${targets.map(target => `  ${target}`).join("\n")}\n`,
                    opts.yes ?? false,
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
                purge: opts.purge ?? false,
                configPath: store.path,
                watchPort: app.firewallPort?.(partial),
            })
        })

    for (const action of ["start", "stop", "restart"] as const) {
        withContext(program.command(action))
            .description(`${action} the running unit`)
            .action(function (this: Command) {
                const { service, scope } = ctxOf(this)
                service.controlService(scope, action)
            })
    }

    withContext(program.command("status"))
        .description("print the unit status")
        .action(function (this: Command) {
            const { service, scope } = ctxOf(this)
            process.stdout.write(service.serviceStatus(scope))
        })

    withContext(program.command("run"))
        .description("run in the foreground (this is what systemd calls)")
        .action(async function (this: Command) {
            const { store } = ctxOf(this)
            const runnable = await app.createApp(await store.load())
            await runnable.run()
        })

    // ---- config ----------------------------------------------------------
    const config = program.command("config").description("manage the config file")

    withContext(config.command("path"))
        .description("print the config file location")
        .action(function (this: Command) {
            process.stdout.write(`${ctxOf(this).store.path}\n`)
        })

    withContext(config.command("list"))
        .description("show the current values, secrets redacted")
        .action(async function (this: Command) {
            const inspection = await ctxOf(this).store.inspect()
            process.stdout.write(`${JSON.stringify(inspection.values, null, 4)}\n`)
        })

    withContext(config.command("get"))
        .description("print one value, secrets redacted")
        .argument("<key>")
        .action(async function (this: Command, key: string) {
            requireKey(key)
            const value = (await ctxOf(this).store.inspect()).values[key]
            process.stdout.write(`${renderValue(value)}\n`)
        })

    withContext(config.command("reveal"))
        .description("explicitly print one secret value")
        .argument("<key>")
        .action(async function (this: Command, key: string) {
            const field = requireKey(key)
            if (!isSecret(schemaOf(field))) {
                throw new SignalboxError(`config reveal accepts only secret fields; ${field} is not secret`)
            }
            const value = ((await ctxOf(this).store.load()) as Record<string, unknown>)[field]
            if (!isSecretValue(value)) throw new SignalboxError(`secret config field ${field} is absent`)
            process.stdout.write(`${renderValue(value.reveal())}\n`)
        })

    withContext(config.command("set"))
        .description("set a non-secret value, or a secret via --stdin/--file")
        .argument("<key>")
        .argument("[value...]")
        .option("--stdin", "read a secret value from standard input")
        .option("--file <path>", "read a secret value from a UTF-8 file")
        .action(async function (this: Command, key: string, value: string[]) {
            const { store } = ctxOf(this)
            const opts = this.opts<{ stdin?: boolean; file?: string }>()
            const field = requireKey(key)
            if (isSecret(schemaOf(field))) {
                if (value.length > 0) {
                    throw new SignalboxError(
                        `secret ${field} must not be passed as a positional argument`,
                        `use an interactive prompt, --stdin, or --file <path>`,
                    )
                }
                if (opts.stdin && opts.file) throw new SignalboxError("--stdin and --file are mutually exclusive")
                const raw = opts.stdin
                    ? await readStream()
                    : opts.file
                      ? await readInputFile(opts.file)
                      : await readMasked(`${field}: `)
                await store.set(field, raw)
            } else {
                if (opts.stdin || opts.file) {
                    throw new SignalboxError("--stdin and --file are supported only for secret fields")
                }
                if (value.length === 0) throw new SignalboxError("config set needs a key and a value")
                await store.set(field, value.join(" "))
            }
            write("info", `set ${field} in ${store.path}`)
        })

    withContext(config.command("unset"))
        .description("remove one value")
        .argument("<key>")
        .action(async function (this: Command, key: string) {
            const { store } = ctxOf(this)
            const field = requireKey(key)
            await store.unset(field)
            write("info", `unset ${field} in ${store.path}`)
        })

    withContext(config.command("rekey"))
        .description("rotate the encryption key")
        .option("--revoke-old", "delete the prior key after verified rekey")
        .action(async function (this: Command) {
            const { store, service, scope } = ctxOf(this)
            const revokeOld = this.opts<{ revokeOld?: boolean }>().revokeOld ?? false
            const installed = service.isInstalled(scope)
            const result = await store.rekey({
                revokeOld,
                ...(installed ? { verify: async () => sealForService(store, service, scope) } : {}),
            })
            if (installed) await removeFileFallbackKeys(store)
            if (installed && revokeOld) service.deleteSealedKeys(scope, result.oldKeyIds)
            write("info", `rekeyed config to ${result.newKeyId} using ${result.backend}`)
            if (result.externalKeyIds.length > 0 && !revokeOld) {
                write("info", `retained external key(s): ${result.externalKeyIds.join(", ")}`)
            }
        })

    const keys = config.command("keys").description("manage encryption keys")

    withContext(keys.command("list"))
        .description("list the key inventory")
        .action(async function (this: Command) {
            process.stdout.write(`${JSON.stringify(await ctxOf(this).store.keyInventory(), null, 4)}\n`)
        })

    withContext(keys.command("prune"))
        .description("delete retired keys")
        .argument("<id...>")
        .option("--yes", "confirm destructive non-interactive commands")
        .action(async function (this: Command, ids: string[]) {
            const { store, service, scope } = ctxOf(this)
            const yes = this.opts<{ yes?: boolean }>().yes ?? false
            const inventory = await store.keyInventory()
            const selected = ids.map(keyId => {
                const entries = inventory.filter(item => item.id === keyId)
                if (entries.length === 0) throw new SignalboxError(`key ${keyId} was not found`)
                if (entries.some(item => item.referenced || item.state !== "retired")) {
                    throw new SignalboxError(`key ${keyId} is referenced, active, or staged and cannot be pruned`)
                }
                return { keyId, entries }
            })
            await confirm(`Delete retired key(s) ${ids.join(", ")}?`, yes)
            const managed = selected.filter(item => item.entries.some(entry => entry.managed)).map(item => item.keyId)
            const sealed = selected
                .filter(item => item.entries.some(entry => entry.backend === "systemd-creds"))
                .map(item => item.keyId)
            if (managed.length > 0) await store.pruneKeys(managed)
            if (sealed.length > 0) service.deleteSealedKeys(scope, sealed)
            write("info", `pruned key(s): ${ids.join(", ")}`)
        })

    withContext(config.command("export"))
        .description("export an encrypted transfer bundle")
        .option("--recipient <key>", "age1, ssh-rsa, or ssh-ed25519 export recipient")
        .option("--recipients-file <path>", "file containing one or more Age/SSH recipients")
        .option("--output <path>", "new encrypted transfer file to create")
        .action(async function (this: Command) {
            const { store } = ctxOf(this)
            const opts = this.opts<{ recipient?: string; recipientsFile?: string; output?: string }>()
            if (!opts.output) throw new SignalboxError("config export needs --output <file>")
            await exportConfigTransfer(store, {
                output: opts.output,
                ...(opts.recipient ? { recipient: opts.recipient } : {}),
                ...(opts.recipientsFile ? { recipientsFile: opts.recipientsFile } : {}),
            })
            write("info", `exported encrypted config to ${opts.output}`)
        })

    withContext(config.command("import"))
        .description("import an encrypted transfer bundle")
        .option("--identity <path>", "Age or SSH private identity used for import")
        .option("--file <path>", "encrypted transfer file to import")
        .option("--yes", "confirm destructive non-interactive commands")
        .action(async function (this: Command) {
            const { store } = ctxOf(this)
            const opts = this.opts<{ identity?: string; file?: string; yes?: boolean }>()
            if (!opts.file) throw new SignalboxError("config import needs --file <bundle>")
            if (!opts.identity) throw new SignalboxError("config import needs --identity <private-key>")
            if (await store.exists()) await confirm(`Replace config at ${store.path}?`, opts.yes ?? false)
            await importConfigTransfer(store, { input: opts.file, identity: opts.identity })
            write("info", `imported and locally encrypted config at ${store.path}`)
        })

    withContext(config.command("init"))
        .description("fill in the required values interactively")
        .action(async function (this: Command) {
            await initConfig(ctxOf(this).store)
        })

    withContext(config.command("interactive"))
        .description("edit all fields, then Save or Discard")
        .action(async function (this: Command) {
            await interactiveConfig(ctxOf(this).store)
        })

    // ---- app-supplied custom commands -----------------------------------
    for (const [name, custom] of Object.entries(commands)) {
        withContext(program.command(name))
            .description(custom.summary)
            .argument("[args...]")
            .action(async function (this: Command, args: string[]) {
                const { store } = ctxOf(this)
                await custom.run({ config: await store.load(), store, args })
            })
    }

    return program
}

/**
 * Run the shared service CLI (config commands, systemd lifecycle, run, and any
 * app-supplied custom commands) for one app.
 * @typeParam TSchema the app's Zod config schema
 * @param app the app descriptor
 * @param argv the CLI arguments (without node/script)
 */
export const runCli = async <TSchema extends ConfigSchema>(app: ServiceApp<TSchema>, argv: string[]): Promise<void> => {
    const commands = app.commands ?? {}
    const builtins = new Set<string>(BUILTIN_COMMANDS)
    for (const name of Object.keys(commands)) {
        if (builtins.has(name)) throw new SignalboxError(`custom command "${name}" collides with a built-in command`)
    }

    const program = buildProgram(app, commands)
    if (argv.length === 0) {
        program.outputHelp()
        return
    }

    try {
        await program.parseAsync(argv, { from: "user" })
    } catch (error) {
        if (error instanceof CommanderError) {
            // Help/version output uses exit code 0; treat it as a successful invocation.
            if (error.exitCode === 0) return
            throw new SignalboxError(error.message.replace(/^error: /, ""), "run with --help to see the commands")
        }
        throw error
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
