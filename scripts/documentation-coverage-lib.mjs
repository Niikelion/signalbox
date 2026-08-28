import { existsSync } from "node:fs"
import path from "node:path"

import { Application, ReflectionKind } from "typedoc"

const documentedKinds = new Set([
    ReflectionKind.Function,
    ReflectionKind.Variable,
    ReflectionKind.Class,
    ReflectionKind.Interface,
    ReflectionKind.Enum,
    ReflectionKind.TypeAlias,
    ReflectionKind.Constructor,
    ReflectionKind.Property,
    ReflectionKind.Method,
    ReflectionKind.Accessor,
    ReflectionKind.EnumMember,
])

const signatureKinds = new Set([
    ReflectionKind.CallSignature,
    ReflectionKind.ConstructorSignature,
    ReflectionKind.IndexSignature,
])

const textOf = comment =>
    comment?.summary
        ?.map(part => part.text ?? "")
        .join("")
        .trim() ?? ""

const hasDocumentation = reflection => textOf(reflection?.comment).length > 0

const hasSummary = reflection =>
    hasDocumentation(reflection) ||
    (reflection?.signatures ?? []).some(hasDocumentation) ||
    (reflection?.type?.type === "reflection" && (reflection.type.declaration.signatures ?? []).some(hasDocumentation))

const isPrivate = reflection =>
    reflection?.flags?.isPrivate || reflection?.flags?.isProtected || reflection?.flags?.isExternal

const sourceOf = (reflection, fallback) => reflection?.sources?.[0] ?? fallback

const isOwned = (reflection, packageDir, fallbackSource) => {
    const source = sourceOf(reflection, fallbackSource)
    if (!source?.fullFileName) return Boolean(fallbackSource)
    const relative = path.relative(packageDir, source.fullFileName)
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
}

const displayKind = kind => ReflectionKind.singularString(kind)

const symbolPath = reflection => {
    const names = []
    let current = reflection
    while (current?.parent) {
        if (current.name && current.name !== "__type" && current.kind !== ReflectionKind.Module) {
            names.push(current.name)
        }
        current = current.parent
    }
    return (
        names
            .reverse()
            .filter((name, index, all) => index === 0 || name !== all[index - 1])
            .join(".") || reflection.name
    )
}

const locationOf = (reflection, fallbackSource) => {
    const source = sourceOf(reflection, fallbackSource)
    return {
        file: source?.fullFileName,
        line: source?.line,
        column: source?.character === undefined ? undefined : source.character + 1,
    }
}

const uniqueNamed = reflections => {
    const byName = new Map()
    for (const reflection of reflections) {
        const key = reflection.name
        const existing = byName.get(key)
        if (!existing || (!hasDocumentation(existing) && hasDocumentation(reflection))) {
            byName.set(key, reflection)
        }
    }
    return [...byName.values()]
}

