# @signalbox/config

## 0.2.0

### Minor Changes

- 41f64fd: Move config to a Zod-based schema in the new `@signalbox/config` package.

    - `@signalbox/config` (new): a `field()` builder (`field().string().secret()…`) that
      produces Zod schemas, `config({...})` to assemble them (mixing `field()` and raw
      `z.*`), a `secret()` helper backed by an isolated registry (no global side
      effects), and a `createConfigStore` that validates the file on load via `.parse()`,
      coerces CLI strings by introspecting each field, and redacts secrets. Re-exports `z`.
    - `service-cli`: `ServiceApp` is now generic over a `z.ZodObject`; the `config`
      command introspects the schema (required / secret / description) instead of the
      old `FieldSpec` shape.
    - `@signalbox/core`: the bespoke schema/config store is removed (`createConfigStore`,
      `ConfigSchema`, `ConfigOf`, `FieldSpec`, …); `isRoot` remains, exported from core.

    The DDNS apps now declare their config with `field()` and derive the type with
    `Infer<typeof configSchema>`.

### Patch Changes

- Updated dependencies [fc7f053]
- Updated dependencies [a52570e]
- Updated dependencies [a7877e4]
- Updated dependencies [ad7aba3]
- Updated dependencies [41f64fd]
    - @signalbox/core@0.2.0
