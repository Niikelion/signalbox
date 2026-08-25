import { defineConfig } from "eslint/config"
import * as js from "@eslint/js"
import * as tseslint from "typescript-eslint"
// @ts-ignore
import eslintConfigPrettier from "eslint-plugin-prettier/recommended"

export const eslintConfig = defineConfig(
    js.configs.recommended,
    tseslint.configs.strictTypeChecked,
    tseslint.configs.stylisticTypeChecked,
    eslintConfigPrettier,
    {
        languageOptions: {
            parserOptions: {
                projectService: true,
            },
        },
    },
    {
        rules: {
            "no-empty": ["error", { allowEmptyCatch: true }],
            "@typescript-eslint/no-unused-vars": [
                "error",
                {
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                },
            ],
            "@typescript-eslint/no-import-type-side-effects": "error",
            "@typescript-eslint/consistent-type-definitions": "off",
            "@typescript-eslint/restrict-template-expressions": "off",
            "@typescript-eslint/no-invalid-void-type": "off",
            "@typescript-eslint/require-await": "off",
            "no-restricted-syntax": [
                "error",
                {
                    selector: "ImportDeclaration[source.value=/^\\.{1,2}\\/.*\\.js$/]",
                    message: "Omit .js from relative TypeScript imports when the target can be resolved.",
                },
                {
                    selector: "ExportNamedDeclaration[source.value=/^\\.{1,2}\\/.*\\.js$/]",
                    message: "Omit .js from relative TypeScript exports when the target can be resolved.",
                },
                {
                    selector: "ExportAllDeclaration[source.value=/^\\.{1,2}\\/.*\\.js$/]",
                    message: "Omit .js from relative TypeScript exports when the target can be resolved.",
                },
                {
                    selector: "ImportExpression[source.value=/^\\.{1,2}\\/.*\\.js$/]",
                    message: "Omit .js from relative TypeScript dynamic imports when the target can be resolved.",
                },
            ],
        },
    },
    {
        ignores: ["dist/**", "coverage/**", "*.generated.ts"],
    },
)
