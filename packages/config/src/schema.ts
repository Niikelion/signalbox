import { z } from "zod"

export const secrets = z.registry<{ secret: true }>()

/** Register on a non-generic schema so Zod's conditional register overload resolves. */
const markSecret = (schema: z.ZodType): void => {
    schema.register(secrets, { secret: true })
}

interface FieldMeta {
    secret?: boolean
}

export class Field<T extends z.ZodType> {
    constructor(
        readonly zod: T,
        readonly meta: FieldMeta = {},
    ) {}

    secret(): Field<T> {
        return new Field(this.zod, { ...this.meta, secret: true })
    }

    describe(text: string): Field<T> {
        return new Field(this.zod.describe(text), this.meta)
    }

    optional(): Field<z.ZodOptional<T>> {
        return new Field(this.zod.optional(), this.meta)
    }

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

export const field = () => ({
    string: (): StringField => new StringField(z.string()),
    int: (): NumberField => new NumberField(z.number().int()),
    bool: (): Field<z.ZodBoolean> => new Field(z.boolean()),
    list: (): ListField => new ListField(z.array(z.string())),
})

/** Mark a bare Zod schema as secret (for nested/raw fields). Apply last in the chain. */
export const secret = <T extends z.ZodType>(schema: T): T => {
    markSecret(schema)
    return schema
}

type FieldOrZod = Field<z.ZodType> | z.ZodType
type ZodOf<F> = F extends Field<infer T> ? T : F
type ShapeOf<S extends Record<string, FieldOrZod>> = { [K in keyof S]: ZodOf<S[K]> }

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

export type Infer<C extends z.ZodType> = z.infer<C>
