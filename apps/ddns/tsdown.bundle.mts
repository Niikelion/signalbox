import { defineConfig } from "tsdown"

// Throwaway config: inlines the @signalbox/* workspace deps into a single file so
// the CLI can be dropped onto a machine that has neither yarn nor node_modules.
// Not part of the published build.
export default defineConfig([
    {
        format: ["esm"],
        entry: ["src/cli.ts"],
        outDir: "dist-bundle",
        noExternal: [/^@signalbox\//],
        dts: false,
        target: "node18",
    },
])
