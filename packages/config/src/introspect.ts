/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
import type { z } from "zod"
import { secrets } from "./schema"

interface ZodDef {
    type: string
    innerType?: z.ZodType
    defaultValue?: unknown
}

const def = (schema: z.ZodType): ZodDef => (schema as any)._zod.def as ZodDef

/** The base value kind of a config field, once optional/default wrappers are removed. */
export type BaseKind = "string" | "number" | "boolean" | "array" | "enum" | "other"

/**
 * The base value kind of a schema, unwrapping optional/default/nullable wrappers.
 * @param schema the field schema
 */
export const baseKind = (schema: z.ZodType): BaseKind => {
    const d = def(schema)
    if ((d.type === "default" || d.type === "optional" || d.type === "nullable") && d.innerType) {
        return baseKind(d.innerType)
    }
    switch (d.type) {
        case "string":
            return "string"
        case "number":
            return "number"
        case "boolean":
            return "boolean"
        case "array":
            return "array"
        case "enum":
            return "enum"
        default:
            return "other"
    }
}

/**
 * Whether a field must be supplied by the user (neither optional nor carrying a default).
 * @param schema the field schema
 */
export const isRequired = (schema: z.ZodType): boolean => {
    const t = def(schema).type
    return t !== "optional" && t !== "default"
}

/**
 * Whether a field is marked secret (via `field().secret()` or {@link secret}).
 * @param schema the field schema
 */
export const isSecret = (schema: z.ZodType): boolean => secrets.has(schema)

/**
 * The field's description, if any, unwrapping optional/default wrappers.
 * @param schema the field schema
 */
export const describeOf = (schema: z.ZodType): string | undefined => {
    if (schema.description) return schema.description
    const inner = def(schema).innerType
    return inner ? describeOf(inner) : undefined
}
