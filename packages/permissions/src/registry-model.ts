import { PermissionError } from "./errors"
import { entityRef, permissionClaim, validatePermissionId, type EntityRef, type PermissionClaim } from "./model"

/** A globally unique permission known to the registry. */
export interface PermissionDefinition {
    readonly id: string
    readonly name: string
    readonly description?: string
    readonly retiredAt?: number
}

export type DelegationMode = "owned-resource" | "subject"

/** A claim plus the ways its holder may delegate it further. */
export interface DelegableClaim {
    readonly claim: PermissionClaim
    readonly delegation: readonly DelegationMode[]
}

/** An immutable authority grant. Revocation is the only state transition. */
export interface AuthorityGrantRecord {
    readonly id: string
    readonly subject: EntityRef
    readonly issuer: EntityRef
    readonly claims: readonly DelegableClaim[]
    readonly parentGrantId?: string
    readonly delegatedVia?: DelegationMode
    readonly expiresAt?: number
    readonly revokedAt?: number
}

export interface IdempotencyRecord {
    readonly id: string
    readonly kind: RegistryMutationKind
    readonly fingerprint: string
    readonly resultId: string
}

export type RegistryMutationKind = "define" | "retire" | "grant-root" | "delegate" | "revoke"

export interface PermissionRegistrySnapshot {
    readonly revision: number
    readonly definitions: readonly PermissionDefinition[]
    readonly grants: readonly AuthorityGrantRecord[]
    readonly operations: readonly IdempotencyRecord[]
}

export const emptyPermissionRegistrySnapshot = (): PermissionRegistrySnapshot => ({
    revision: 0,
    definitions: [],
    grants: [],
    operations: [],
})

export const cloneDefinition = (definition: PermissionDefinition): PermissionDefinition => {
    validatePermissionId(definition.id)
    if (definition.name.length === 0) {
        throw new PermissionError("BACKEND_INCONSISTENT", `permission "${definition.id}" has no name`)
    }
    return Object.freeze({ ...definition })
}

export const cloneDelegableClaim = (entry: DelegableClaim): DelegableClaim =>
    Object.freeze({
        claim: permissionClaim(entry.claim.permissionId, entry.claim.scope),
        delegation: Object.freeze([...new Set(entry.delegation)].sort()),
    })

export const cloneGrant = (grant: AuthorityGrantRecord): AuthorityGrantRecord => {
    if (grant.id.length === 0) throw new PermissionError("BACKEND_INCONSISTENT", "grant ID must be non-empty")
    return Object.freeze({
        ...grant,
        subject: entityRef(grant.subject.type, grant.subject.id),
        issuer: entityRef(grant.issuer.type, grant.issuer.id),
        claims: Object.freeze(grant.claims.map(cloneDelegableClaim)),
    })
}

export const cloneSnapshot = (snapshot: PermissionRegistrySnapshot): PermissionRegistrySnapshot =>
    Object.freeze({
        revision: snapshot.revision,
        definitions: Object.freeze(snapshot.definitions.map(cloneDefinition)),
        grants: Object.freeze(snapshot.grants.map(cloneGrant)),
        operations: Object.freeze(snapshot.operations.map(operation => Object.freeze({ ...operation }))),
    })
