import type { PermissionAuditEvent, PermissionAuditSink } from "./audit"
import { createHash } from "node:crypto"
import type { PermissionRegistryBackend } from "./backend"
import { createPermissionExecution, type PermissionCoreRuntime, type PermissionRuntime } from "./execution"
import type { IdentityGrant, TrustedIdentityIssuer } from "./identity"
import { entityKey, entityRef, type EntityRef } from "./model"
import { createPermissionRegistry, type PermissionRegistry, type PermissionRegistryBootstrap } from "./registry"
import type { PermissionRegistryAuditEvent, PermissionRegistryAuditSink } from "./registry-audit"
import type { DelegableClaim, PermissionDeclaration } from "./registry-model"
import { MembershipStateCell } from "./state"

export type PermissionSystemAuditEvent = PermissionAuditEvent | PermissionRegistryAuditEvent
export type PermissionSystemAuditSink = (event: PermissionSystemAuditEvent) => void

export interface PermissionSystemIdentityInput {
    readonly principal: EntityRef
    readonly origin?: EntityRef
    readonly groups?: readonly EntityRef[]
}

/** Trusted identity issuer whose authority always comes from the registry. */
export interface PermissionSystemIdentityIssuer {
    issue(input: PermissionSystemIdentityInput): IdentityGrant
}

export interface PermissionSystemOptions {
    readonly backend: PermissionRegistryBackend
    readonly host: EntityRef
    readonly permissions?: readonly PermissionDeclaration[]
    readonly hostClaims?: readonly DelegableClaim[]
    readonly hostGrantId?: string
    readonly audit?: PermissionSystemAuditSink
    readonly now?: () => number
}

export interface PermissionSystem {
    readonly runtime: PermissionRuntime
    readonly core: PermissionCoreRuntime
    readonly registry: PermissionRegistry
    readonly bootstrap: PermissionRegistryBootstrap
    readonly identities: PermissionSystemIdentityIssuer
    readonly host: IdentityGrant
    readonly app: {
        readonly runtime: PermissionRuntime
        readonly core: PermissionCoreRuntime
        readonly host: IdentityGrant
    }
}

const operationId = (kind: string, value: string): string => `permission-system:${kind}:${value}`
const fingerprint = (value: unknown): string =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16)

/** Compose execution, durable registry, trusted identities, and initialized host authority. */
export const createPermissionSystem = async (options: PermissionSystemOptions): Promise<PermissionSystem> => {
    const executionAudit: PermissionAuditSink | undefined = options.audit
    const registryAudit: PermissionRegistryAuditSink | undefined = options.audit
    const execution = createPermissionExecution({
        ...(executionAudit ? { audit: executionAudit } : {}),
        ...(options.now ? { now: options.now } : {}),
    })
    const { registry, bootstrap } = await createPermissionRegistry({
        backend: options.backend,
        ...(registryAudit ? { audit: registryAudit } : {}),
        ...(options.now ? { now: options.now } : {}),
    })
    const host = entityRef(options.host.type, options.host.id)

    for (const definition of options.permissions ?? []) {
        await registry.define({
            ...definition,
            actor: host,
            operationId: operationId("define", definition.id),
        })
    }

    const hostClaims = options.hostClaims ?? []
    if (hostClaims.length > 0) {
        const managedPrefix = `host:${entityKey(host)}:`
        const hostGrantId = options.hostGrantId ?? `${managedPrefix}${fingerprint(hostClaims)}`
        if (!options.hostGrantId) {
            for (const grant of registry.snapshot().grants) {
                if (grant.id.startsWith(managedPrefix) && grant.id !== hostGrantId && grant.revokedAt === undefined) {
                    await registry.revoke({
                        id: grant.id,
                        actor: host,
                        operationId: operationId("replace-host-grant", grant.id),
                    })
                }
            }
        }
        await bootstrap.grant({
            id: hostGrantId,
            actor: host,
            subject: host,
            claims: hostClaims,
            operationId: operationId("host-grant", hostGrantId),
        })
    }

    const trusted: TrustedIdentityIssuer = execution.identities
    const identities: PermissionSystemIdentityIssuer = Object.freeze({
        issue: (input: PermissionSystemIdentityInput) => {
            const principal = entityRef(input.principal.type, input.principal.id)
            const groups = (input.groups ?? []).map(group => entityRef(group.type, group.id))
            const contributions = [
                ...registry.contributionsFor(principal),
                ...groups.flatMap(group => {
                    const membership = new MembershipStateCell({ principal, group })
                    return registry.contributionsFor(group).map(contribution => ({ ...contribution, membership }))
                }),
            ]
            return trusted.issue({
                principal,
                ...(input.origin ? { origin: input.origin } : {}),
                groups,
                contributions,
            })
        },
    })
    const hostIdentity = identities.issue({ principal: host })

    return Object.freeze({
        runtime: execution.runtime,
        core: execution.core,
        registry,
        bootstrap,
        identities,
        host: hostIdentity,
        app: Object.freeze({ runtime: execution.runtime, core: execution.core, host: hostIdentity }),
    })
}
