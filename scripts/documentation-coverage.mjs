import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import path from "node:path"

import {
    analyzeProject,
    extractProject,
    resolvePublicEntryPoints,
    shouldFail,
    totals,
} from "./documentation-coverage-lib.mjs"

const root = process.cwd()
const configFile = path.join(root, "documentation-coverage.config.json")
const outputDir = path.join(root, "documentation-coverage")
const outputFile = path.join(outputDir, "summary.json")

const readJson = file => JSON.parse(readFileSync(file, "utf8"))

const publishablePackages = () =>
    readdirSync(path.join(root, "packages"), { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => {
            const dir = path.join(root, "packages", entry.name)
            const manifestFile = path.join(dir, "package.json")
            if (!existsSync(manifestFile)) return undefined
            const manifest = readJson(manifestFile)
            if (manifest.private || !manifest.types) return undefined
            return { dir, manifest }
        })
        .filter(Boolean)
        .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))

const validateConfig = (config, packages) => {
    if (!Number.isInteger(config.findingLimit) || config.findingLimit < 0) {
        throw new Error("findingLimit must be a non-negative integer")
    }
    const configured = Object.keys(config.packages ?? {}).sort()
    const discovered = packages.map(item => item.manifest.name).sort()
    const missing = discovered.filter(name => !configured.includes(name))
    const unknown = configured.filter(name => !discovered.includes(name))
    if (missing.length || unknown.length) {
        throw new Error(
            [
                `configuration does not match publishable packages`,
                `missing: ${missing.join(", ") || "none"}`,
                `unknown: ${unknown.join(", ") || "none"}`,
            ].join("; "),
        )
    }
    for (const [name, mode] of Object.entries(config.packages)) {
        if (mode !== "report" && mode !== "enforce") throw new Error(`${name} has invalid mode ${mode}`)
    }
}

const markdown = (summary, findingLimit) => {
    const lines = ["## Documentation Coverage", ""]
    lines.push(
        `**Repo total:** ${summary.repository.percentage.toFixed(2)}% (${summary.repository.documented}/${summary.repository.required} documented items; ${summary.repository.missing} missing).`,
    )
    lines.push("")
    lines.push("| Package | Mode | Coverage | Documented | Missing | Status |")
    lines.push("| --- | --- | ---: | ---: | ---: | --- |")
    for (const item of summary.packages) {
        lines.push(
            `| ${item.name} | ${item.mode} | ${item.percentage.toFixed(2)}% | ${item.documented}/${item.required} | ${item.missing} | ${item.status} |`,
        )
    }
    lines.push("")
    if (summary.failures.length) {
        lines.push("### Extraction failures", "")
        summary.failures.forEach(failure => lines.push(`- ${failure.package}: ${failure.message}`))
        lines.push("")
    }
    const findings = summary.findings.slice(0, findingLimit)
    if (findings.length) {
        lines.push(`### Missing documentation (first ${findings.length} of ${summary.findings.length})`, "")
        for (const finding of findings) {
            const file = finding.file ?? "unknown"
            lines.push(
                `- ${finding.package}: ${finding.symbol} — ${finding.requirement} (${file}:${finding.line ?? 0}:${finding.column ?? 0})`,
            )
        }
        lines.push("")
    }
    return `${lines.join("\n")}\n`
}

const main = async () => {
    const packages = publishablePackages()
    const config = readJson(configFile)
    validateConfig(config, packages)
    const results = []
    const failures = []

    for (const item of packages) {
        const name = item.manifest.name
        const mode = config.packages[name]
        try {
            const entryPoints = resolvePublicEntryPoints({
                packageDir: item.dir,
                manifest: item.manifest,
            })
            const project = await extractProject({
                entryPoints: entryPoints.sources,
                tsconfig: path.join(item.dir, "tsconfig.json"),
            })
            const result = analyzeProject({
                packageName: name,
                packageDir: item.dir,
                project,
            })
            result.findings = result.findings.map(finding => ({
                ...finding,
                file: finding.file ? path.relative(root, finding.file).replaceAll("\\", "/") : undefined,
            }))
            results.push({
                name,
                mode,
                ...result,
                status: mode === "enforce" && result.missing ? "failed" : "passed",
            })
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            failures.push({ package: name, message })
            results.push({
                name,
                mode,
                required: 0,
                documented: 0,
                missing: 0,
                percentage: 0,
                findings: [],
                status: "error",
            })
        }
    }

    const repository = totals(results.filter(result => result.status !== "error"))
    const summary = {
        generatedAt: new Date().toISOString(),
        repository,
        packages: results.map(({ findings: _findings, ...result }) => result),
        findings: results.flatMap(result => result.findings),
        failures,
    }
    mkdirSync(outputDir, { recursive: true })
    writeFileSync(outputFile, `${JSON.stringify(summary, null, 2)}\n`)

    const requestedLimit = Number(process.env.DOCUMENTATION_COVERAGE_ROWS ?? config.findingLimit)
    const findingLimit = Number.isInteger(requestedLimit) && requestedLimit >= 0 ? requestedLimit : config.findingLimit
    console.log(markdown(summary, findingLimit))

    if (shouldFail(results, failures)) process.exitCode = 1
}

main().catch(error => {
    mkdirSync(outputDir, { recursive: true })
    const message = error instanceof Error ? error.message : String(error)
    const summary = {
        generatedAt: new Date().toISOString(),
        repository: { required: 0, documented: 0, missing: 0, percentage: 0 },
        packages: [],
        findings: [],
        failures: [{ package: "configuration", message }],
    }
    writeFileSync(outputFile, `${JSON.stringify(summary, null, 2)}\n`)
    console.error(`Documentation coverage failed: ${message}`)
    process.exitCode = 1
})