export const analyzeProject = ({ packageName, packageDir, project }) => {
    const items = []
    const visited = new Set()

    const record = (reflection, requirement, documented, fallbackSource, locationReflection = reflection) => {
        const location = locationOf(locationReflection, fallbackSource)
        items.push({
            package: packageName,
            symbol: symbolPath(reflection),
            symbolKind: displayKind(reflection.kind),
            kind:
                requirement === "summary"
                    ? "summary"
                    : requirement.startsWith("@param")
                      ? "parameter"
                      : "typeParameter",
            requirement,
            documented,
            ...location,
        })
    }

    const inspectSignatures = (owner, signatures, fallbackSource, countSummary) => {
        if (signatures.length === 0) return

        if (countSummary) {
            record(owner, "summary", hasDocumentation(owner) || signatures.some(hasDocumentation), fallbackSource)
        }

        const parameters = uniqueNamed(signatures.flatMap(signature => signature.parameters ?? []))
        for (const parameter of parameters) {
            record(owner, `@param ${parameter.name}`, hasDocumentation(parameter), fallbackSource, parameter)
        }

        const typeParameters = uniqueNamed(signatures.flatMap(signature => signature.typeParameters ?? []))
        for (const typeParameter of typeParameters) {
            record(
                owner,
                `@typeParam ${typeParameter.name}`,
                hasDocumentation(typeParameter),
                fallbackSource,
                typeParameter,
            )
        }
    }

    const inspectType = (type, fallbackSource) => {
        if (!type || typeof type !== "object") return
        if (type.type === "reflection") inspect(type.declaration, fallbackSource, true)
        for (const value of Object.values(type)) {
            if (Array.isArray(value)) value.forEach(item => inspectType(item, fallbackSource))
            else if (value && typeof value === "object" && value !== type.declaration)
                inspectType(value, fallbackSource)
        }
    }

    const inspect = (reflection, fallbackSource, embedded = false) => {
        if (!reflection || visited.has(reflection.id) || isPrivate(reflection) || reflection.inheritedFrom) return
        visited.add(reflection.id)

        const ownSource = sourceOf(reflection, fallbackSource)
        if (reflection.kind !== ReflectionKind.Project && !isOwned(reflection, packageDir, fallbackSource)) return
        if (documentedKinds.has(reflection.kind) && !reflection.sources?.length) return

        const signatures = reflection.signatures ?? []
        const isStandaloneSignature = signatureKinds.has(reflection.kind)

        if (documentedKinds.has(reflection.kind)) {
            record(reflection, "summary", hasSummary(reflection), ownSource)
        }

        if (isStandaloneSignature) inspectSignatures(reflection, [reflection], ownSource, true)
        else inspectSignatures(reflection, signatures, ownSource, false)

        for (const typeParameter of reflection.typeParameters ?? []) {
            record(
                reflection,
                `@typeParam ${typeParameter.name}`,
                hasDocumentation(typeParameter),
                ownSource,
                typeParameter,
            )
        }

        for (const child of reflection.children ?? []) inspect(child, ownSource, embedded)
        for (const signature of signatures) {
            for (const parameter of signature.parameters ?? []) inspectType(parameter.type, ownSource)
            inspectType(signature.type, ownSource)
        }
        inspectType(reflection.type, ownSource)
    }

    inspect(project)

    const missing = items.filter(item => !item.documented)
    missing.sort(
        (a, b) =>
            (a.file ?? "").localeCompare(b.file ?? "") ||
            (a.line ?? 0) - (b.line ?? 0) ||
            (a.column ?? 0) - (b.column ?? 0) ||
            a.kind.localeCompare(b.kind) ||
            a.symbol.localeCompare(b.symbol),
    )
    const required = items.length
    const documented = required - missing.length
    return {
        required,
        documented,
        missing: missing.length,
        percentage: required === 0 ? 100 : Number(((documented / required) * 100).toFixed(2)),
        findings: missing.map(({ documented: _documented, ...finding }) => finding),
    }
}

const typeTargets = value => {
    if (!value || typeof value !== "object") return []
    const targets = []
    for (const [key, child] of Object.entries(value)) {
        if (key === "types" && typeof child === "string") targets.push(child)
        else targets.push(...typeTargets(child))
    }
    return targets
}

export const resolvePublicEntryPoints = ({ packageDir, manifest }) => {
    const declarationTargets = [...typeTargets(manifest.exports)]
    if (typeof manifest.types === "string") declarationTargets.push(manifest.types)
    const declarations = [...new Set(declarationTargets.map(target => path.resolve(packageDir, target)))]
    if (declarations.length === 0) throw new Error("package exports do not declare any TypeScript declarations")

    for (const declaration of declarations) {
        if (!existsSync(declaration)) {
            throw new Error(`emitted declarations are missing: ${path.relative(packageDir, declaration)}`)
        }
    }

    const sources = [
        ...new Set(
            declarations.map(declaration => {
                const relative = path.relative(packageDir, declaration)
                const segments = relative.split(path.sep)
                const emittedRelative = segments.length > 1 ? path.join(...segments.slice(1)) : segments[0]
                const sourceRelative = emittedRelative.replace(/\.d\.(?:c|m)?ts$/, ".ts")
                return path.resolve(packageDir, "src", sourceRelative)
            }),
        ),
    ]

    const missingSources = sources.filter(source => !existsSync(source))
    if (missingSources.length > 0) {
        throw new Error(
            `source entry points are missing: ${missingSources.map(source => path.relative(packageDir, source)).join(", ")}`,
        )
    }
    return { declarations, sources }
}

export const extractProject = async ({ entryPoints, tsconfig }) => {
    const application = await Application.bootstrap({
        entryPoints: entryPoints.map(file => file.replaceAll("\\", "/")),
        tsconfig: tsconfig.replaceAll("\\", "/"),
        emit: "none",
        excludeInternal: true,
        excludePrivate: true,
        excludeProtected: true,
        logLevel: "Error",
        skipErrorChecking: false,
    })
    const project = await application.convert()
    if (!project || application.logger.errorCount > 0) {
        throw new Error(`TypeDoc extraction failed with ${application.logger.errorCount} error(s)`)
    }
    return project
}

export const totals = results => {
    const required = results.reduce((sum, result) => sum + result.required, 0)
    const documented = results.reduce((sum, result) => sum + result.documented, 0)
    const missing = required - documented
    return {
        required,
        documented,
        missing,
        percentage: required === 0 ? 100 : Number(((documented / required) * 100).toFixed(2)),
    }
}

export const shouldFail = (results, failures) =>
    failures.length > 0 || results.some(result => result.mode === "enforce" && result.missing > 0)
