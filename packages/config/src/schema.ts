import { z } from "zod"

/** Registry of schemas whose values are secret (redacted in output, hidden at prompts). */
export const secrets = z.registry<{ secret: true }>()

/** Register on a non-generic schema so Zod's conditional register overload resolves. */
const markSecret = (schema: z.ZodType): void => {
    schema.register(secrets, { secret: true })
}

interface FieldMeta {
    secret?: boolean
}

/**
 * A config-field builder wrapping a Zod schema, with signalbox extras (`secret`).
 * @typeParam T the underlying Zod type
 */
export class Field<T extends z.ZodType> {
    constructor(
        /** The underlying Zod schema. */
        readonly zod: T,
        /** signalbox field metadata. */
        readonly meta: FieldMeta = {},
    ) {}

    /** Mark the field's value as secret (redacted in `config list`, hidden at prompts). */
    secret(): Field<T> {
        return new Field(this.zod, { ...this.meta, secret: true })
    }

    /**
     * Attach a description (used for CLI prompts and OpenAPI).
     * @param text the description
     */
    describe(text: string): Field<T> {
        return new Field(this.zod.describe(text), this.meta)
    }

    /** Make the field optional. */
    optional(): Field<z.ZodOptional<T>> {
        return new Field(this.zod.optional(), this.meta)
    }

    /**
     * Give the field a default value.
     * @param value the default
     */
    default(value: z.output<T>): Field<z.ZodDefault<T>> {
        return new Field(this.zod.default(value as never), this.meta)
    }
}

class StringField extends Field<z.ZodString> {
    min(length: number): StringField {
        return new StringField(this.zod.min(length), this.meta)
    }
    max(length: number): StringField {
        return new StringField(this.zod.max(length), this.meta)
    }
    regex(pattern: RegExp): StringField {
        return new StringField(this.zod.regex(pattern), this.meta)
    }
}

class NumberField extends Field<z.ZodNumber> {
    positive(): NumberField {
        return new NumberField(this.zod.min(1), this.meta)
    }
    min(value: number): NumberField {
        return new NumberField(this.zod.min(value), this.meta)
    }
    max(value: number): NumberField {
        return new NumberField(this.zod.max(value), this.meta)
    }
}

class ListField extends Field<z.ZodArray<z.ZodString>> {
    nonempty(): ListField {
        return new ListField(this.zod.min(1), this.meta)
    }
}

/** Start a config field: pick a type via `.string()` / `.int()` / `.bool()` / `.list()`. */
export const field = () => ({
    /** A string field (with `.min`/`.max`/`.regex`). */
    string: (): StringField => new StringField(z.string()),
    /** An integer field (with `.positive`/`.min`/`.max`). */
    int: (): NumberField => new NumberField(z.number().int()),
    /** A boolean field. */
    bool: (): Field<z.ZodBoolean> => new Field(z.boolean()),
    /** A comma-separated list of strings (with `.nonempty`). */
    list: (): ListField => new ListField(z.array(z.string())),
})

/**
 * Mark a bare Zod schema as secret (for nested/raw fields). Apply last in the chain.
 * @typeParam T the schema type
 * @param schema the schema to mark
 */
export const secret = <T extends z.ZodType>(schema: T): T => {
    markSecret(schema)
    return schema
}

type FieldOrZod = Field<z.ZodType> | z.ZodType
type ZodOf<F> = F extends Field<infer T> ? T : F
type ShapeOf<S extends Record<string, FieldOrZod>> = { [K in keyof S]: ZodOf<S[K]> }

/**
 * Assemble a config schema from `field()` builders and/or raw Zod schemas.
 * @typeParam S the shape map (field builders and/or Zod schemas)
 * @param shape the fields, keyed by config key
 */
export const config = <S extends Record<string, FieldOrZod>>(shape: S): z.ZodObject<ShapeOf<S>> => {
    const zodShape: Record<string, z.ZodType> = {}
    const secretKeys: string[] = []
    for (const [key, value] of Object.entries(shape)) {
        if (value instanceof Field) {
            zodShape[key] = value.zod
            if (value.meta.secret) secretKeys.push(key)
        } else {
            zodShape[key] = value
        }
    }
    const object = z.object(zodShape)
    const built = object.shape as Record<string, z.ZodType>
    for (const key of secretKeys) {
        const fieldSchema = built[key]
        if (fieldSchema) markSecret(fieldSchema)
    }
    return object as z.ZodObject<ShapeOf<S>>
}

/**
 * The config object type inferred from a schema built by {@link config}.
 * @typeParam C the schema type
 */
export type Infer<C extends z.ZodType> = z.infer<C>
