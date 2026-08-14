import { execFileSync } from "node:child_process"
import { chownSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { isRoot, FlowKitError, write } from "@signalbox/core"

/**
 * A system unit needs root: a service account, /etc/systemd/system, a firewall
 * rule. A user unit needs none of that — the callback port is unprivileged and
 * the config already lives under $HOME — so `user` is the lighter default for a
 * single-user box. The trade is isolation and boot behaviour (see `linger`).
 */
export type ServiceScope = "system" | "user"

export interface SetupOptions {
    scope: ServiceScope
    configPath: string
    /** If set, open this TCP port from the default gateway (for an inbound callback). */
    watchPort?: number
}

export interface TeardownOptions {
    scope: ServiceScope
    /** Also delete the config directory, and the service user for a system install. */
    purge: boolean
    configPath: string
    /** The port opened at setup, removed again here. */
    watchPort?: number
}

export interface ServiceManager {
    setupService: (options: SetupOptions) => void
    teardownService: (options: TeardownOptions) => void
    controlService: (scope: ServiceScope, action: "start" | "stop" | "restart") => void
    serviceStatus: (scope: ServiceScope) => string
}

const SERVICE_USER = "flowkit"

const run = (command: string, args: string[]): string => {
    try {
        return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new FlowKitError(`${command} ${args.join(" ")} failed: ${detail}`)
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

const ufwIsActive = (): boolean => (tryRun("ufw", ["status"]) ?? "").includes("Status: active")

/** Absolute path to the installed CLI entry point, for the unit's ExecStart. */
const cliEntry = (): string => {
    const argv1 = process.argv[1]
    if (!argv1) throw new FlowKitError("cannot determine the path to this CLI")
    return realpathSync(argv1)
}

/**
 * The systemd service commands for one app, bound to its name. Everything that
 * varies between apps — the unit path, the config env var, the directories a
 * `--purge` is allowed to delete — is derived from `appName` once, here.
 */
export const createServiceManager = (appName: string): ServiceManager => {
    const configEnv = `${appName.toUpperCase().replace(/-/g, "_")}_CONFIG`
    const systemUnitPath = `/etc/systemd/system/${appName}.service`
    const userUnitPath = join(homedir(), ".config", "systemd", "user", `${appName}.service`)
    // The only directories `teardown --purge` is allowed to delete recursively.
    const ownedConfigDirs = [resolve(`/etc/${appName}`), resolve(join(homedir(), ".config", appName))]

    const unitPath = (scope: ServiceScope): string => (scope === "system" ? systemUnitPath : userUnitPath)
    const systemctl = (scope: ServiceScope, args: string[]): string[] =>
        scope === "system" ? args : ["--user", ...args]

    const requireScopePrivileges = (scope: ServiceScope, action: string): void => {
        if (scope === "system" && !isRoot()) {
            throw new FlowKitError(
                `${action} of a system service needs root`,
                `either \`sudo ${appName} ${action}\`, or \`${appName} ${action} --user\` which needs no root at all`,
            )
        }
        if (scope === "user" && isRoot()) {
            throw new FlowKitError(
                `${action} --user as root would install into root's home`,
                `drop the sudo, or use \`sudo ${appName} ${action}\` for a system service`,
            )
        }
    }

    const unitContents = (scope: ServiceScope, configPath: string): string => {
        const account = scope === "system" ? `User=${SERVICE_USER}\nGroup=${SERVICE_USER}\n` : ""
        // ProtectSystem/ProtectHome are meaningful for a system unit; for a user unit
        // they buy little and can break access to $HOME, where its config lives.
        const hardening =
            scope === "system"
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

        return `[Unit]
Description=FlowKit dynamic DNS (UPnP push)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
${account}Environment=${configEnv}=${configPath}
ExecStart=${process.execPath} ${cliEntry()} run
Restart=always
RestartSec=10

${hardening}
[Install]
WantedBy=${scope === "system" ? "multi-user.target" : "default.target"}
`
    }

    const setupService = (options: SetupOptions): void => {
        const { scope } = options
        requireScopePrivileges(scope, "setup")

        if (process.execPath.includes("/.nvm/") || process.execPath.includes("/.volta/")) {
            const detail =
                scope === "system"
                    ? `the ${SERVICE_USER} user must be able to read that path - a system-wide node is safer`
                    : "fine for a user service, but the path breaks if you switch node versions"
            write("warn", `node lives at ${process.execPath}, inside a per-user version manager: ${detail}`)
        }

        if (scope === "system") {
            if (!userExists(SERVICE_USER)) {
                run("useradd", ["--system", "--no-create-home", "--shell", "/usr/sbin/nologin", SERVICE_USER])
                write("info", `created system user ${SERVICE_USER}`)
            }

            // the service account must be able to read the config, nothing more
            const configDir = dirname(options.configPath)
            mkdirSync(configDir, { recursive: true, mode: 0o750 })
            const gid = Number(run("id", ["-g", SERVICE_USER]).trim())
            chownSync(configDir, 0, gid)
            if (existsSync(options.configPath)) chownSync(options.configPath, 0, gid)

            // let an inbound callback (e.g. the router's UPnP NOTIFY) reach us
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

        const target = unitPath(scope)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, unitContents(scope, options.configPath), { mode: 0o644 })

        run("systemctl", systemctl(scope, ["daemon-reload"]))
        run("systemctl", systemctl(scope, ["enable", "--now", `${appName}.service`]))
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

        /*
         * Only ever recurse into a directory this app created. --config can point
         * anywhere, and its parent may be $HOME, /tmp, or a directory full of
         * unrelated files - purging that because a config happened to live there
         * would be catastrophic. Anything else keeps its directory.
         */
        const configDir = resolve(dirname(options.configPath))
        if (ownedConfigDirs.includes(configDir)) {
            if (existsSync(configDir)) {
                rmSync(configDir, { recursive: true, force: true })
                write("info", `removed ${configDir}`)
            }
        } else {
            write("info", `left ${configDir} in place - not a directory ${appName} created`)
        }

        if (scope === "system" && userExists(SERVICE_USER)) {
            tryRun("userdel", [SERVICE_USER])
            write("info", `removed user ${SERVICE_USER}`)
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

    return { setupService, teardownService, controlService, serviceStatus }
}
