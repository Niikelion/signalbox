import { defineConfig } from "tsdown"

export default defineConfig([
    {
        format: ["esm"],
        entry: ["src/cli.ts"],
    },
])
