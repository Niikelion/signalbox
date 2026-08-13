#!/usr/bin/env node
import { createInterface } from "node:readline/promises"
import { parseArgs } from "node:util"
import { FlowKitError, write, type FieldSpec } from "@flowkit/core"
import { createDdnsApp } from "./app.js"
import { APP_NAME, configSchema, createDdnsConfigStore } from "./config.js"
import { controlService, serviceStatus, setupService, teardownService, type ServiceScope } from "./systemd.js"

const USAGE = `${APP_NAME} - Cloudflare dynamic DNS driven by your router's UPnP events

usage: ${APP_NAME} <command> [options]

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

type ConfigKey = keyof typeof configSchema

/** The schema is `as const`, so widen it once for generic iteration. */
const schemaFields = Object.entries(configSchema) as [ConfigKey, FieldSpec][]

const requireKey = (value: string | undefined): ConfigKey => {
    if (value && value in configSchema) return value as ConfigKey
    throw new FlowKitError(`unknown config key "${value ?? ""}"`, `known keys: ${Object.keys(configSchema).join(", ")}`)
}

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

const configCommand = async (store: ReturnType<typeof createDdnsConfigStore>, args: string[]): Promise<void> => {
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
                const answer = await readSecretly(`${field} - ${spec.description}${suffix}: `)
                if (answer) current[field] = store.coerce(field, answer)
            }
            store.save(current)
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

const main = async (): Promise<void> => {
    const { values, positionals } = parseArgs({
        args: process.argv.slice(2),
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
        process.stdout.write(USAGE)
        return
    }

    const scope: ServiceScope = values.user ? "user" : "system"
    const store = createDdnsConfigStore(values.config)

    switch (command) {
        case "config":
            await configCommand(store, rest)
            return

        case "setup": {
            const config = store.load() // fail before touching systemd
            setupService({ scope, configPath: store.path, watchPort: config.watchPort })
            return
        }

        case "teardown": {
            const partial = store.readPartial()
            teardownService({
                scope,
                purge: values.purge,
                configPath: store.path,
                watchPort: partial.watchPort ?? 5959,
            })
            return
        }

        case "start":
        case "stop":
        case "restart":
            controlService(scope, command)
            return

        case "status":
            process.stdout.write(serviceStatus(scope))
            return

        case "run": {
            const app = createDdnsApp(store.load())
            await app.run()
            return
        }

        case "once": {
            const config = store.load()
            const app = createDdnsApp(config)
            // start() runs the fallback poll's startup check, which is exactly
            // the one-shot behaviour we want here
            await app.start()
            await app.stop("once")
            return
        }

        default:
            throw new FlowKitError(`unknown command "${command}"`, "run with --help to see the available commands")
    }
}

try {
    await main()
} catch (error) {
    if (error instanceof FlowKitError) {
        write("error", error.message)
        if (error.hint) write("error", `hint: ${error.hint}`)
    } else {
        write("error", error instanceof Error ? error.message : String(error))
    }
    process.exitCode = 1
}
