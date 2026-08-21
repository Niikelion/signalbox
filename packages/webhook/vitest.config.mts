import { defineConfig } from "vitest/config"

export default defineConfig({
    test: {
        environment: "node",
        // run the *.test-d.ts type tests alongside the runtime suite
        typecheck: { enabled: true },
    },
})
