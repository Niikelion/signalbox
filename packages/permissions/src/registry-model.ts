import { PermissionError } from "./errors"
import { entityRef, permissionClaim, validatePermissionId, type EntityRef, type PermissionClaim } from "./model"

/** A globally unique permission known to the registry. */
export interface PermissionDefinition {
    readonly id: string
    readonly name: string
    readonly description?: string
    readonly retiredAt?: number
}

export type PermissionDeclaration = Omit<PermissionDefinition, "retiredAt">

/** Declare stable permission metadata without coupling a package to registry mutation. */
export const definePermission = (definition: PermissionDeclaration): PermissionDeclaration => {
    const cloned = cloneDefinition(definition)
    return Object.freeze({
        id: cloned.id,
        name: cloned.name,
        ...(cloned.description === undefined ? {} : { description: cloned.description }),
    })
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

export type ResourceStatus = "active" | "blocked" | "disabled"
export type ResourceBlockReason =
    "missing-claims" | "owner-suspended" | "owner-removed" | "permission-retired" | "runtime-attachment-failed"

export interface ResourceOwnershipRecord {
    readonly owner: EntityRef
    readonly changedAt: number
    readonly changedBy: EntityRef
}

/** Durable authority binding for a resource owned by a principal or group. */
export interface OwnedResourceRecord {
    readonly id: EntityRef
    readonly owner: EntityRef
    readonly createdBy: EntityRef
    readonly requiredClaims: readonly PermissionClaim[]
    readonly authorityGrantIds: readonly string[]
    readonly desiredEnabled: boolean
    readonly runtimeAttached: boolean
    readonly status: ResourceStatus
    readonly blockReasons: readonly ResourceBlockReason[]
    readonly ownershipHistory: readonly ResourceOwnershipRecord[]
}

export type ResourceOwnerStatus = "active" | "suspended" | "removed"

export interface ResourceOwnerStateRecord {
    readonly owner: EntityRef
    readonly status: ResourceOwnerStatus
    readonly changedAt: number
}

export type RegistryMutationKind =
    | "define"
    | "retire"
    | "grant-root"
    | "delegate"
    | "revoke"
    | "resource-register"
    | "resource-transfer"
    | "resource-enable"
    | "resource-disable"
    | "resource-reconcile"
    | "owner-suspend"
    | "owner-restore"
    | "owner-remove"

export interface PermissionRegistrySnapshot {
    readonly revision: number
    readonly definitions: readonly PermissionDefinition[]
    readonly grants: readonly AuthorityGrantRecord[]
    readonly resources: readonly OwnedResourceRecord[]
    readonly owners: readonly ResourceOwnerStateRecord[]
    readonly operations: readonly IdempotencyRecord[]
}

export const emptyPermissionRegistrySnapshot = (): PermissionRegistrySnapshot => ({
    revision: 0,
    definitions: [],
    grants: [],
    resources: [],
    owners: [],
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

export const cloneResource = (resource: OwnedResourceRecord): OwnedResourceRecord =>
    Object.freeze({
        ...resource,
        runtimeAttached: (resource as { readonly runtimeAttached?: boolean }).runtimeAttached ?? true,
        id: entityRef(resource.id.type, resource.id.id),
        owner: entityRef(resource.owner.type, resource.owner.id),
        createdBy: entityRef(resource.createdBy.type, resource.createdBy.id),
        requiredClaims: Object.freeze(
            resource.requiredClaims.map(claim => permissionClaim(claim.permissionId, claim.scope)),
        ),
        authorityGrantIds: Object.freeze([...resource.authorityGrantIds]),
        blockReasons: Object.freeze([...resource.blockReasons]),
        ownershipHistory: Object.freeze(
            resource.ownershipHistory.map(item =>
                Object.freeze({
                    owner: entityRef(item.owner.type, item.owner.id),
                    changedAt: item.changedAt,
                    changedBy: entityRef(item.changedBy.type, item.changedBy.id),
                }),
            ),
        ),
    })

export const cloneSnapshot = (snapshot: PermissionRegistrySnapshot): PermissionRegistrySnapshot => {
    const compatible = snapshot as Omit<PermissionRegistrySnapshot, "resources" | "owners"> &
        Partial<Pick<PermissionRegistrySnapshot, "resources" | "owners">>
    return Object.freeze({
        revision: snapshot.revision,
        definitions: Object.freeze(snapshot.definitions.map(cloneDefinition)),
        grants: Object.freeze(snapshot.grants.map(cloneGrant)),
        resources: Object.freeze((compatible.resources ?? []).map(cloneResource)),
        owners: Object.freeze(
            (compatible.owners ?? []).map(item =>
                Object.freeze({
                    owner: entityRef(item.owner.type, item.owner.id),
                    status: item.status,
                    changedAt: item.changedAt,
                }),
            ),
        ),
        operations: Object.freeze(snapshot.operations.map(operation => Object.freeze({ ...operation }))),
    })
}
