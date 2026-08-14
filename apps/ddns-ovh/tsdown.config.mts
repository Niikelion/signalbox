import { defineConfig } from "tsdown"

export default defineConfig([
    {
        // ESM only: the CLI uses import.meta and is never require()d
        format: ["esm"],
        entry: ["src/index.ts", "src/cli.ts"],
    },
])
