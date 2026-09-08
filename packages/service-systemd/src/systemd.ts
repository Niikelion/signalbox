import { execFileSync } from "node:child_process"
import { chownSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { isRoot, SignalboxError, write } from "@signalbox/core"
import {
    systemdActiveCredentialName,
    systemdCredentialName,
    systemdManifestName,
    type SystemdCredentialManifest,
} from "@signalbox/secrets"
import type {
    ServiceAdapter,
    ServiceScope,
    ServiceSetupContext,
    ServiceTarget,
    ServiceTeardownContext,
} from "@signalbox/service-cli"

/** Narrow, structured customizations for a generated systemd service. */
export interface SystemServiceProfile {
    /** Service account name (default `signalbox`). */
    user?: string
    /** Primary service group (default matches `user`). */
    group?: string
    /** Create a missing primary group and service user during setup (default true). */
    createAccount?: boolean
    /** Existing groups added with systemd's `SupplementaryGroups`. */
    supplementaryGroups?: readonly string[]
    /** A systemd-managed directory below `/run` (or the user runtime directory). */
    runtimeDirectory?: { readonly name?: string; readonly mode?: number }
    /** Absolute paths made writable through the existing `ProtectSystem=strict` sandbox. */
    readWritePaths?: readonly string[]
}

/**
 * Options for {@link createSystemdServiceAdapter}.
 * @typeParam TConfig the app's validated config type
 */
export interface SystemdServiceAdapterOptions<TConfig> {
    /** Structured systemd service customizations. */
    readonly profile?: SystemServiceProfile
    /** Inbound firewall port to open at setup / close at teardown, derived from config. */
    readonly firewallPort?: (config: Partial<TConfig>) => number | undefined
}

/** systemd's two scopes: a system-wide unit (root) and a per-user unit (rootless). */
type SystemdScope = "system" | "user"

const SYSTEMD_SCOPES: readonly ServiceScope[] = [
    { name: "system", description: "system-wide unit (needs root)" },
    { name: "user", description: "per-user unit (no root)" },
]

const DEFAULT_SERVICE_USER = "signalbox"
const ACCOUNT_NAME = /^[a-z_][a-z0-9_-]*[$]?$/u
const RUNTIME_DIRECTORY_NAME = /^[A-Za-z0-9_.-]+$/u

interface ResolvedSystemServiceProfile {
    readonly user: string
    readonly group: string
    readonly createAccount: boolean
    readonly supplementaryGroups: readonly string[]
    readonly runtimeDirectory?: { readonly name?: string; readonly mode: number }
    readonly readWritePaths: readonly string[]
}

interface SystemdUnitRenderOptions {
    readonly appName: string
    readonly scope: SystemdScope
    readonly configPath: string
    readonly executable: string
    readonly runArgs: readonly string[]
    readonly credentials: readonly { readonly name: string; readonly path: string }[]
    readonly activeKeyId?: string
    readonly description?: string
    readonly systemService?: SystemServiceProfile
}

const resolveProfile = (profile: SystemServiceProfile = {}): ResolvedSystemServiceProfile => {
    const user = profile.user ?? DEFAULT_SERVICE_USER
    const group = profile.group ?? user
    const supplementaryGroups = [...new Set(profile.supplementaryGroups ?? [])]
    for (const name of [user, group, ...supplementaryGroups]) {
        if (!ACCOUNT_NAME.test(name)) throw new SignalboxError(`invalid system account or group name "${name}"`)
    }
    const runtimeDirectory = profile.runtimeDirectory
        ? {
              ...(profile.runtimeDirectory.name !== undefined ? { name: profile.runtimeDirectory.name } : {}),
              mode: profile.runtimeDirectory.mode ?? 0o750,
          }
        : undefined
    if (runtimeDirectory?.name !== undefined && !RUNTIME_DIRECTORY_NAME.test(runtimeDirectory.name)) {
        throw new SignalboxError(`invalid runtime directory name "${runtimeDirectory.name}"`)
    }
    if (
        runtimeDirectory &&
        (!Number.isInteger(runtimeDirectory.mode) || runtimeDirectory.mode < 0 || runtimeDirectory.mode > 0o777)
    ) {
        throw new SignalboxError(`invalid runtime directory mode ${String(runtimeDirectory.mode)}`)
    }
    const readWritePaths = [...new Set(profile.readWritePaths ?? [])]
    for (const path of readWritePaths) {
        if (!isAbsolute(path) || /[\s"'\\]/u.test(path)) {
            throw new SignalboxError(
                `invalid writable path "${path}"`,
                "use an absolute path without whitespace, quotes, or backslashes",
            )
        }
    }
    return {
        user,
        group,
        createAccount: profile.createAccount ?? true,
        supplementaryGroups,
        ...(runtimeDirectory ? { runtimeDirectory } : {}),
        readWritePaths,
    }
}

const run = (command: string, args: string[]): string => {
    try {
        return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new SignalboxError(`${command} ${args.join(" ")} failed: ${detail}`)
    }
}

const runBinary = (command: string, args: string[], input?: Uint8Array): Buffer => {
    try {
        return execFileSync(command, args, {
            ...(input ? { input: Buffer.from(input) } : {}),
            stdio: ["pipe", "pipe", "pipe"],
        })
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new SignalboxError(`${command} ${args.join(" ")} failed: ${detail}`)
    }
}

const tryRun = (command: string, args: string[]): string | null => {
    try {
        return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    } catch {
        return null
    }
}

const userExists = (name: string): boolean => tryRun("id", ["-u", name]) !== null
const groupExists = (name: string): boolean => tryRun("getent", ["group", name]) !== null
const ufwIsActive = (): boolean => (tryRun("ufw", ["status"]) ?? "").includes("Status: active")

const systemdScope = (scope: string): SystemdScope => {
    if (scope === "system" || scope === "user") return scope
    throw new SignalboxError(`unsupported systemd scope "${scope}"`)
}

const systemUnitPath = (appName: string): string => `/etc/systemd/system/${appName}.service`
const userUnitPath = (appName: string): string => join(homedir(), ".config", "systemd", "user", `${appName}.service`)
const unitPath = (appName: string, scope: SystemdScope): string =>
    scope === "system" ? systemUnitPath(appName) : userUnitPath(appName)
const ownedConfigDirs = (appName: string): string[] => [
    resolve(`/etc/${appName}`),
    resolve(join(homedir(), ".config", appName)),
]
const credentialArchive = (scope: SystemdScope): string =>
    scope === "system" ? "/etc/credstore.encrypted" : join(homedir(), ".config", "systemd", "credstore.encrypted")
const systemctl = (scope: SystemdScope, args: string[]): string[] => (scope === "system" ? args : ["--user", ...args])

const requireScopePrivileges = (appName: string, scope: SystemdScope, action: string): void => {
    if (scope === "system" && !isRoot()) {
        throw new SignalboxError(
            `${action} of a system service needs root`,
            `either \`sudo ${appName} ${action}\`, or \`${appName} ${action} --scope user\` which needs no root at all`,
        )
    }
    if (scope === "user" && isRoot()) {
        throw new SignalboxError(
            `${action} --scope user as root would install into root's home`,
            `drop the sudo, or use \`sudo ${appName} ${action}\` for a system service`,
        )
    }
}

/** @internal Pure unit rendering entrypoint used by tests. */
export const renderSystemdUnit = (options: SystemdUnitRenderOptions): string => {
    if (options.description && /[\r\n]/u.test(options.description)) {
        throw new SignalboxError("systemd service description cannot contain a line break")
    }
    const profile = resolveProfile(options.systemService)
    const configEnv = `${options.appName.toUpperCase().replace(/-/g, "_")}_CONFIG`
    const account = options.scope === "system" ? `User=${profile.user}\nGroup=${profile.group}\n` : ""
    const hardening =
        options.scope === "system"
            ? `NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=
LockPersonality=yes
`
            : `NoNewPrivileges=yes
PrivateTmp=yes
`

    const credentialLines = [
        ...options.credentials.map(credential => `LoadCredentialEncrypted=${credential.name}:${credential.path}`),
        ...(options.activeKeyId
            ? [`SetCredential=${systemdActiveCredentialName(options.appName)}:${options.activeKeyId}`]
            : []),
    ].join("\n")
    const runtimeName = profile.runtimeDirectory?.name ?? options.appName
    const profileLines = [
        ...(options.scope === "system" && profile.supplementaryGroups.length > 0
            ? [`SupplementaryGroups=${profile.supplementaryGroups.join(" ")}`]
            : []),
        ...(profile.runtimeDirectory
            ? [
                  `RuntimeDirectory=${runtimeName}`,
                  `RuntimeDirectoryMode=${profile.runtimeDirectory.mode.toString(8).padStart(4, "0")}`,
              ]
            : []),
        ...(profile.readWritePaths.length > 0 ? [`ReadWritePaths=${profile.readWritePaths.join(" ")}`] : []),
    ].join("\n")

    return `[Unit]
Description=${options.description ?? options.appName}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
${account}Environment=${configEnv}=${options.configPath}
ExecStart=${options.executable} ${options.runArgs.join(" ")}
Restart=always
RestartSec=10
${credentialLines}
${profileLines}

${hardening}[Install]
WantedBy=${options.scope === "system" ? "multi-user.target" : "default.target"}
`
}

/**
 * Create a systemd {@link ServiceAdapter} for `@signalbox/service-cli`. Invalid
 * profile metadata throws immediately.
 * @typeParam TConfig the app's validated config type
 * @param options the systemd profile and firewall configuration
 */
export const createSystemdServiceAdapter = <TConfig>(
    options: SystemdServiceAdapterOptions<TConfig> = {},
): ServiceAdapter<TConfig> => {
    const profile = resolveProfile(options.profile)
    const watchPortFor = (config: Partial<TConfig>): number | undefined => options.firewallPort?.(config)

    const setup = (context: ServiceSetupContext<TConfig>): void => {
        const appName = context.appName
        const scope = systemdScope(context.scope)
        requireScopePrivileges(appName, scope, "setup")
        const configuredProfile = options.profile
        if (
            scope === "user" &&
            configuredProfile &&
            (configuredProfile.user !== undefined ||
                configuredProfile.group !== undefined ||
                configuredProfile.createAccount !== undefined ||
                (configuredProfile.supplementaryGroups?.length ?? 0) > 0)
        ) {
            throw new SignalboxError("system account and supplementary-group settings cannot be used with --scope user")
        }

        if (process.execPath.includes("/.nvm/") || process.execPath.includes("/.volta/")) {
            const detail =
                scope === "system"
                    ? `the ${profile.user} user must be able to read that path - a system-wide node is safer`
                    : "fine for a user service, but the path breaks if you switch node versions"
            write("warn", `node lives at ${process.execPath}, inside a per-user version manager: ${detail}`)
        }

        const watchPort = watchPortFor(context.config)

        if (scope === "system") {
            for (const supplementaryGroup of profile.supplementaryGroups) {
                if (!groupExists(supplementaryGroup)) {
                    throw new SignalboxError(`supplementary group ${supplementaryGroup} does not exist`)
                }
            }
            if (!groupExists(profile.group)) {
                if (!profile.createAccount) throw new SignalboxError(`service group ${profile.group} does not exist`)
                run("groupadd", ["--system", profile.group])
                write("info", `created system group ${profile.group}`)
            }
            if (!userExists(profile.user)) {
                if (!profile.createAccount) throw new SignalboxError(`service user ${profile.user} does not exist`)
                run("useradd", [
                    "--system",
                    "--no-create-home",
                    "--shell",
                    "/usr/sbin/nologin",
                    "--gid",
                    profile.group,
                    profile.user,
                ])
                write("info", `created system user ${profile.user}`)
            }

            const configDir = dirname(context.configPath)
            mkdirSync(configDir, { recursive: true, mode: 0o750 })
            const gid = Number(run("id", ["-g", profile.user]).trim())
            chownSync(configDir, 0, gid)
            if (existsSync(context.configPath)) chownSync(context.configPath, 0, gid)

            if (watchPort !== undefined && ufwIsActive()) {
                const gateway = tryRun("ip", ["route", "show", "default"])?.trim().split(/\s+/)[2]
                if (gateway) {
                    tryRun("ufw", [
                        "allow",
                        "from",
                        gateway,
                        "to",
                        "any",
                        "port",
                        String(watchPort),
                        "proto",
                        "tcp",
                        "comment",
                        `${appName} UPnP callback`,
                    ])
                    write("info", `ufw: allowed tcp/${String(watchPort)} from gateway ${gateway}`)
                }
            }
        }

        const archive = credentialArchive(scope)
        const credentials: { name: string; path: string }[] = []
        if (context.keys.length > 0) {
            if (!context.activeKeyId) throw new SignalboxError("setup needs an active key ID when sealing credentials")
            mkdirSync(archive, { recursive: true, mode: 0o700 })
            chmodSync(archive, 0o700)
            for (const material of context.keys) {
                const name = systemdCredentialName(appName, material.id)
                const targetPath = join(archive, name)
                const commandOptions = scope === "user" ? ["--user"] : []
                runBinary(
                    "systemd-creds",
                    [...commandOptions, "encrypt", `--name=${name}`, "-", targetPath],
                    material.key,
                )
                const roundTrip = runBinary("systemd-creds", [...commandOptions, "decrypt", targetPath, "-"])
                if (!roundTrip.equals(Buffer.from(material.key))) {
                    throw new SignalboxError(`systemd credential ${name} failed round-trip verification`)
                }
                credentials.push({ name, path: targetPath })
            }
            const manifest: SystemdCredentialManifest = {
                version: 1,
                appName,
                activeKeyId: context.activeKeyId,
                keyIds: context.keys.map(key => key.id),
            }
            writeFileSync(join(archive, systemdManifestName(appName)), `${JSON.stringify(manifest, null, 4)}\n`, {
                mode: 0o600,
            })
        }

        const target = unitPath(appName, scope)
        const wasInstalled = existsSync(target)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(
            target,
            renderSystemdUnit({
                appName,
                scope,
                configPath: context.configPath,
                executable: context.executable,
                runArgs: context.runArgs,
                credentials,
                ...(context.activeKeyId ? { activeKeyId: context.activeKeyId } : {}),
                ...(context.description ? { description: context.description } : {}),
                ...(options.profile ? { systemService: options.profile } : {}),
            }),
            { mode: 0o644 },
        )

        run("systemctl", systemctl(scope, ["daemon-reload"]))
        run("systemctl", systemctl(scope, ["enable", "--now", `${appName}.service`]))
        if (wasInstalled) run("systemctl", systemctl(scope, ["restart", `${appName}.service`]))
        run("systemctl", systemctl(scope, ["is-active", "--quiet", `${appName}.service`]))
        write("info", `installed ${target} and started ${appName}`)

        if (scope === "user") {
            const linger = tryRun("loginctl", [
                "show-user",
                process.env["USER"] ?? "",
                "-p",
                "Linger",
                "--value",
            ])?.trim()
            if (linger !== "yes") {
                write(
                    "warn",
                    `lingering is off, so this stops when your last session ends. Enable it once with: sudo loginctl enable-linger ${process.env["USER"] ?? "$USER"}`,
                )
            }
            if (watchPort !== undefined && ufwIsActive()) {
                write(
                    "warn",
                    `ufw is active - allow tcp/${String(watchPort)} from your gateway or NOTIFYs will be dropped`,
                )
            }
        }

        write("info", `follow it with: journalctl ${scope === "user" ? "--user " : ""}-u ${appName} -f`)
    }

    const teardown = (context: ServiceTeardownContext<TConfig>): void => {
        const appName = context.appName
        const scope = systemdScope(context.scope)
        requireScopePrivileges(appName, scope, "teardown")

        tryRun("systemctl", systemctl(scope, ["disable", "--now", `${appName}.service`]))

        const target = unitPath(appName, scope)
        if (existsSync(target)) {
            rmSync(target)
            write("info", `removed ${target}`)
        }
        run("systemctl", systemctl(scope, ["daemon-reload"]))
        tryRun("systemctl", systemctl(scope, ["reset-failed", `${appName}.service`]))

        const watchPort = watchPortFor(context.config)
        if (scope === "system" && watchPort !== undefined && ufwIsActive()) {
            const gateway = tryRun("ip", ["route", "show", "default"])?.trim().split(/\s+/)[2]
            if (gateway) {
                tryRun("ufw", [
                    "delete",
                    "allow",
                    "from",
                    gateway,
                    "to",
                    "any",
                    "port",
                    String(watchPort),
                    "proto",
                    "tcp",
                ])
            }
        }

        if (context.purge) {
            const configDir = resolve(dirname(context.configPath))
            if (ownedConfigDirs(appName).includes(configDir) && existsSync(configDir)) {
                rmSync(configDir, { recursive: true, force: true })
                write("info", `removed ${configDir}`)
            }
        }
    }

    const controlService = (target: ServiceTarget, action: "start" | "stop" | "restart"): void => {
        const scope = systemdScope(target.scope)
        requireScopePrivileges(target.appName, scope, action)
        run("systemctl", systemctl(scope, [action, `${target.appName}.service`]))
        write("info", `${action}ed ${target.appName}`)
    }

    const serviceStatus = (target: ServiceTarget): string => {
        const scope = systemdScope(target.scope)
        return (
            tryRun("systemctl", systemctl(scope, ["status", `${target.appName}.service`, "--no-pager"])) ??
            `${target.appName}.service is not installed (${scope} scope)`
        )
    }

    const removeCredentials = (target: ServiceTarget, keyIds: readonly string[]): void => {
        const appName = target.appName
        const scope = systemdScope(target.scope)
        requireScopePrivileges(appName, scope, "delete sealed keys")
        const archive = credentialArchive(scope)
        const removed = new Set(keyIds)
        const manifestPath = join(archive, systemdManifestName(appName))
        let manifest: SystemdCredentialManifest | undefined
        if (existsSync(manifestPath)) {
            manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as SystemdCredentialManifest
            if (removed.has(manifest.activeKeyId)) {
                throw new SignalboxError(`cannot delete active sealed key ${manifest.activeKeyId}`)
            }
        }
        for (const keyId of removed) rmSync(join(archive, systemdCredentialName(appName, keyId)), { force: true })
        if (manifest) {
            writeFileSync(
                manifestPath,
                `${JSON.stringify({ ...manifest, keyIds: manifest.keyIds.filter(keyId => !removed.has(keyId)) }, null, 4)}\n`,
                { mode: 0o600 },
            )
        }
    }

    const purgeCredentials = (target: ServiceTarget): void => {
        const appName = target.appName
        const scope = systemdScope(target.scope)
        requireScopePrivileges(appName, scope, "purge sealed credentials")
        const archive = credentialArchive(scope)
        if (!existsSync(archive)) return
        const prefix = `${appName.replace(/[^A-Za-z0-9_.-]+/gu, "-")}-config-key-`
        for (const entry of readdirSync(archive)) {
            if (entry.startsWith(prefix) || entry === systemdManifestName(appName)) {
                rmSync(join(archive, entry), { force: true })
            }
        }
    }

    return {
        scopes: SYSTEMD_SCOPES,
        defaultScope: "system",
        isInstalled: async target => existsSync(unitPath(target.appName, systemdScope(target.scope))),
        setup: async context => {
            setup(context)
        },
        teardown: async context => {
            teardown(context)
        },
        control: async (target, action) => {
            controlService(target, action)
        },
        status: async target => serviceStatus(target),
        removeCredentials: async (target, keyIds) => {
            removeCredentials(target, keyIds)
        },
        purgeCredentials: async target => {
            purgeCredentials(target)
        },
    }
}
