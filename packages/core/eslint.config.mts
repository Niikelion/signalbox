import { defineConfig } from "eslint/config"
import { eslintConfig } from "@signalbox/shared-config/eslint"

export default defineConfig(eslintConfig, {
    rules: {
        "no-restricted-imports": [
            "error",
            {
                patterns: [
                    {
                        group: ["../*", "../../*"],
                        message: "Use @/ imports instead of parent-relative paths when importing within core.",
                    },
                ],
            },
        ],
    },
})
