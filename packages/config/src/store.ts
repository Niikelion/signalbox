import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { SignalboxError, isRoot } from "@signalbox/core"
import type { z } from "zod"
import { baseKind, isSecret } from "./introspect.js"

/**
 * The config object type for a schema.
 * @typeParam TSchema the Zod object schema
 */
export type ConfigOf<TSchema extends z.ZodObject> = z.infer<TSchema>

/**
 * A read/write config store for one app's schema.
 * @typeParam TSchema the Zod object schema
 */
export interface ConfigStore<TSchema extends z.ZodObject> {
    /** Resolved config file path. */
    readonly path: string
    /** The schema this store validates against. */
    readonly schema: TSchema
    /** Whether the config file exists. */
    exists: () => boolean
    /** Read and validate the full config; throws on missing/invalid values. */
    load: () => ConfigOf<TSchema>
    /** Read the raw file without validation (may be partial). */
    readPartial: () => Partial<ConfigOf<TSchema>>
    /** Write the given values to the file. */
    save: (values: Partial<ConfigOf<TSchema>>) => void
    /** Coerce, validate, and set a single key from a raw CLI string. */
    set: (key: string, rawValue: string) => void
    /** Remove a single key. */
    unset: (key: string) => void
    /** Coerce a raw CLI string to the field's type (without saving). */
    coerce: (key: string, rawValue: string) => unknown
    /** Return a copy of `values` with secret fields masked. */
    redacted: (values: Record<string, unknown>) => Record<string, unknown>
}

/**
 * Options for {@link createConfigStore}.
 * @typeParam TSchema the Zod object schema
 */
export interface ConfigStoreOptions<TSchema extends z.ZodObject> {
    /** App name; drives the default config path and env override. */
    appName: string
    /** The config schema (build it with `config()` / `field()`). */
    schema: TSchema
    /** Explicit config file path (overrides the default resolution). */
    path?: string
}

/**
 * Create a config store for an app.
 * @typeParam TSchema the Zod object schema
 * @param options app name, schema, and optional path
 */
export const createConfigStore = <TSchema extends z.ZodObject>(
    options: ConfigStoreOptions<TSchema>,
): ConfigStore<TSchema> => {
    const { appName, schema } = options
    const shape = schema.shape as Record<string, z.ZodType>
    const keys = Object.keys(shape)

    const fieldOf = (key: string): z.ZodType => {
        const field = shape[key]
        if (!field) throw new SignalboxError(`unknown config key "${key}"`, `known keys: ${keys.join(", ")}`)
        return field
    }

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

    const coerce = (key: string, rawValue: string): unknown => {
        const field = fieldOf(key)
        switch (baseKind(field)) {
            case "array":
                return rawValue
                    .split(",")
                    .map(entry => entry.trim())
                    .filter(Boolean)
            case "number": {
                const parsed = Number(rawValue)
                if (!Number.isFinite(parsed)) throw new SignalboxError(`${key} must be a number`)
                return parsed
            }
            case "boolean": {
                if (rawValue !== "true" && rawValue !== "false")
                    throw new SignalboxError(`${key} must be true or false`)
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
            throw new SignalboxError(`config at ${path} is not valid JSON: ${(error as Error).message}`)
        }
    }

    const save = (values: Partial<ConfigOf<TSchema>>): void => {
        mkdirSync(dirname(path), { recursive: true, mode: 0o750 })
        writeFileSync(path, `${JSON.stringify(values, null, 4)}\n`, { mode: 0o640 })
        chmodSync(path, 0o640)
    }

    const load = (): ConfigOf<TSchema> => {
        if (!existsSync(path)) {
            throw new SignalboxError(`no config at ${path}`, `run \`${appName} config init\` to create one`)
        }
        const result = schema.safeParse(readPartial())
        if (!result.success) {
            const problems = result.error.issues.map(issue => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            throw new SignalboxError(`config at ${path} is invalid: ${problems.join("; ")}`)
        }
        return result.data
    }

    return {
        path,
        schema,
        exists: () => existsSync(path),
        load,
        readPartial,
        save,
        coerce,
        set: (key, rawValue) => {
            const field = fieldOf(key)
            const coerced = coerce(key, rawValue)
            const result = field.safeParse(coerced)
            if (!result.success) {
                throw new SignalboxError(
                    `invalid value for ${key}: ${result.error.issues.map(i => i.message).join(", ")}`,
                )
            }
            const current = readPartial() as Record<string, unknown>
            current[key] = result.data
            save(current as Partial<ConfigOf<TSchema>>)
        },
        unset: key => {
            fieldOf(key)
            const { [key]: _removed, ...rest } = readPartial() as Record<string, unknown>
            save(rest as Partial<ConfigOf<TSchema>>)
        },
        redacted: values => {
            const output: Record<string, unknown> = { ...values }
            for (const [key, fieldSchema] of Object.entries(shape)) {
                if (!isSecret(fieldSchema)) continue
                const value = output[key]
                if (typeof value !== "string" || value.length === 0) continue
                output[key] = value.length > 4 ? `${"*".repeat(value.length - 4)}${value.slice(-4)}` : "****"
            }
            return output
        },
    }
}
