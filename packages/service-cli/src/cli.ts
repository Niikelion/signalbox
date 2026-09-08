import { realpathSync } from "node:fs"
import * as p from "@clack/prompts"
import { Command, CommanderError } from "commander"
import pc from "picocolors"
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
import type { ServiceAdapter, ServiceTarget } from "./adapter"
import { readConfirm, readInputFile, readMasked, readPlain, readStream, selectOption } from "./terminal"
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
 * It describes application behavior only; service-system integration is
 * supplied separately as a {@link ServiceAdapter} through {@link RunCliOptions}.
 * @typeParam TSchema the app's Zod config schema
 */
export interface ServiceApp<TSchema extends ConfigSchema> {
    /** Binary/app name (config path, service unit, usage header). */
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
}

/**
 * Options for {@link runCli} / {@link runCliMain}.
 * @typeParam TSchema the app's Zod config schema
 */
export interface RunCliOptions<TSchema extends ConfigSchema> {
    /**
     * The service-system adapter. When supplied, the lifecycle commands
     * (`setup`, `teardown`, `start`, `stop`, `restart`, `status`) are enabled;
     * when omitted, they are hidden and rejected.
     */
    service?: ServiceAdapter<ConfigOf<TSchema>>
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
    if (!(await readConfirm(question))) throw new SignalboxError("operation cancelled")
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

/** Executable and args the installed service uses to invoke this CLI's `run`. */
const cliRunInfo = (): { executable: string; runArgs: readonly string[] } => {
    const argv1 = process.argv[1]
    if (!argv1) throw new SignalboxError("cannot determine the path to this CLI")
    return { executable: process.execPath, runArgs: [realpathSync(argv1), "run"] }
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

const fieldPrompt = (field: string, schema: z.ZodType): string => {
    const description = describeOf(schema)
    return description ? `${field} — ${description}` : field
}

const interactiveConfig = async <TSchema extends ConfigSchema>(store: ConfigStore<TSchema>): Promise<void> => {
    const shape = store.schema.shape as Record<string, z.ZodType>
    const fields = Object.entries(shape)
    const staged = (await store.readPartial()) as Record<string, unknown>
    p.intro(pc.cyan(`Edit ${store.appName} config`))
    let selected = 0
    for (;;) {
        const labels = fields.map(([field, schema]) => {
            const value = staged[field]
            const shown = isSecret(schema) && value !== undefined ? "[redacted]" : renderValue(value)
            return `${field}: ${shown || "(empty)"}`
        })
        labels.push("Save", "Discard")
        selected = await selectOption("Choose a field to edit, or Save/Discard", labels, selected)
        if (selected === fields.length) {
            await store.save(plaintextValues<TSchema>(staged))
            p.outro(pc.green(`wrote ${store.path}`))
            return
        }
        if (selected === fields.length + 1) {
            p.outro(pc.dim("discarded config changes"))
            return
        }
        const entry = fields[selected]
        if (!entry) continue
        const [field, schema] = entry
        if (isSecret(schema)) {
            const raw = await readMasked(fieldPrompt(field, schema))
            const parsed = validateStaged(field, schema, store.coerce(field, raw))
            staged[field] = Secret.from(parsed as JsonValue)
        } else {
            const raw = await readPlain(fieldPrompt(field, schema), renderValue(staged[field]))
            if (raw !== "") staged[field] = validateStaged(field, schema, store.coerce(field, raw))
        }
    }
}

const initConfig = async <TSchema extends ConfigSchema>(store: ConfigStore<TSchema>): Promise<void> => {
    const fields = Object.entries(store.schema.shape as Record<string, z.ZodType>)
    const current = (await store.readPartial()) as Record<string, unknown>
    p.intro(pc.cyan(`Configure ${store.appName}`))
    for (const [field, fieldSchema] of fields) {
        if (!isRequired(fieldSchema)) continue
        const existing = current[field]
        const answer = isSecret(fieldSchema)
            ? await readMasked(fieldPrompt(field, fieldSchema))
            : await readPlain(fieldPrompt(field, fieldSchema), renderValue(existing))
        if (answer) {
            const parsed = validateStaged(field, fieldSchema, store.coerce(field, answer))
            current[field] = isSecret(fieldSchema) ? Secret.from(parsed as JsonValue) : parsed
        }
    }
    await store.save(plaintextValues<TSchema>(current))
    p.outro(pc.green(`wrote ${store.path}`))
}

/** Validate adapter metadata; invalid metadata is a configuration error. */
const validateAdapter = <TConfig>(service: ServiceAdapter<TConfig>): void => {
    if (service.scopes.length === 0) throw new SignalboxError("service adapter declares no scopes")
    const names = service.scopes.map(scope => scope.name)
    if (names.some(name => name.length === 0)) throw new SignalboxError("service adapter has an empty scope name")
    if (new Set(names).size !== names.length) throw new SignalboxError("service adapter has duplicate scope names")
    if (!names.includes(service.defaultScope)) {
        throw new SignalboxError(`service adapter defaultScope "${service.defaultScope}" is not a declared scope`)
    }
}

/**
 * Build the commander program for one app: config commands, `run`, any
 * app-supplied custom commands, and — when an adapter is supplied — the
 * generic lifecycle commands.
 */
const buildProgram = <TSchema extends ConfigSchema>(
    app: ServiceApp<TSchema>,
    commands: Record<string, ServiceCommand<TSchema>>,
    service?: ServiceAdapter<ConfigOf<TSchema>>,
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

    // `--config` may appear after any command; `--scope` only where the adapter is used.
    const withConfig = (command: Command): Command => command.option("--config <path>", "use a specific config file")
    const withScope = (command: Command): Command =>
        service
            ? command.option(
                  "--scope <name>",
                  `service scope: ${service.scopes.map(scope => scope.name).join(", ")} (default ${service.defaultScope})`,
              )
            : command

    const storeOf = (command: Command): ConfigStore<TSchema> =>
        app.createStore(command.opts<{ config?: string }>().config)
    const resolveScope = (command: Command): string => {
        if (!service) throw new SignalboxError("this command needs a service adapter")
        const requested = command.opts<{ scope?: string }>().scope ?? service.defaultScope
        if (!service.scopes.some(scope => scope.name === requested)) {
            throw new SignalboxError(
                `unknown scope "${requested}"`,
                `known scopes: ${service.scopes.map(scope => scope.name).join(", ")}`,
            )
        }
        return requested
    }
    const targetOf = (command: Command): ServiceTarget => ({ appName: app.appName, scope: resolveScope(command) })

    const seal = async (store: ConfigStore<TSchema>, scope: string, config: ConfigOf<TSchema>): Promise<void> => {
        if (!service) throw new SignalboxError("this command needs a service adapter")
        const keys = await keyMaterialsForService(store)
        const runInfo = cliRunInfo()
        await service.setup({
            appName: app.appName,
            scope,
            description: app.tagline,
            config,
            configPath: store.path,
            executable: runInfo.executable,
            runArgs: runInfo.runArgs,
            keys: keys.materials,
            ...(keys.activeKeyId ? { activeKeyId: keys.activeKeyId } : {}),
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

    // ---- lifecycle (only with an adapter) --------------------------------
    if (service) {
        withScope(withConfig(program.command("setup")))
            .description("install and start the service")
            .action(async function (this: Command) {
                const store = storeOf(this)
                await seal(store, resolveScope(this), await store.load())
            })

        withScope(withConfig(program.command("teardown")))
            .description("stop and remove the service; --purge also drops the config")
            .option("--purge", "also delete the config and managed keys")
            .option("--yes", "confirm destructive non-interactive commands")
            .action(async function (this: Command) {
                const store = storeOf(this)
                const scope = resolveScope(this)
                const opts = this.opts<{ purge?: boolean; yes?: boolean }>()
                const partial = (await store.inspect()).values as Partial<ConfigOf<TSchema>>
                const inventory = opts.purge ? await store.keyInventory() : []
                if (opts.purge) {
                    const targets = [store.path, ...inventory.map(item => `${item.backend}:${item.id}`)]
                    await confirm(
                        `Purge config and managed keys?\n${targets.map(target => `  ${target}`).join("\n")}\n`,
                        opts.yes ?? false,
                    )
                }
                await service.teardown({
                    appName: app.appName,
                    scope,
                    description: app.tagline,
                    config: partial,
                    configPath: store.path,
                    purge: opts.purge ?? false,
                })
                if (opts.purge) {
                    await service.purgeCredentials({ appName: app.appName, scope })
                    await store.purge()
                    const external = inventory
                        .filter(item => !item.managed && item.backend !== "systemd-creds")
                        .map(item => item.id)
                    if (external.length > 0) {
                        write("warn", `external environment keys cannot be deleted: ${external.join(", ")}`)
                    }
                }
            })

        for (const action of ["start", "stop", "restart"] as const) {
            withScope(withConfig(program.command(action)))
                .description(`${action} the service`)
                .action(async function (this: Command) {
                    await service.control(targetOf(this), action)
                })
        }

        withScope(withConfig(program.command("status")))
            .description("print the service status")
            .action(async function (this: Command) {
                process.stdout.write(await service.status(targetOf(this)))
            })
    }

    withConfig(program.command("run"))
        .description("run in the foreground (this is what the service calls)")
        .action(async function (this: Command) {
            const store = storeOf(this)
            const runnable = await app.createApp(await store.load())
            await runnable.run()
        })

    // ---- config ----------------------------------------------------------
    const config = program.command("config").description("manage the config file")

    withConfig(config.command("path"))
        .description("print the config file location")
        .action(function (this: Command) {
            process.stdout.write(`${storeOf(this).path}\n`)
        })

    withConfig(config.command("list"))
        .description("show the current values, secrets redacted")
        .action(async function (this: Command) {
            const inspection = await storeOf(this).inspect()
            process.stdout.write(`${JSON.stringify(inspection.values, null, 4)}\n`)
        })

    withConfig(config.command("get"))
        .description("print one value, secrets redacted")
        .argument("<key>")
        .action(async function (this: Command, key: string) {
            requireKey(key)
            const value = (await storeOf(this).inspect()).values[key]
            process.stdout.write(`${renderValue(value)}\n`)
        })

    withConfig(config.command("reveal"))
        .description("explicitly print one secret value")
        .argument("<key>")
        .action(async function (this: Command, key: string) {
            const field = requireKey(key)
            if (!isSecret(schemaOf(field))) {
                throw new SignalboxError(`config reveal accepts only secret fields; ${field} is not secret`)
            }
            const value = ((await storeOf(this).load()) as Record<string, unknown>)[field]
            if (!isSecretValue(value)) throw new SignalboxError(`secret config field ${field} is absent`)
            process.stdout.write(`${renderValue(value.reveal())}\n`)
        })

    withConfig(config.command("set"))
        .description("set a non-secret value, or a secret via --stdin/--file")
        .argument("<key>")
        .argument("[value...]")
        .option("--stdin", "read a secret value from standard input")
        .option("--file <path>", "read a secret value from a UTF-8 file")
        .action(async function (this: Command, key: string, value: string[]) {
            const store = storeOf(this)
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

    withConfig(config.command("unset"))
        .description("remove one value")
        .argument("<key>")
        .action(async function (this: Command, key: string) {
            const store = storeOf(this)
            const field = requireKey(key)
            await store.unset(field)
            write("info", `unset ${field} in ${store.path}`)
        })

    withScope(withConfig(config.command("rekey")))
        .description("rotate the encryption key")
        .option("--revoke-old", "delete the prior key after verified rekey")
        .action(async function (this: Command) {
            const store = storeOf(this)
            const revokeOld = this.opts<{ revokeOld?: boolean }>().revokeOld ?? false
            const scope = service ? resolveScope(this) : undefined
            const installed = service && scope ? await service.isInstalled({ appName: app.appName, scope }) : false
            const result = await store.rekey({
                revokeOld,
                ...(installed && scope ? { verify: async () => seal(store, scope, await store.load()) } : {}),
            })
            if (installed) await removeFileFallbackKeys(store)
            if (installed && revokeOld && service && scope) {
                await service.removeCredentials({ appName: app.appName, scope }, result.oldKeyIds)
            }
            write("info", `rekeyed config to ${result.newKeyId} using ${result.backend}`)
            if (result.externalKeyIds.length > 0 && !revokeOld) {
                write("info", `retained external key(s): ${result.externalKeyIds.join(", ")}`)
            }
        })

    const keys = config.command("keys").description("manage encryption keys")

    withConfig(keys.command("list"))
        .description("list the key inventory")
        .action(async function (this: Command) {
            process.stdout.write(`${JSON.stringify(await storeOf(this).keyInventory(), null, 4)}\n`)
        })

    withScope(withConfig(keys.command("prune")))
        .description("delete retired keys")
        .argument("<id...>")
        .option("--yes", "confirm destructive non-interactive commands")
        .action(async function (this: Command, ids: string[]) {
            const store = storeOf(this)
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
            if (sealed.length > 0) {
                if (!service) throw new SignalboxError("removing sealed credentials needs a service adapter")
                await service.removeCredentials({ appName: app.appName, scope: resolveScope(this) }, sealed)
            }
            write("info", `pruned key(s): ${ids.join(", ")}`)
        })

    withConfig(config.command("export"))
        .description("export an encrypted transfer bundle")
        .option("--recipient <key>", "age1, ssh-rsa, or ssh-ed25519 export recipient")
        .option("--recipients-file <path>", "file containing one or more Age/SSH recipients")
        .option("--output <path>", "new encrypted transfer file to create")
        .action(async function (this: Command) {
            const store = storeOf(this)
            const opts = this.opts<{ recipient?: string; recipientsFile?: string; output?: string }>()
            if (!opts.output) throw new SignalboxError("config export needs --output <file>")
            await exportConfigTransfer(store, {
                output: opts.output,
                ...(opts.recipient ? { recipient: opts.recipient } : {}),
                ...(opts.recipientsFile ? { recipientsFile: opts.recipientsFile } : {}),
            })
            write("info", `exported encrypted config to ${opts.output}`)
        })

    withConfig(config.command("import"))
        .description("import an encrypted transfer bundle")
        .option("--identity <path>", "Age or SSH private identity used for import")
        .option("--file <path>", "encrypted transfer file to import")
        .option("--yes", "confirm destructive non-interactive commands")
        .action(async function (this: Command) {
            const store = storeOf(this)
            const opts = this.opts<{ identity?: string; file?: string; yes?: boolean }>()
            if (!opts.file) throw new SignalboxError("config import needs --file <bundle>")
            if (!opts.identity) throw new SignalboxError("config import needs --identity <private-key>")
            if (await store.exists()) await confirm(`Replace config at ${store.path}?`, opts.yes ?? false)
            await importConfigTransfer(store, { input: opts.file, identity: opts.identity })
            write("info", `imported and locally encrypted config at ${store.path}`)
        })

    withConfig(config.command("init"))
        .description("fill in the required values interactively")
        .action(async function (this: Command) {
            await initConfig(storeOf(this))
        })

    withConfig(config.command("interactive"))
        .description("edit all fields, then Save or Discard")
        .action(async function (this: Command) {
            await interactiveConfig(storeOf(this))
        })

    // ---- app-supplied custom commands -----------------------------------
    for (const [name, custom] of Object.entries(commands)) {
        withConfig(program.command(name))
            .description(custom.summary)
            .argument("[args...]")
            .action(async function (this: Command, args: string[]) {
                const store = storeOf(this)
                await custom.run({ config: await store.load(), store, args })
            })
    }

    return program
}

/**
 * Run the shared service CLI (config commands, `run`, any app-supplied custom
 * commands, and — when a service adapter is supplied — the lifecycle commands).
 * @typeParam TSchema the app's Zod config schema
 * @param app the app descriptor
 * @param argv the CLI arguments (without node/script)
 * @param options optional service adapter and other run options
 */
export const runCli = async <TSchema extends ConfigSchema>(
    app: ServiceApp<TSchema>,
    argv: string[],
    options: RunCliOptions<TSchema> = {},
): Promise<void> => {
    const commands = app.commands ?? {}
    const builtins = new Set<string>(BUILTIN_COMMANDS)
    for (const name of Object.keys(commands)) {
        if (builtins.has(name)) throw new SignalboxError(`custom command "${name}" collides with a built-in command`)
    }
    if (options.service) validateAdapter(options.service)

    const program = buildProgram(app, commands, options.service)
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
 * @param options optional service adapter and other run options
 */
export const runCliMain = async <TSchema extends ConfigSchema>(
    app: ServiceApp<TSchema>,
    options: RunCliOptions<TSchema> = {},
): Promise<void> => {
    try {
        await runCli(app, process.argv.slice(2), options)
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
