import { defineConfig } from "tsdown"

export default defineConfig([
    {
        attw: true,
        format: ["esm", "cjs"],
        entry: ["src/index.ts"],
    },
])
