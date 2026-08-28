import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const root = process.cwd()
const workspaceRoots = ["packages", "apps", "examples"]
const summaryFile = process.env["GITHUB_STEP_SUMMARY"]
const maxRows = Number(process.env.CI_SUMMARY_ROWS ?? 10)

const readJson = file => JSON.parse(readFileSync(file, "utf8"))

const workspacePackageDirs = () => {
    const dirs = []
    for (const rootName of workspaceRoots) {
        const workspaceRoot = path.join(root, rootName)
        if (!existsSync(workspaceRoot)) continue
        for (const entry of readdirSync(workspaceRoot)) {
            const dir = path.join(workspaceRoot, entry)
            const packageJson = path.join(dir, "package.json")
            if (!existsSync(packageJson)) continue
            const manifest = readJson(packageJson)
            dirs.push({ dir, name: manifest.name ?? `${rootName}/${entry}` })
        }
    }
    return dirs
}

const formatPct = value => {
    if (typeof value !== "number") return String(value)
    return `${value.toFixed(2)}%`
}

const formatNumber = value => String(value ?? 0)

const coverageRows = () => {
    const rows = []
    const aggregate = {
        statements: { total: 0, covered: 0 },
        branches: { total: 0, covered: 0 },
        functions: { total: 0, covered: 0 },
        lines: { total: 0, covered: 0 },
    }

    for (const workspace of workspacePackageDirs()) {
        const file = path.join(workspace.dir, "coverage", "coverage-summary.json")
        if (!existsSync(file)) continue
        const total = readJson(file).total
        rows.push({ packageName: workspace.name, total })
        for (const key of Object.keys(aggregate)) {
            aggregate[key].total += total[key]?.total ?? 0
            aggregate[key].covered += total[key]?.covered ?? 0
        }
    }

    const aggregateTotal = Object.fromEntries(
        Object.entries(aggregate).map(([key, value]) => [
            key,
            {
                ...value,
                pct: value.total === 0 ? 100 : (value.covered / value.total) * 100,
            },
        ]),
    )

    return {
        rows: rows.sort((a, b) => a.packageName.localeCompare(b.packageName)),
        aggregate: aggregateTotal,
    }
}

const cognitiveSummary = () => {
    const file = path.join(root, "cognitive-load", "summary.json")
    return existsSync(file) ? readJson(file) : undefined
}

const documentationSummary = () => {
    const file = path.join(root, "documentation-coverage", "summary.json")
    return existsSync(file) ? readJson(file) : undefined
}

const markdown = () => {
    const coverage = coverageRows()
    const cognitive = cognitiveSummary()
    const documentation = documentationSummary()
    const lines = []

    lines.push("## Signalbox Quality Report")
    lines.push("")

    if (coverage.rows.length > 0) {
        lines.push("### Coverage")
        lines.push("")
        lines.push(
            `**Repo total:** ${formatPct(coverage.aggregate.lines.pct)} lines, ${formatPct(coverage.aggregate.branches.pct)} branches, ${formatPct(coverage.aggregate.functions.pct)} functions, ${formatPct(coverage.aggregate.statements.pct)} statements.`,
        )
        lines.push("")
        lines.push("| Package | Lines | Branches | Functions | Statements |")
        lines.push("| --- | ---: | ---: | ---: | ---: |")
        for (const row of coverage.rows) {
            lines.push(
                `| ${row.packageName} | ${formatPct(row.total.lines.pct)} | ${formatPct(row.total.branches.pct)} | ${formatPct(row.total.functions.pct)} | ${formatPct(row.total.statements.pct)} |`,
            )
        }
        lines.push("")
    } else {
        lines.push("### Coverage")
        lines.push("")
        lines.push("No coverage summaries were found.")
        lines.push("")
    }

    lines.push("### Documentation Coverage")
    lines.push("")
    if (documentation) {
        lines.push(
            `**Repo total:** ${formatPct(documentation.repository.percentage)} (${formatNumber(documentation.repository.documented)}/${formatNumber(documentation.repository.required)} documented items; ${formatNumber(documentation.repository.missing)} missing).`,
        )
        lines.push("")
        lines.push("| Package | Mode | Coverage | Documented | Missing | Status |")
        lines.push("| --- | --- | ---: | ---: | ---: | --- |")
        for (const item of documentation.packages) {
            lines.push(
                `| ${item.name} | ${item.mode} | ${formatPct(item.percentage)} | ${formatNumber(item.documented)}/${formatNumber(item.required)} | ${formatNumber(item.missing)} | ${item.status} |`,
            )
        }
        if (documentation.failures.length > 0) {
            lines.push("")
            lines.push("#### Extraction Failures")
            lines.push("")
            for (const failure of documentation.failures) lines.push(`- ${failure.package}: ${failure.message}`)
        }
        if (documentation.findings.length > 0) {
            lines.push("")
            lines.push("#### Missing Documentation")
            lines.push("")
            for (const finding of documentation.findings.slice(0, maxRows)) {
                const location = finding.file
                    ? `${finding.file}:${formatNumber(finding.line)}:${formatNumber(finding.column)}`
                    : "unknown"
                lines.push(`- ${finding.package}: ${finding.symbol} — ${finding.requirement} (${location})`)
            }
        }
    } else {
        lines.push("No documentation-coverage summary was found.")
    }

    lines.push("")
    lines.push("### Cognitive Load")
    lines.push("")
    if (cognitive) {
        lines.push(
            `**SonarJS findings:** ${formatNumber(cognitive.findings)} across ${formatNumber(cognitive.workspaces)} workspaces.`,
        )
        lines.push("")
        lines.push("#### Top Hotspots")
        lines.push("")
        lines.push("| Score | Package | Location |")
        lines.push("| ---: | --- | --- |")
        for (const record of cognitive.top.slice(0, maxRows)) {
            lines.push(
                `| ${formatNumber(record.score)} | ${record.packageName} | ${record.file}:${formatNumber(record.line)}:${formatNumber(record.column)} |`,
            )
        }
        lines.push("")
        lines.push("#### Package Totals")
        lines.push("")
        lines.push("| Package | Findings | Total | Max | Average |")
        lines.push("| --- | ---: | ---: | ---: | ---: |")
        for (const [packageName, total] of Object.entries(cognitive.packages).sort(
            (a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]),
        )) {
            lines.push(
                `| ${packageName} | ${formatNumber(total.functions)} | ${formatNumber(total.total)} | ${formatNumber(total.max)} | ${Number(total.average).toFixed(2)} |`,
            )
        }
    } else {
        lines.push("No cognitive-load summary was found.")
    }

    lines.push("")
    return `${lines.join("\n")}\n`
}

const output = markdown()

if (summaryFile) {
    appendFileSync(summaryFile, output)
    console.log(`Wrote quality report to ${summaryFile}`)
} else {
    console.log(output)
}
