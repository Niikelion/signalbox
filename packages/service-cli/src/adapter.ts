import type { KeyMaterial } from "@signalbox/secrets"

/**
 * A named service scope an adapter offers (e.g. systemd's `system` and `user`).
 */
export interface ServiceScope {
    /** Scope identifier, selected with `--scope <name>`. */
    readonly name: string
    /** One-line description shown in help. */
    readonly description?: string
}

/**
 * Identifies which app and scope an adapter operation targets. Every adapter
 * method receives at least this — the adapter is not constructed per-app, so
 * the app identity arrives with each call.
 */
export interface ServiceTarget {
    /** The app/unit name. */
    readonly appName: string
    /** The selected scope name (one of the adapter's declared scopes). */
    readonly scope: string
}

/**
 * Everything an adapter needs to install and start a service.
 * @typeParam TConfig the app's validated config type
 */
export interface ServiceSetupContext<TConfig> extends ServiceTarget {
    /** Human-readable service description. */
    readonly description?: string
    /** The validated application config. */
    readonly config: TConfig
    /** Path to the config file the service should point at. */
    readonly configPath: string
    /** Executable that runs the CLI (e.g. the node binary). */
    readonly executable: string
    /** Arguments after {@link executable} that invoke the CLI's `run` command. */
    readonly runArgs: readonly string[]
    /** Key material the installed service must be able to read. */
    readonly keys: readonly KeyMaterial[]
    /** The key the service should use for new writes, when present. */
    readonly activeKeyId?: string
}

/**
 * Everything an adapter needs to stop and remove a service. Config may be
 * partial because teardown must work even when config is incomplete.
 * @typeParam TConfig the app's validated config type
 */
export interface ServiceTeardownContext<TConfig> extends ServiceTarget {
    /** Human-readable service description. */
    readonly description?: string
    /** The available (possibly partial) application config. */
    readonly config: Partial<TConfig>
    /** Path to the config file the service points at. */
    readonly configPath: string
    /** Whether the caller requested a full purge (config deletion stays with the CLI). */
    readonly purge: boolean
}

/**
 * A service-system integration. The executable supplies one to {@link runCli}
 * to enable the lifecycle commands. Every operation is asynchronous, and the
 * adapter owns the complete integration — including credential provisioning.
 * @typeParam TConfig the app's validated config type
 */
export interface ServiceAdapter<TConfig> {
    /** The scopes this adapter supports; must be non-empty with unique names. */
    readonly scopes: readonly ServiceScope[]
    /** The scope used when `--scope` is omitted; must name a declared scope. */
    readonly defaultScope: string

    /** Whether the service is currently installed for the target. */
    isInstalled(target: ServiceTarget): Promise<boolean>
    /** Install and start the service, provisioning any credentials. */
    setup(context: ServiceSetupContext<TConfig>): Promise<void>
    /** Stop and remove the service. */
    teardown(context: ServiceTeardownContext<TConfig>): Promise<void>
    /** Start, stop, or restart the installed service. */
    control(target: ServiceTarget, action: "start" | "stop" | "restart"): Promise<void>
    /** Return the service's status as text, verbatim. */
    status(target: ServiceTarget): Promise<string>

    /** Remove the named adapter-managed credentials (used by rekey and prune). */
    removeCredentials(target: ServiceTarget, keyIds: readonly string[]): Promise<void>
    /** Remove all adapter-managed credentials (used by teardown --purge). */
    purgeCredentials(target: ServiceTarget): Promise<void>
}
