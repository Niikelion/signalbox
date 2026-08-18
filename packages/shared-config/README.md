# @signalbox/shared-config

Shared ESLint and Prettier configuration for the signalbox monorepo. Internal tooling —
`private`, not published to npm.

Every package consumes the same rules from here, so linting and formatting stay identical
across the workspace.

## What's inside

- **`@signalbox/shared-config/eslint`** — a flat ESLint config: `@eslint/js` recommended,
  `typescript-eslint` `strictTypeChecked` + `stylisticTypeChecked` (type-aware via
  `projectService`), with `eslint-plugin-prettier` wired in.
- **`@signalbox/shared-config/prettier`** — the shared Prettier options.

TypeScript settings come from [`@gamedev-sensei/ts-config`](https://www.npmjs.com/package/@gamedev-sensei/ts-config),
referenced by each package's `tsconfig.json`.

## Usage

Each package re-exports the shared configs from its own config files:

```ts
// eslint.config.mts
import { eslintConfig } from "@signalbox/shared-config/eslint"
export default eslintConfig
```

```ts
// prettier.config.mts
import { prettierConfig } from "@signalbox/shared-config/prettier"
export default prettierConfig
```

The `.mts` files are loaded through `jiti`, so the TypeScript sources are consumed
directly — there's no build step for this package.

## License

MIT
