export { z } from "zod"

export { config, field, secret, secrets, Field } from "./schema"
export type { ConfigDeclaration, ConfigOf, ConfigSchema, Infer, InputOf, SecretSchema } from "./schema"

export { baseKind, describeOf, isRequired, isSecret } from "./introspect"
export type { BaseKind } from "./introspect"

export { createConfigStore } from "./store"
export type {
    ConfigInspection,
    ConfigKeyInfo,
    ConfigPurgeResult,
    ConfigRekeyPending,
    ConfigRekeyResult,
    ConfigStore,
    ConfigStoreOptions,
} from "./store"

export { isSecret as isSecretValue, REDACTED, Secret } from "@signalbox/secrets"
export type { JsonPrimitive, JsonValue, KeySource, WritableKeyBackend } from "@signalbox/secrets"
