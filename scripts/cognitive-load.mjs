import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"

const root = process.cwd()
const workspaceRoots = ["packages", "apps", "examples"]
const reportDirName = "cognitive-load"
const eslintJsonName = "eslint.json"
const maxRows = Number(process.env.COGNITIVE_LOAD_ROWS ?? 25)
const yarnCommand = process.platform === "win32" ? "cmd.exe" : "yarn"
const yarnArgs = args => (process.platform === "win32" ? ["/d", "/s", "/c", "yarn", ...args] : args)

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
            if (!manifest.scripts?.lint || !existsSync(path.join(dir, "src"))) continue
            dirs.push({ dir, name: manifest.name ?? `${rootName}/${entry}` })
        }
    }
    return dirs
}

const scoreFromMessage = message => {
    const match = /from (?<score>\d+) to the \d+ allowed/u.exec(message)
    return match?.groups?.score ? Number(match.groups.score) : 0
}

const runEslint = workspace => {
    const reportDir = path.join(workspace.dir, reportDirName)
    const reportFile = path.join(reportDir, eslintJsonName)
    rmSync(reportDir, { recursive: true, force: true })
    mkdirSync(reportDir, { recursive: true })

    const result = spawnSync(
        yarnCommand,
        yarnArgs(["workspace", workspace.name, "eslint", "src", "--format", "json", "--output-file", reportFile]),
        {
            cwd: root,
            env: { ...process.env, COGNITIVE_LOAD: "1" },
            encoding: "utf8",
            maxBuffer: 1024 * 1024 * 50,
        },
    )

    if (!existsSync(reportFile)) {
        return {
            workspace,
            reportFile,
            records: [],
            error:
                result.error?.message ||
                result.stderr ||
                result.stdout ||
                `eslint exited with status ${String(result.status)}`,
        }
    }

    const eslintResults = readJson(reportFile)
    const records = []

    for (const fileResult of eslintResults) {
        for (const message of fileResult.messages) {
            if (message.ruleId !== "sonarjs/cognitive-complexity") continue
            records.push({
                packageName: workspace.name,
                file: path.relative(root, fileResult.filePath).replaceAll(path.sep, "/"),
                line: message.line,
                column: message.column,
                score: scoreFromMessage(message.message),
                message: message.message,
            })
        }
    }

    return { workspace, reportFile, records, error: undefined }
}

const results = workspacePackageDirs().map(runEslint)
const records = results.flatMap(result => result.records)
const failures = results.filter(result => result.error)
const totals = new Map()
const rootReportDir = path.join(root, reportDirName)

rmSync(rootReportDir, { recursive: true, force: true })
mkdirSync(rootReportDir, { recursive: true })

for (const result of results) {
    const total = totals.get(result.workspace.name) ?? { files: 0, functions: 0, total: 0, max: 0 }
    const eslintResults = existsSync(result.reportFile) ? readJson(result.reportFile) : []
    total.files += eslintResults.length
    total.functions += result.records.length
    total.total += result.records.reduce((sum, record) => sum + record.score, 0)
    total.max = Math.max(total.max, ...result.records.map(record => record.score), 0)
    totals.set(result.workspace.name, total)
}

const sorted = records.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line)

const summary = {
    generatedAt: new Date().toISOString(),
    workspaces: results.length,
    findings: records.length,
    top: sorted.slice(0, maxRows),
    packages: Object.fromEntries(
        [...totals.entries()].map(([name, total]) => [
            name,
            {
                ...total,
                average: total.functions === 0 ? 0 : Number((total.total / total.functions).toFixed(2)),
            },
        ]),
    ),
}

writeFileSync(path.join(rootReportDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`)

console.log("Cognitive load report")
console.log("")
console.log(`Generated ESLint JSON in each workspace's ${reportDirName}/${eslintJsonName}.`)
console.log(`Scanned ${String(results.length)} workspaces and found ${String(records.length)} SonarJS cognitive-complexity findings.`)

if (failures.length > 0) {
    console.log("")
    console.log("Workspaces without JSON output:")
    for (const failure of failures) console.log(`- ${failure.workspace.name}: ${failure.error.trim()}`)
}

console.log("")
console.log("Top hotspots:")
console.log("| Score | Location |")
console.log("| ---: | --- |")
for (const record of sorted.slice(0, maxRows)) {
    console.log(`| ${String(record.score)} | ${record.file}:${String(record.line)}:${String(record.column)} |`)
}

console.log("")
console.log("Package totals:")
console.log("| Package | Files | Findings | Total | Max | Average |")
console.log("| --- | ---: | ---: | ---: | ---: | ---: |")
for (const [name, total] of [...totals.entries()].sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]))) {
    const average = total.functions === 0 ? 0 : total.total / total.functions
    console.log(
        `| ${name} | ${String(total.files)} | ${String(total.functions)} | ${String(total.total)} | ${String(total.max)} | ${average.toFixed(2)} |`,
    )
}

if (failures.length > 0) process.exitCode = 1
