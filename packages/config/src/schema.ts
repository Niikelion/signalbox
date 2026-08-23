import type { JsonValue, Secret } from "@signalbox/secrets"
import { z } from "zod"

/** Registry of schemas whose top-level values are secret. */
export const secrets = z.registry<{ secret: true }>()

declare const secretBrand: unique symbol
declare const configShape: unique symbol

/** A raw Zod schema branded as a top-level secret declaration. */
export type SecretSchema<T extends z.ZodType> = T & { readonly [secretBrand]: true }

/** Register on a non-generic schema so Zod's conditional register overload resolves. */
const markSecret = (schema: z.ZodType): void => {
    schema.register(secrets, { secret: true })
}

interface FieldMeta {
    readonly secret?: boolean
}

/** A config-field builder carrying its underlying schema and secret flag. */
export class Field<TSchema extends z.ZodType, TSecret extends boolean = false> {
    declare private readonly secretType?: TSecret

    constructor(
        /** The underlying Zod schema. */
        readonly zod: TSchema,
        /** Signalbox field metadata. */
        readonly meta: FieldMeta = {},
    ) {}

    /** Mark this top-level field as secret. */
    secret(): Field<TSchema, true> {
        return new Field(this.zod, { ...this.meta, secret: true })
    }

    /** Attach a description used by CLI prompts and OpenAPI. */
    describe(text: string): Field<TSchema, TSecret> {
        return new Field(this.zod.describe(text), this.meta)
    }

    /** Make this field optional while preserving its secret flag. */
    optional(): Field<z.ZodOptional<TSchema>, TSecret> {
        return new Field(this.zod.optional(), this.meta)
    }

    /** Give this non-secret field a default value. Secret defaults are rejected by config(). */
    default(value: z.output<TSchema>): Field<z.ZodDefault<TSchema>, TSecret> {
        return new Field(this.zod.default(value as never), this.meta)
    }
}

class StringField<TSecret extends boolean = false> extends Field<z.ZodString, TSecret> {
    override secret(): StringField<true> {
        return new StringField(this.zod, { ...this.meta, secret: true })
    }

    override describe(text: string): StringField<TSecret> {
        return new StringField(this.zod.describe(text), this.meta)
    }

    min(length: number): StringField<TSecret> {
        return new StringField(this.zod.min(length), this.meta)
    }

    max(length: number): StringField<TSecret> {
        return new StringField(this.zod.max(length), this.meta)
    }

    regex(pattern: RegExp): StringField<TSecret> {
        return new StringField(this.zod.regex(pattern), this.meta)
    }
}

class NumberField<TSecret extends boolean = false> extends Field<z.ZodNumber, TSecret> {
    override secret(): NumberField<true> {
        return new NumberField(this.zod, { ...this.meta, secret: true })
    }

    override describe(text: string): NumberField<TSecret> {
        return new NumberField(this.zod.describe(text), this.meta)
    }

    positive(): NumberField<TSecret> {
        return new NumberField(this.zod.min(1), this.meta)
    }

    min(value: number): NumberField<TSecret> {
        return new NumberField(this.zod.min(value), this.meta)
    }

    max(value: number): NumberField<TSecret> {
        return new NumberField(this.zod.max(value), this.meta)
    }
}

class ListField<TSecret extends boolean = false> extends Field<z.ZodArray<z.ZodString>, TSecret> {
    override secret(): ListField<true> {
        return new ListField(this.zod, { ...this.meta, secret: true })
    }

    override describe(text: string): ListField<TSecret> {
        return new ListField(this.zod.describe(text), this.meta)
    }

    nonempty(): ListField<TSecret> {
        return new ListField(this.zod.min(1), this.meta)
    }
}

/** Start a config field and select its base type. */
export const field = () => ({
    string: (): StringField => new StringField(z.string()),
    int: (): NumberField => new NumberField(z.number().int()),
    bool: (): Field<z.ZodBoolean> => new Field(z.boolean()),
    list: (): ListField => new ListField(z.array(z.string())),
})

/** Mark a raw outermost Zod field schema as secret. */
export const secret = <T extends z.ZodType>(schema: T): SecretSchema<T> => {
    markSecret(schema)
    return schema as SecretSchema<T>
}

export type ConfigDeclaration = Record<string, Field<z.ZodType, boolean> | z.ZodType>
type ZodOf<F> = F extends Field<infer T, boolean> ? T : F extends z.ZodType ? F : never
type ShapeOf<S extends ConfigDeclaration> = { [K in keyof S]: ZodOf<S[K]> }

