import path from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, test } from "vitest"

import { readFileSync } from "node:fs"

import {
    analyzeProject,
    extractProject,
    resolvePublicEntryPoints,
    shouldFail,
    totals,
} from "./documentation-coverage-lib.mjs"

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "documentation-coverage")

describe("documentation coverage", () => {
    test("extracts exported APIs and applies documentation rules", async () => {
        const manifest = JSON.parse(readFileSync(path.join(fixtureDir, "package.json"), "utf8"))
        const entryPoints = resolvePublicEntryPoints({
            packageDir: fixtureDir,
            manifest,
        })
        const project = await extractProject({
            entryPoints: entryPoints.sources,
            tsconfig: path.join(fixtureDir, "tsconfig.json"),
        })
        const result = analyzeProject({
            packageName: "fixture",
            packageDir: fixtureDir,
            project,
        })
        const findings = result.findings.map(finding => `${finding.symbol}:${finding.requirement}`)

        expect(result.required).toBeGreaterThan(0)
        expect(findings).not.toContain(expect.stringContaining("unexported"))
        expect(findings).not.toContain(expect.stringContaining("internalOnly"))
        expect(findings).not.toContain(expect.stringContaining("hidden"))
        expect(findings).not.toContain(expect.stringContaining("guarded"))
        expect(findings).not.toContain(expect.stringContaining("Child.inherited"))
        expect(findings).not.toContain("documented:@param required")
        expect(findings).not.toContain("documented:@param optional")
        expect(findings).not.toContain("documented:@param rest")
        expect(findings).not.toContain("documented:@typeParam T")
        expect(findings).not.toContain("overloaded:@param value")
        expect(findings).not.toContain("Surface.callback:@param input")
        expect(findings).not.toContain("Surface.callback:@typeParam T")
        expect(findings).not.toContain("ChildSurface.inheritedDocumentation:summary")
        expect(findings).not.toContain(expect.stringContaining("secondary"))
        expect(findings).not.toContain(expect.stringContaining("@returns"))
        expect(findings).not.toContain(expect.stringContaining("destructured"))
        expect(findings).toContain("missingParameter:@param value")
        expect(findings).toContain("missingOptional:@param optional")
        expect(findings).toContain("missingRest:@param rest")
        expect(findings).toContain("missingDestructured:@param __namedParameters")
        expect(findings).toContain("missingGeneric:@typeParam T")
        expect(findings).toContain("MissingCallback.callback:@param input")
        expect(findings).toContain("missingSummary:summary")
        expect(findings.filter(finding => finding.includes("inherited"))).toHaveLength(0)
        expect(entryPoints.sources.map(file => path.basename(file)).sort()).toEqual(["index.ts", "secondary.ts"])
        expect(result.findings.filter(finding => finding.symbol === "secondary")).toHaveLength(0)
        expect(shouldFail([{ ...result, mode: "report" }], [])).toBe(false)
        expect(shouldFail([{ ...result, mode: "enforce" }], [])).toBe(true)
        expect(shouldFail([{ ...result, mode: "enforce", missing: 0 }], [])).toBe(false)
    })

    test("weights every requirement as one item", () => {
        expect(
            totals([
                { required: 3, documented: 2 },
                { required: 1, documented: 1 },
            ]),
        ).toEqual({ required: 4, documented: 3, missing: 1, percentage: 75 })
        expect(totals([])).toEqual({
            required: 0,
            documented: 0,
            missing: 0,
            percentage: 100,
        })
    })

    test("enforces only packages opted into enforcement", () => {
        expect(shouldFail([{ mode: "report", missing: 3 }], [])).toBe(false)
        expect(shouldFail([{ mode: "enforce", missing: 0 }], [])).toBe(false)
        expect(shouldFail([{ mode: "enforce", missing: 1 }], [])).toBe(true)
        expect(shouldFail([], [{ package: "fixture", message: "extraction failed" }])).toBe(true)
    })
})
