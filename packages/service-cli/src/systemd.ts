import { execFileSync } from "node:child_process"
import {
    chownSync,
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { isRoot, SignalboxError, write } from "@signalbox/core"
import {
    systemdActiveCredentialName,
    systemdCredentialName,
    systemdManifestName,
    type KeyMaterial,
    type SystemdCredentialManifest,
} from "@signalbox/secrets"

/** Whether a systemd unit is system-wide (root) or per-user (rootless). */
export type ServiceScope = "system" | "user"

/** Options for installing the service. */
export interface SetupOptions {
    scope: ServiceScope
    /** Path to the config file the unit points at. */
    configPath: string
    /** Inbound port to open in the firewall, if any. */
    watchPort?: number
    /** Keys to seal and expose to the installed unit. */
    keys?: readonly KeyMaterial[]
    /** Key the unit should use for new writes. */
    activeKeyId?: string
}

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

/** Options fixed for the lifetime of a service manager. */
export interface ServiceManagerOptions {
    /** Description written to the systemd unit. */
    description?: string
    /** Structured systemd service customizations. */
    systemService?: SystemServiceProfile
}

/** Options for removing the service. */
export interface TeardownOptions {
    scope: ServiceScope
    /** Also delete the config file. */
    purge: boolean
    /** Path to the config file. */
    configPath: string
    /** Firewall port to close, if any. */
    watchPort?: number
}

/** Manages an app's systemd unit lifecycle. */
export interface ServiceManager {
    /** Whether the selected unit file currently exists. */
    isInstalled: (scope: ServiceScope) => boolean
    /** Install and start the unit. */
    setupService: (options: SetupOptions) => void
    /** Stop and remove the unit (optionally purge config). */
    teardownService: (options: TeardownOptions) => void
    /** Start/stop/restart the unit. */
    controlService: (scope: ServiceScope, action: "start" | "stop" | "restart") => void
    /** Return the unit's status output. */
    serviceStatus: (scope: ServiceScope) => string
    /** Remove selected sealed credentials after verified revocation/pruning. */
    deleteSealedKeys: (scope: ServiceScope, keyIds: readonly string[]) => void
    /** Remove all sealed credentials managed for this app. */
    purgeSealedCredentials: (scope: ServiceScope) => void
}

const DEFAULT_SERVICE_USER = "signalbox"
const ACCOUNT_NAME = /^[a-z_][a-z0-9_-]*[$]?$/u
const RUNTIME_DIRECTORY_NAME = /^[A-Za-z0-9_.-]+$/u

interface ResolvedSystemServiceProfile {
    readonly user: string
    readonly group: string
    readonly createAccount: boolean
    readonly supplementaryGroups: readonly string[]
    readonly runtimeDirectory?: { readonly name: string; readonly mode: number }
    readonly readWritePaths: readonly string[]
}

interface SystemdUnitRenderOptions {
    readonly appName: string
    readonly scope: ServiceScope
    readonly configPath: string
    readonly executable: string
    readonly cliPath: string
    readonly credentials: readonly { readonly name: string; readonly path: string }[]
    readonly activeKeyId?: string
    readonly description?: string
    readonly systemService?: SystemServiceProfile
}

const resolveProfile = (appName: string, profile: SystemServiceProfile = {}): ResolvedSystemServiceProfile => {
    const user = profile.user ?? DEFAULT_SERVICE_USER
    const group = profile.group ?? user
    const supplementaryGroups = [...new Set(profile.supplementaryGroups ?? [])]
    for (const name of [user, group, ...supplementaryGroups]) {
        if (!ACCOUNT_NAME.test(name)) throw new SignalboxError(`invalid system account or group name "${name}"`)
    }
    const runtimeDirectory = profile.runtimeDirectory
        ? {
              name: profile.runtimeDirectory.name ?? appName,
              mode: profile.runtimeDirectory.mode ?? 0o750,
          }
        : undefined
    if (runtimeDirectory && !RUNTIME_DIRECTORY_NAME.test(runtimeDirectory.name)) {
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
        runtimeDirectory,
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

const cliEntry = (): string => {
    const argv1 = process.argv[1]
    if (!argv1) throw new SignalboxError("cannot determine the path to this CLI")
    return realpathSync(argv1)
}

/** @internal Pure unit rendering entrypoint used by tests. */
export const renderSystemdUnit = (options: SystemdUnitRenderOptions): string => {
    if (options.description && /[\r\n]/u.test(options.description)) {
        throw new SignalboxError("systemd service description cannot contain a line break")
    }
    const profile = resolveProfile(options.appName, options.systemService)
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
    const profileLines = [
        ...(options.scope === "system" && profile.supplementaryGroups.length > 0
            ? [`SupplementaryGroups=${profile.supplementaryGroups.join(" ")}`]
            : []),
        ...(profile.runtimeDirectory
            ? [
                  `RuntimeDirectory=${profile.runtimeDirectory.name}`,
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
ExecStart=${options.executable} ${options.cliPath} run
Restart=always
RestartSec=10
${credentialLines}
${profileLines}

${hardening}
[Install]
WantedBy=${options.scope === "system" ? "multi-user.target" : "default.target"}
`
}

/**
 * Create a systemd service manager for an app.
 * @param appName the app/unit name
 */
export const createServiceManager = (appName: string, managerOptions: ServiceManagerOptions = {}): ServiceManager => {
    const profile = resolveProfile(appName, managerOptions.systemService)
    const systemUnitPath = `/etc/systemd/system/${appName}.service`
    const userUnitPath = join(homedir(), ".config", "systemd", "user", `${appName}.service`)
    const ownedConfigDirs = [resolve(`/etc/${appName}`), resolve(join(homedir(), ".config", appName))]
    const credentialArchive = (scope: ServiceScope): string =>
        scope === "system" ? "/etc/credstore.encrypted" : join(homedir(), ".config", "systemd", "credstore.encrypted")

    const unitPath = (scope: ServiceScope): string => (scope === "system" ? systemUnitPath : userUnitPath)
    const systemctl = (scope: ServiceScope, args: string[]): string[] =>
        scope === "system" ? args : ["--user", ...args]

    const requireScopePrivileges = (scope: ServiceScope, action: string): void => {
        if (scope === "system" && !isRoot()) {
            throw new SignalboxError(
                `${action} of a system service needs root`,
                `either \`sudo ${appName} ${action}\`, or \`${appName} ${action} --user\` which needs no root at all`,
            )
        }
        if (scope === "user" && isRoot()) {
            throw new SignalboxError(
                `${action} --user as root would install into root's home`,
                `drop the sudo, or use \`sudo ${appName} ${action}\` for a system service`,
            )
        }
    }

    const setupService = (options: SetupOptions): void => {
        const { scope } = options
        requireScopePrivileges(scope, "setup")
        const configuredProfile = managerOptions.systemService
        if (
            scope === "user" &&
            configuredProfile &&
            (configuredProfile.user !== undefined ||
                configuredProfile.group !== undefined ||
                configuredProfile.createAccount !== undefined ||
                (configuredProfile.supplementaryGroups?.length ?? 0) > 0)
        ) {
            throw new SignalboxError("system account and supplementary-group settings cannot be used with --user")
        }

        if (process.execPath.includes("/.nvm/") || process.execPath.includes("/.volta/")) {
            const detail =
                scope === "system"
                    ? `the ${profile.user} user must be able to read that path - a system-wide node is safer`
                    : "fine for a user service, but the path breaks if you switch node versions"
            write("warn", `node lives at ${process.execPath}, inside a per-user version manager: ${detail}`)
        }

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

            const configDir = dirname(options.configPath)
            mkdirSync(configDir, { recursive: true, mode: 0o750 })
            const gid = Number(run("id", ["-g", profile.user]).trim())
            chownSync(configDir, 0, gid)
            if (existsSync(options.configPath)) chownSync(options.configPath, 0, gid)

            if (options.watchPort !== undefined && ufwIsActive()) {
                const gateway = tryRun("ip", ["route", "show", "default"])?.trim().split(/\s+/)[2]
                if (gateway) {
                    tryRun("ufw", [
                        "allow",
                        "from",
                        gateway,
                        "to",
                        "any",
                        "port",
                        String(options.watchPort),
                        "proto",
                        "tcp",
                        "comment",
                        `${appName} UPnP callback`,
                    ])
                    write("info", `ufw: allowed tcp/${String(options.watchPort)} from gateway ${gateway}`)
                }
            }
        }

        const archive = credentialArchive(scope)
        const credentials: { name: string; path: string }[] = []
        if (options.keys && options.keys.length > 0) {
            if (!options.activeKeyId) throw new SignalboxError("setup needs an active key ID when sealing credentials")
            mkdirSync(archive, { recursive: true, mode: 0o700 })
            chmodSync(archive, 0o700)
            for (const material of options.keys) {
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
                activeKeyId: options.activeKeyId,
                keyIds: options.keys.map(key => key.id),
            }
            writeFileSync(join(archive, systemdManifestName(appName)), `${JSON.stringify(manifest, null, 4)}\n`, {
                mode: 0o600,
            })
        }

        const target = unitPath(scope)
        const wasInstalled = existsSync(target)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(
            target,
            renderSystemdUnit({
                appName,
                scope,
                configPath: options.configPath,
                executable: process.execPath,
                cliPath: cliEntry(),
                credentials,
                activeKeyId: options.activeKeyId,
                description: managerOptions.description,
                systemService: managerOptions.systemService,
            }),
            {
                mode: 0o644,
            },
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
            if (options.watchPort !== undefined && ufwIsActive()) {
                write(
                    "warn",
                    `ufw is active - allow tcp/${String(options.watchPort)} from your gateway or NOTIFYs will be dropped`,
                )
            }
        }

        write("info", `follow it with: journalctl ${scope === "user" ? "--user " : ""}-u ${appName} -f`)
    }

    const teardownService = (options: TeardownOptions): void => {
        const { scope } = options
        requireScopePrivileges(scope, "teardown")

        tryRun("systemctl", systemctl(scope, ["disable", "--now", `${appName}.service`]))

        const target = unitPath(scope)
        if (existsSync(target)) {
            rmSync(target)
            write("info", `removed ${target}`)
        }
        run("systemctl", systemctl(scope, ["daemon-reload"]))
        tryRun("systemctl", systemctl(scope, ["reset-failed", `${appName}.service`]))

        if (scope === "system" && options.watchPort !== undefined && ufwIsActive()) {
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
                    String(options.watchPort),
                    "proto",
                    "tcp",
                ])
            }
        }

        if (!options.purge) {
            write("info", `kept ${options.configPath} (pass --purge to remove it)`)
            return
        }

        if (existsSync(options.configPath)) {
            rmSync(options.configPath)
            write("info", `removed ${options.configPath}`)
        }

        const configDir = resolve(dirname(options.configPath))
        if (ownedConfigDirs.includes(configDir)) {
            if (existsSync(configDir)) {
                rmSync(configDir, { recursive: true, force: true })
                write("info", `removed ${configDir}`)
            }
        } else {
            write("info", `left ${configDir} in place - not a directory ${appName} created`)
        }
    }

    const serviceStatus = (scope: ServiceScope): string =>
        tryRun("systemctl", systemctl(scope, ["status", `${appName}.service`, "--no-pager"])) ??
        `${appName}.service is not installed (${scope} scope)`

    const controlService = (scope: ServiceScope, action: "start" | "stop" | "restart"): void => {
        requireScopePrivileges(scope, action)
        run("systemctl", systemctl(scope, [action, `${appName}.service`]))
        write("info", `${action}ed ${appName}`)
    }

    const deleteSealedKeys = (scope: ServiceScope, keyIds: readonly string[]): void => {
        requireScopePrivileges(scope, "delete sealed keys")
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

    const purgeSealedCredentials = (scope: ServiceScope): void => {
        requireScopePrivileges(scope, "purge sealed credentials")
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
        isInstalled: scope => existsSync(unitPath(scope)),
        setupService,
        teardownService,
        controlService,
        serviceStatus,
        deleteSealedKeys,
        purgeSealedCredentials,
    }
}
