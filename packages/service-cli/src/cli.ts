import { createInterface } from "node:readline/promises"
import { parseArgs } from "node:util"
import { FlowKitError, write, type ConfigOf, type ConfigSchema, type ConfigStore, type FieldSpec } from "@flowkit/core"
import { createServiceManager, type ServiceScope } from "./systemd.js"

/** The bit of an app the CLI needs to `run` it, without knowing its event map. */
export interface Runnable {
    run: () => Promise<void>
}

/**
 * Everything a concrete app must supply for the shared CLI to drive it. The CLI
 * owns config, systemd, and the command surface; the app owns its schema and
 * what running actually does (`createApp` for the daemon).
 */
export interface ServiceApp<TSchema extends ConfigSchema> {
    appName: string
    /** One-line summary shown at the top of `--help`. */
    tagline: string
    schema: TSchema
    createStore: (path?: string) => ConfigStore<TSchema>
    createApp: (config: ConfigOf<TSchema>) => Runnable
    /** Optional one-shot: back the `once` command, apply state a single time and exit. */
    runOnce?: (config: ConfigOf<TSchema>) => Promise<unknown>
    /** Optional inbound port to open from the gateway at `setup` (e.g. a UPnP callback). */
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
  config list          show the current values, secrets redacted
  config get <key>
  config set <key> <value>
  config unset <key>
  config path          print the config file location

options
  --config <path>      use a specific config file
  -h, --help           show this
`

/** Config values are unknown at runtime, so render them without assuming a shape. */
const renderValue = (value: unknown): string => {
    if (Array.isArray(value)) return value.join(",")
    if (typeof value === "string") return value
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return value.toString()
    if (value === undefined || value === null) return ""
    return JSON.stringify(value)
}

const readSecretly = async (question: string): Promise<string> => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
        return (await rl.question(question)).trim()
    } finally {
        rl.close()
    }
}

const configCommand = async <TSchema extends ConfigSchema>(
    store: ConfigStore<TSchema>,
    args: string[],
): Promise<void> => {
    const schema = store.schema
    const schemaFields = Object.entries(schema) as [keyof TSchema & string, FieldSpec][]

    const requireKey = (value: string | undefined): keyof TSchema & string => {
        if (value && value in schema) return value
        throw new FlowKitError(`unknown config key "${value ?? ""}"`, `known keys: ${Object.keys(schema).join(", ")}`)
    }

    const [action, key, ...rest] = args

    switch (action) {
        case "path":
            process.stdout.write(`${store.path}\n`)
            return

        case "list": {
            const values = store.redacted(store.readPartial())
            process.stdout.write(`${JSON.stringify(values, null, 4)}\n`)
            return
        }

        case "get": {
            if (!key) throw new FlowKitError("config get needs a key")
            const value = (store.readPartial() as Record<string, unknown>)[key]
            process.stdout.write(`${renderValue(value)}\n`)
            return
        }

        case "set": {
            if (rest.length === 0) throw new FlowKitError("config set needs a key and a value")
            const field = requireKey(key)
            store.set(field, rest.join(" "))
            write("info", `set ${field} in ${store.path}`)
            return
        }

        case "unset": {
            const field = requireKey(key)
            store.unset(field)
            write("info", `unset ${field} in ${store.path}`)
            return
        }

        case "init": {
            const current = store.readPartial() as Record<string, unknown>
            for (const [field, spec] of schemaFields) {
                if (!spec.required) continue

                const existing = current[field]
                const shown =
                    spec.secret && existing ? "(set)" : Array.isArray(existing) ? existing.join(",") : existing
                const suffix = existing ? ` [${String(shown)}]` : ""
                const answer = await readSecretly(`${field} - ${spec.description ?? ""}${suffix}: `)
                if (answer) current[field] = store.coerce(field, answer)
            }
            store.save(current as Partial<ConfigOf<TSchema>>)
            write("info", `wrote ${store.path}`)
            return
        }

        default:
            throw new FlowKitError(
                `unknown config command "${action ?? ""}"`,
                "expected one of: init, list, get, set, unset, path",
            )
    }
}

/**
 * Run the shared service command-line interface for one app. This owns argument
 * parsing, the config commands, and the systemd lifecycle; the `app` descriptor
 * supplies the schema and what running the app actually does.
 */
export const runCli = async <TSchema extends ConfigSchema>(app: ServiceApp<TSchema>, argv: string[]): Promise<void> => {
    const { values, positionals } = parseArgs({
        args: argv,
        options: {
            config: { type: "string" },
            purge: { type: "boolean", default: false },
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
            await configCommand(store, rest)
            return

        case "setup": {
            const config = store.load() // fail before touching systemd
            service.setupService({ scope, configPath: store.path, watchPort: app.firewallPort?.(config) })
            return
        }

        case "teardown": {
            const partial = store.readPartial()
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
            const runnable = app.createApp(store.load())
            await runnable.run()
            return
        }

        case "once": {
            if (!app.runOnce) {
                throw new FlowKitError(`${app.appName} does not support the once command`)
            }
            await app.runOnce(store.load())
            return
        }

        default:
            throw new FlowKitError(`unknown command "${command}"`, "run with --help to see the available commands")
    }
}

/** Wrap `runCli` with the standard FlowKitError-aware error reporting. */
export const runCliMain = async <TSchema extends ConfigSchema>(app: ServiceApp<TSchema>): Promise<void> => {
    try {
        await runCli(app, process.argv.slice(2))
    } catch (error) {
        if (error instanceof FlowKitError) {
            write("error", error.message)
            if (error.hint) write("error", `hint: ${error.hint}`)
        } else {
            write("error", error instanceof Error ? error.message : String(error))
        }
        process.exitCode = 1
    }
}