/** A Zod object retaining the original declaration as phantom type metadata. */
export type ConfigSchema<S extends ConfigDeclaration = ConfigDeclaration> = z.ZodObject<ShapeOf<S>> & {
    readonly [configShape]?: S
}

type IsSecretDeclaration<D> =
    D extends Field<z.ZodType, infer TSecret>
        ? TSecret extends true
            ? true
            : false
        : D extends SecretSchema<z.ZodType>
          ? true
          : false
type InputValue<D> = z.input<ZodOf<D>>
type OutputValue<D> = z.output<ZodOf<D>>
type SecretValue<T> = Exclude<T, undefined> extends JsonValue ? Secret<Exclude<T, undefined>> : Secret<JsonValue>
type RuntimeValue<D> =
    IsSecretDeclaration<D> extends true
        ? undefined extends OutputValue<D>
            ? SecretValue<OutputValue<D>> | undefined
            : SecretValue<OutputValue<D>>
        : OutputValue<D>
type OptionalInputKeys<S extends ConfigDeclaration> = {
    [K in keyof S]-?: undefined extends InputValue<S[K]> ? K : never
}[keyof S]
type OptionalRuntimeKeys<S extends ConfigDeclaration> = {
    [K in keyof S]-?: undefined extends OutputValue<S[K]> ? K : never
}[keyof S]
type ProjectInput<S extends ConfigDeclaration> = {
    [K in Exclude<keyof S, OptionalInputKeys<S>>]: InputValue<S[K]>
} & { [K in OptionalInputKeys<S>]?: InputValue<S[K]> }
type ProjectRuntime<S extends ConfigDeclaration> = {
    [K in Exclude<keyof S, OptionalRuntimeKeys<S>>]: RuntimeValue<S[K]>
} & { [K in OptionalRuntimeKeys<S>]?: RuntimeValue<S[K]> }

type DeclarationOf<C> = C extends ConfigSchema<infer S> ? S : never

/** Plaintext values accepted by a config store. */
export type InputOf<C extends ConfigSchema> = ProjectInput<DeclarationOf<C>>

/** Runtime config values, with every present secret wrapped in Secret<T>. */
export type ConfigOf<C extends ConfigSchema> = ProjectRuntime<DeclarationOf<C>>

interface ZodInternals {
    readonly def?: unknown
}

const isZodSchema = (value: unknown): value is z.ZodType =>
    typeof value === "object" && value !== null && "_zod" in value

const visitChildren = (value: unknown, visit: (schema: z.ZodType) => boolean): boolean => {
    if (isZodSchema(value)) return visit(value)
    if (Array.isArray(value)) return value.some(entry => visitChildren(entry, visit))
    if (typeof value !== "object" || value === null) return false
    return Object.values(value).some(entry => visitChildren(entry, visit))
}

const schemaContains = (schema: z.ZodType, predicate: (schema: z.ZodType) => boolean): boolean => {
    const seen = new Set<z.ZodType>()
    const search = (candidate: z.ZodType): boolean => {
        if (seen.has(candidate)) return false
        seen.add(candidate)
        if (predicate(candidate)) return true
        return visitChildren((candidate._zod as ZodInternals).def, search)
    }
    return search(schema)
}

const schemaType = (schema: z.ZodType): string | undefined =>
    ((schema._zod as ZodInternals).def as { type?: string } | undefined)?.type

/** Assemble a config schema and validate v1 top-level secret constraints. */
export const config = <S extends ConfigDeclaration>(shape: S): ConfigSchema<S> => {
    const zodShape: Record<string, z.ZodType> = {}
    for (const [key, declaration] of Object.entries(shape)) {
        const fieldSchema = declaration instanceof Field ? declaration.zod : declaration
        const topLevelSecret =
            declaration instanceof Field ? declaration.meta.secret === true : secrets.has(fieldSchema)
        const nestedSecret = visitChildren((fieldSchema._zod as ZodInternals).def, child =>
            schemaContains(child, candidate => secrets.has(candidate)),
        )
        if (
            (topLevelSecret || nestedSecret) &&
            schemaContains(fieldSchema, candidate => schemaType(candidate) === "default")
        ) {
            throw new Error(`secret field "${key}" cannot have a default value`)
        }
        if (nestedSecret) throw new Error(`secret field "${key}" must be marked on its outermost top-level schema`)
        zodShape[key] = fieldSchema
        if (topLevelSecret) markSecret(fieldSchema)
    }
    return z.object(zodShape) as ConfigSchema<S>
}

/** Backward-compatible alias for the runtime config projection. */
export type Infer<C extends ConfigSchema> = ConfigOf<C>
