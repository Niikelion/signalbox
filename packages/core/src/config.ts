import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { FlowKitError } from "./log.js"

export type FieldType = "string" | "int" | "bool" | "list"

export interface FieldSpec {
    type: FieldType
    required?: boolean
    secret?: boolean
    description?: string
}

export type ConfigSchema = Record<string, FieldSpec>

type FieldValue<TSpec extends FieldSpec> = TSpec["type"] extends "string"
    ? string
    : TSpec["type"] extends "int"
      ? number
      : TSpec["type"] extends "bool"
        ? boolean
        : string[]

export type ConfigOf<TSchema extends ConfigSchema> = { [TKey in keyof TSchema]: FieldValue<TSchema[TKey]> }

export interface ConfigStoreOptions<TSchema extends ConfigSchema> {
    appName: string
    schema: TSchema
    defaults: Partial<ConfigOf<TSchema>>
    path?: string
}

export const isRoot = (): boolean =>
    process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() === 0

export interface ConfigStore<TSchema extends ConfigSchema> {
    readonly path: string
    readonly schema: TSchema
    exists: () => boolean
    load: () => ConfigOf<TSchema>
    readPartial: () => Partial<ConfigOf<TSchema>>
    save: (values: Partial<ConfigOf<TSchema>>) => void
    set: (key: keyof TSchema & string, rawValue: string) => void
    unset: (key: keyof TSchema & string) => void
    coerce: (key: keyof TSchema & string, rawValue: string) => unknown
    redacted: (values: Partial<ConfigOf<TSchema>>) => Record<string, unknown>
}

export const createConfigStore = <TSchema extends ConfigSchema>(
    options: ConfigStoreOptions<TSchema>,
): ConfigStore<TSchema> => {
    const { appName, schema, defaults } = options

    const systemPath = `/etc/${appName}/config.json`
    const xdgConfigHome = process.env["XDG_CONFIG_HOME"]
    const configHome = xdgConfigHome && xdgConfigHome.length > 0 ? xdgConfigHome : join(homedir(), ".config")
    const userPath = join(configHome, appName, "config.json")

    const resolvePath = (): string => {
        if (options.path) return options.path
        const fromEnv = process.env[`${appName.toUpperCase().replace(/-/g, "_")}_CONFIG`]
        if (fromEnv) return fromEnv
        if (existsSync(systemPath)) return systemPath
        if (existsSync(userPath)) return userPath
        return isRoot() ? systemPath : userPath
    }

    const path = resolvePath()

    const coerce = (key: keyof TSchema & string, rawValue: string): unknown => {
        const spec = schema[key]
        if (!spec)
            throw new FlowKitError(`unknown config key "${key}"`, `known keys: ${Object.keys(schema).join(", ")}`)

        switch (spec.type) {
            case "list":
                return rawValue
                    .split(",")
                    .map((entry) => entry.trim())
                    .filter(Boolean)
            case "int": {
                const parsed = Number(rawValue)
                if (!Number.isInteger(parsed) || parsed <= 0)
                    throw new FlowKitError(`${key} must be a positive integer`)
                return parsed
            }
            case "bool": {
                if (!["true", "false"].includes(rawValue)) throw new FlowKitError(`${key} must be true or false`)
                return rawValue === "true"
            }
            default:
                return rawValue
        }
    }

    const readPartial = (): Partial<ConfigOf<TSchema>> => {
        if (!existsSync(path)) return {}
        try {
            return JSON.parse(readFileSync(path, "utf8")) as Partial<ConfigOf<TSchema>>
        } catch (error) {
            throw new FlowKitError(`config at ${path} is not valid JSON: ${(error as Error).message}`)
        }
    }

    const save = (values: Partial<ConfigOf<TSchema>>): void => {
        mkdirSync(dirname(path), { recursive: true, mode: 0o750 })
        writeFileSync(path, `${JSON.stringify({ ...defaults, ...values }, null, 4)}\n`, { mode: 0o640 })
        chmodSync(path, 0o640)
    }

    const load = (): ConfigOf<TSchema> => {
        if (!existsSync(path)) {
            throw new FlowKitError(`no config at ${path}`, `run \`${appName} config init\` to create one`)
        }
        const merged = { ...defaults, ...readPartial() } as ConfigOf<TSchema>

        const missing = Object.entries(schema)
            .filter(([key, spec]) => {
                if (!spec.required) return false
                const value = (merged as Record<string, unknown>)[key]
                if (value === undefined || value === null || value === "") return true
                if (Array.isArray(value) && value.length === 0) return true
                return typeof value === "string" && value.startsWith("PASTE_")
            })
            .map(([key]) => key)

        if (missing.length > 0) {
            throw new FlowKitError(
                `config at ${path} is missing: ${missing.join(", ")}`,
                `set them with \`${appName} config set ${missing[0]} <value>\``,
            )
        }
        return merged
    }

    return {
        path,
        schema,
        exists: () => existsSync(path),
        load,
        readPartial,
        save,
        set: (key, rawValue) => {
            const current = readPartial() as Record<string, unknown>
            current[key] = coerce(key, rawValue)
            save(current as Partial<ConfigOf<TSchema>>)
        },
        unset: (key) => {
            const { [key]: _removed, ...rest } = readPartial() as Record<string, unknown>
            save(rest as Partial<ConfigOf<TSchema>>)
        },
        coerce,
        redacted: (values) => {
            const output: Record<string, unknown> = { ...values }
            for (const [key, spec] of Object.entries(schema)) {
                const value = output[key]
                if (!spec.secret || typeof value !== "string" || value.length === 0) continue
                output[key] = value.length > 4 ? `${"*".repeat(value.length - 4)}${value.slice(-4)}` : "****"
            }
            return output
        },
    }
}
