import type { AuthorityContribution } from "./authority"
import type { PermissionRegistryBackend, PermissionRegistryDraft } from "./backend"
import { PermissionError } from "./errors"
import {
    entityKey,
    entityRef,
    permissionClaim,
    validatePermissionId,
    type EntityRef,
    type PermissionClaim,
} from "./model"
import type { PermissionRegistryAuditSink } from "./registry-audit"
import {
    cloneDefinition,
    cloneGrant,
    cloneResource,
    cloneSnapshot,
    type AuthorityGrantRecord,
    type DelegableClaim,
    type DelegationMode,
    type IdempotencyRecord,
    type PermissionDefinition,
    type PermissionRegistrySnapshot,
    type OwnedResourceRecord,
    type ResourceOwnerStatus,
    type RegistryMutationKind,
} from "./registry-model"
import { GrantStateCell, ResourceStateCell } from "./state"

export interface RegistryMutationOptions {
    readonly actor: EntityRef
    readonly operationId?: string
}

export interface DefinePermissionInput extends RegistryMutationOptions {
    readonly id: string
    readonly name: string
    readonly description?: string
}

export interface RetirePermissionInput extends RegistryMutationOptions {
    readonly id: string
}

export interface GrantAuthorityInput extends RegistryMutationOptions {
    readonly id: string
    readonly subject: EntityRef
    readonly claims: readonly DelegableClaim[]
    readonly expiresAt?: number
}

export interface DelegateAuthorityInput extends GrantAuthorityInput {
    readonly parentGrantId: string
    readonly via: DelegationMode
}

export interface RevokeAuthorityInput extends RegistryMutationOptions {
    readonly id: string
}

export interface RegisterResourceInput extends RegistryMutationOptions {
    readonly id: EntityRef
    readonly owner?: EntityRef
    readonly requiredClaims: readonly PermissionClaim[]
    readonly parentGrantIds: readonly string[]
    /** Attach the live runtime after durable authority is staged. Failure leaves the resource blocked for retry. */
    readonly attach?: (resource: OwnedResourceRecord) => void | Promise<void>
}

export interface TransferResourceInput extends RegistryMutationOptions {
    readonly id: EntityRef
    readonly targetOwner: EntityRef
    readonly parentGrantIds: readonly string[]
}

export interface SetResourceEnabledInput extends RegistryMutationOptions {
    readonly id: EntityRef
    readonly enabled: boolean
}

export interface SetResourceOwnerStatusInput extends RegistryMutationOptions {
    readonly owner: EntityRef
    readonly status: ResourceOwnerStatus
}

export interface PermissionRegistry {
    define(input: DefinePermissionInput): Promise<PermissionDefinition>
    retire(input: RetirePermissionInput): Promise<PermissionDefinition>
    delegate(input: DelegateAuthorityInput): Promise<AuthorityGrantRecord>
    revoke(input: RevokeAuthorityInput): Promise<AuthorityGrantRecord>
    registerResource(input: RegisterResourceInput): Promise<OwnedResourceRecord>
    transferResource(input: TransferResourceInput): Promise<OwnedResourceRecord>
    setResourceEnabled(input: SetResourceEnabledInput): Promise<OwnedResourceRecord>
    setOwnerStatus(input: SetResourceOwnerStatusInput): Promise<void>
    reconcileResource(id: EntityRef, actor: EntityRef): Promise<OwnedResourceRecord>
    definition(id: string): PermissionDefinition | undefined
    grant(id: string): AuthorityGrantRecord | undefined
    resource(id: EntityRef): OwnedResourceRecord | undefined
    contributionsFor(subject: EntityRef): readonly AuthorityContribution[]
    snapshot(): PermissionRegistrySnapshot
}

/** Kept outside ordinary runtime consumers because it creates authority without a parent grant. */
export interface PermissionRegistryBootstrap {
    grant(input: GrantAuthorityInput): Promise<AuthorityGrantRecord>
}

export interface PermissionRegistryOptions {
    readonly backend: PermissionRegistryBackend
    readonly audit?: PermissionRegistryAuditSink
    readonly now?: () => number
}

interface CompiledRegistry {
    readonly snapshot: PermissionRegistrySnapshot
    readonly definitions: Map<string, PermissionDefinition>
    readonly grants: Map<string, AuthorityGrantRecord>
    readonly resources: Map<string, OwnedResourceRecord>
    readonly states: Map<string, GrantStateCell>
    readonly resourceStates: Map<string, ResourceStateCell>
    readonly grantResources: Map<string, string>
}

const sameEntity = (left: EntityRef, right: EntityRef): boolean => entityKey(left) === entityKey(right)

const covers = (parent: DelegableClaim, child: DelegableClaim): boolean =>
    parent.claim.permissionId === child.claim.permissionId &&
    (parent.claim.scope === "*" ||
        (child.claim.scope !== "*" && entityKey(parent.claim.scope) === entityKey(child.claim.scope)))

const validateGrantAgainstParent = (grant: AuthorityGrantRecord, parent: AuthorityGrantRecord): void => {
    const delegatedVia = grant.delegatedVia
    if (!delegatedVia || !sameEntity(grant.issuer, parent.subject)) {
        throw new PermissionError("BACKEND_INCONSISTENT", `grant "${grant.id}" has an invalid parent relationship`)
    }
    if (parent.expiresAt !== undefined && grant.expiresAt !== undefined && grant.expiresAt > parent.expiresAt) {
        throw new PermissionError("BACKEND_INCONSISTENT", `grant "${grant.id}" outlives its parent`)
    }
    for (const childClaim of grant.claims) {
        const parentClaim = parent.claims.find(
            candidate => candidate.delegation.includes(delegatedVia) && covers(candidate, childClaim),
        )
        if (!parentClaim || childClaim.delegation.some(mode => !parentClaim.delegation.includes(mode))) {
            throw new PermissionError("BACKEND_INCONSISTENT", `grant "${grant.id}" exceeds its parent authority`)
        }
    }
}

const compile = (
    source: PermissionRegistrySnapshot,
    previousStates: ReadonlyMap<string, GrantStateCell> = new Map(),
    previousResourceStates: ReadonlyMap<string, ResourceStateCell> = new Map(),
): CompiledRegistry => {
    const snapshot = cloneSnapshot(source)
    if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
        throw new PermissionError("BACKEND_INCONSISTENT", "registry revision is invalid")
    }
    const definitions = new Map<string, PermissionDefinition>()
    for (const definition of snapshot.definitions) {
        if (definitions.has(definition.id)) {
            throw new PermissionError("BACKEND_INCONSISTENT", `duplicate permission "${definition.id}"`)
        }
        definitions.set(definition.id, definition)
    }
    const grants = new Map<string, AuthorityGrantRecord>()
    for (const grant of snapshot.grants) {
        if (grants.has(grant.id) || grant.claims.length === 0) {
            throw new PermissionError("BACKEND_INCONSISTENT", `duplicate or empty grant "${grant.id}"`)
        }
        for (const entry of grant.claims) {
            if (!definitions.has(entry.claim.permissionId)) {
                throw new PermissionError(
                    "BACKEND_INCONSISTENT",
                    `grant "${grant.id}" references undefined permission "${entry.claim.permissionId}"`,
                )
            }
        }
        grants.set(grant.id, grant)
    }
    const states = new Map<string, GrantStateCell>()
    const visiting = new Set<string>()
    const buildState = (grant: AuthorityGrantRecord): GrantStateCell => {
        const existing = states.get(grant.id)
        if (existing) return existing
        if (visiting.has(grant.id)) {
            throw new PermissionError("BACKEND_INCONSISTENT", `grant parent cycle at "${grant.id}"`)
        }
        visiting.add(grant.id)
        const parent = grant.parentGrantId ? grants.get(grant.parentGrantId) : undefined
        if (grant.parentGrantId && !parent) {
            throw new PermissionError("BACKEND_INCONSISTENT", `grant "${grant.id}" has a missing parent`)
        }
        if (parent) validateGrantAgainstParent(grant, parent)
        else if (grant.delegatedVia) {
            throw new PermissionError("BACKEND_INCONSISTENT", `root grant "${grant.id}" has delegation metadata`)
        }
        const parentState = parent ? buildState(parent) : undefined
        const prior = previousStates.get(grant.id)
        const effectiveExpiry =
            parentState?.expiresAt === undefined
                ? grant.expiresAt
                : grant.expiresAt === undefined
                  ? parentState.expiresAt
                  : Math.min(parentState.expiresAt, grant.expiresAt)
        const state =
            prior && prior.parent === parentState && prior.expiresAt === effectiveExpiry
                ? prior
                : new GrantStateCell({ id: grant.id, expiresAt: grant.expiresAt, parent: parentState })
        states.set(grant.id, state)
        visiting.delete(grant.id)
        if (grant.revokedAt !== undefined) state.revoke(grant.revokedAt)
        const retirement = grant.claims
            .map(entry => definitions.get(entry.claim.permissionId)?.retiredAt)
            .filter((value): value is number => value !== undefined)
            .sort((left, right) => left - right)[0]
        if (retirement !== undefined) state.revoke(retirement)
        return state
    }
    for (const grant of grants.values()) buildState(grant)
    const resources = new Map<string, OwnedResourceRecord>()
    const resourceStates = new Map<string, ResourceStateCell>()
    const grantResources = new Map<string, string>()
    for (const resource of snapshot.resources) {
        const key = entityKey(resource.id)
        if (resources.has(key)) throw new PermissionError("BACKEND_INCONSISTENT", `duplicate resource ${key}`)
        resources.set(key, resource)
        const prior = previousResourceStates.get(key)
        const state = prior ?? new ResourceStateCell(resource.id)
        state.setActive(resource.status === "active")
        resourceStates.set(key, state)
        for (const grantId of resource.authorityGrantIds) {
            const grant = grants.get(grantId)
            if (!grant || !sameEntity(grant.subject, resource.id) || grant.delegatedVia !== "owned-resource") {
                throw new PermissionError(
                    "BACKEND_INCONSISTENT",
                    `resource ${key} has invalid authority grant "${grantId}"`,
                )
            }
            grantResources.set(grantId, key)
        }
    }
    for (const grant of grants.values()) {
        let parentId = grant.parentGrantId
        while (parentId) {
            const resourceKey = grantResources.get(parentId)
            if (resourceKey) {
                grantResources.set(grant.id, resourceKey)
                break
            }
            parentId = grants.get(parentId)?.parentGrantId
        }
    }
    const operations = new Set<string>()
    for (const operation of snapshot.operations) {
        if (operations.has(operation.id)) {
            throw new PermissionError("BACKEND_INCONSISTENT", `duplicate operation "${operation.id}"`)
        }
        operations.add(operation.id)
    }
    return { snapshot, definitions, grants, resources, states, resourceStates, grantResources }
}

const fingerprint = (value: unknown): string => JSON.stringify(value)

const operationResult = (
    draft: PermissionRegistryDraft,
    id: string | undefined,
    kind: RegistryMutationKind,
    inputFingerprint: string,
): string | undefined => {
    if (!id) return undefined
    const existing = draft.operations.find(operation => operation.id === id)
    if (!existing) return undefined
    if (existing.kind !== kind || existing.fingerprint !== inputFingerprint) {
        throw new PermissionError("IDEMPOTENCY_CONFLICT", `operation "${id}" was already used for different input`)
    }
    return existing.resultId
}

const recordOperation = (
    draft: PermissionRegistryDraft,
    id: string | undefined,
    kind: RegistryMutationKind,
    inputFingerprint: string,
    resultId: string,
): void => {
    if (!id) return
    const record: IdempotencyRecord = { id, kind, fingerprint: inputFingerprint, resultId }
    draft.operations = [...draft.operations, record]
}

const normalizedClaims = (claims: readonly DelegableClaim[]): readonly DelegableClaim[] =>
    claims.map(entry => ({
        claim: permissionClaim(entry.claim.permissionId, entry.claim.scope),
        delegation: [...new Set(entry.delegation)].sort(),
    }))

const grantActive = (
    grant: AuthorityGrantRecord,
    grants: readonly AuthorityGrantRecord[],
    at: number,
    visited = new Set<string>(),
): boolean => {
    if (
        visited.has(grant.id) ||
        grant.revokedAt !== undefined ||
        (grant.expiresAt !== undefined && at >= grant.expiresAt)
    ) {
        return false
    }
    if (!grant.parentGrantId) return true
    const parent = grants.find(item => item.id === grant.parentGrantId)
    return parent ? grantActive(parent, grants, at, new Set([...visited, grant.id])) : false
}

const actorHas = (draft: PermissionRegistryDraft, actor: EntityRef, claim: PermissionClaim, at: number): boolean =>
    draft.grants.some(
        grant =>
            sameEntity(grant.subject, actor) &&
            grantActive(grant, draft.grants, at) &&
            grant.claims.some(entry => covers(entry, { claim, delegation: [] })),
    )

const reconcileResources = (draft: PermissionRegistryDraft, at: number): void => {
    draft.resources = draft.resources.map(resource => {
        const reasons = new Set<OwnedResourceRecord["blockReasons"][number]>()
        const ownerStatus = draft.owners.find(item => sameEntity(item.owner, resource.owner))?.status ?? "active"
        if (ownerStatus === "suspended") reasons.add("owner-suspended")
        if (ownerStatus === "removed") reasons.add("owner-removed")
        if (!resource.runtimeAttached) reasons.add("runtime-attachment-failed")
        if (
            resource.requiredClaims.some(
                claim => draft.definitions.find(item => item.id === claim.permissionId)?.retiredAt !== undefined,
            )
        ) {
            reasons.add("permission-retired")
        }
        const authority = resource.authorityGrantIds
            .map(id => draft.grants.find(grant => grant.id === id))
            .filter(
                (grant): grant is AuthorityGrantRecord => grant !== undefined && grantActive(grant, draft.grants, at),
            )
        if (
            resource.requiredClaims.some(required =>
                authority.every(grant =>
                    grant.claims.every(entry => !covers(entry, { claim: required, delegation: [] })),
                ),
            )
        ) {
            reasons.add("missing-claims")
        }
        const status = !resource.desiredEnabled ? "disabled" : reasons.size > 0 ? "blocked" : "active"
        return cloneResource({ ...resource, status, blockReasons: [...reasons].sort() })
    })
}

/** Load, validate, and compile a permission registry. Invalid durable state fails startup closed. */
export const createPermissionRegistry = async (
    options: PermissionRegistryOptions,
): Promise<{ readonly registry: PermissionRegistry; readonly bootstrap: PermissionRegistryBootstrap }> => {
    const now = options.now ?? Date.now
    const initial = cloneSnapshot(await options.backend.snapshot())
    const reconstructed: PermissionRegistryDraft = {
        revision: initial.revision,
        definitions: [...initial.definitions],
        grants: [...initial.grants],
        resources: [...initial.resources],
        owners: [...initial.owners],
        operations: [...initial.operations],
    }
    reconcileResources(reconstructed, now())
    let compiled = compile(reconstructed)

    const mutation = async <T extends PermissionDefinition | AuthorityGrantRecord>(
        kind: RegistryMutationKind,
        actor: EntityRef,
        operationId: string | undefined,
        inputFingerprint: string,
        change: (draft: PermissionRegistryDraft, replayId: string | undefined, timestamp: number) => T,
    ): Promise<T> => {
        const timestamp = now()
        const result = await options.backend.transaction(draft => {
            const replayId = operationResult(draft, operationId, kind, inputFingerprint)
            const changed = change(draft, replayId, timestamp)
            reconcileResources(draft, timestamp)
            compile({ ...draft, revision: draft.revision + 1 })
            options.audit?.({
                type: "permission-registry",
                timestamp,
                operation: kind,
                ...(operationId ? { operationId } : {}),
                actor: entityRef(actor.type, actor.id),
                targetId: changed.id,
            })
            return changed
        })
        compiled = compile(await options.backend.snapshot(), compiled.states, compiled.resourceStates)
        return result
    }

    const resourceMutation = async <T>(
        kind: RegistryMutationKind,
        actor: EntityRef,
        operationId: string | undefined,
        inputFingerprint: string,
        targetId: string,
        change: (draft: PermissionRegistryDraft, replayId: string | undefined, timestamp: number) => T,
    ): Promise<T> => {
        const timestamp = now()
        const result = await options.backend.transaction(draft => {
            const replayId = operationResult(draft, operationId, kind, inputFingerprint)
            const value = change(draft, replayId, timestamp)
            reconcileResources(draft, timestamp)
            compile({ ...draft, revision: draft.revision + 1 })
            options.audit?.({
                type: "permission-registry",
                timestamp,
                operation: kind,
                ...(operationId ? { operationId } : {}),
                actor: entityRef(actor.type, actor.id),
                targetId,
            })
            return value
        })
        compiled = compile(await options.backend.snapshot(), compiled.states, compiled.resourceStates)
        return result
    }

    const define = (input: DefinePermissionInput): Promise<PermissionDefinition> => {
        const definition = cloneDefinition({
            id: validatePermissionId(input.id),
            name: input.name,
            ...(input.description === undefined ? {} : { description: input.description }),
        })
        const key = fingerprint(definition)
        return mutation("define", input.actor, input.operationId, key, (draft, replayId) => {
            const existing = draft.definitions.find(item => item.id === (replayId ?? definition.id))
            if (replayId && !existing) throw new PermissionError("BACKEND_INCONSISTENT", "operation result is missing")
            if (existing) {
                if (fingerprint(existing) !== key) {
                    throw new PermissionError("PERMISSION_ALREADY_DEFINED", `permission "${definition.id}" differs`)
                }
                return existing
            }
            draft.definitions = [...draft.definitions, definition]
            recordOperation(draft, input.operationId, "define", key, definition.id)
            return definition
        })
    }

    const retire = (input: RetirePermissionInput): Promise<PermissionDefinition> => {
        const key = fingerprint({ id: input.id })
        return mutation("retire", input.actor, input.operationId, key, (draft, replayId, timestamp) => {
            const id = replayId ?? validatePermissionId(input.id)
            const existing = draft.definitions.find(item => item.id === id)
            if (!existing) throw new PermissionError("PERMISSION_UNDEFINED", `permission "${id}" is undefined`)
            if (existing.retiredAt !== undefined) return existing
            const retired = cloneDefinition({ ...existing, retiredAt: timestamp })
            draft.definitions = draft.definitions.map(item => (item.id === id ? retired : item))
            recordOperation(draft, input.operationId, "retire", key, id)
            return retired
        })
    }

    const makeGrant = (
        input: GrantAuthorityInput,
        parentGrantId?: string,
        delegatedVia?: DelegationMode,
    ): AuthorityGrantRecord =>
        cloneGrant({
            id: input.id,
            subject: input.subject,
            issuer: input.actor,
            claims: normalizedClaims(input.claims),
            ...(parentGrantId ? { parentGrantId } : {}),
            ...(delegatedVia ? { delegatedVia } : {}),
            ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        })

    const grant = (
        kind: "grant-root" | "delegate",
        input: GrantAuthorityInput,
        parentGrantId?: string,
        delegatedVia?: DelegationMode,
    ): Promise<AuthorityGrantRecord> => {
        const proposed = makeGrant(input, parentGrantId, delegatedVia)
        const key = fingerprint(proposed)
        return mutation(kind, input.actor, input.operationId, key, (draft, replayId, timestamp) => {
            const existing = draft.grants.find(item => item.id === (replayId ?? proposed.id))
            if (existing) {
                if (fingerprint(existing) !== key)
                    throw new PermissionError("GRANT_INVALID", `grant "${proposed.id}" differs`)
                return existing
            }
            if (input.expiresAt !== undefined && input.expiresAt <= timestamp) {
                throw new PermissionError("GRANT_EXPIRED", `grant "${input.id}" is already expired`)
            }
            for (const entry of proposed.claims) {
                const definition = draft.definitions.find(item => item.id === entry.claim.permissionId)
                if (!definition) {
                    throw new PermissionError(
                        "PERMISSION_UNDEFINED",
                        `permission "${entry.claim.permissionId}" is undefined`,
                    )
                }
                if (definition.retiredAt !== undefined) {
                    throw new PermissionError(
                        "PERMISSION_RETIRED",
                        `permission "${entry.claim.permissionId}" is retired`,
                    )
                }
            }
            if (parentGrantId) {
                const parent = draft.grants.find(item => item.id === parentGrantId)
                if (
                    !parent ||
                    parent.revokedAt !== undefined ||
                    (parent.expiresAt !== undefined && timestamp >= parent.expiresAt)
                ) {
                    throw new PermissionError("DELEGATION_DENIED", `parent grant "${parentGrantId}" is not active`)
                }
                try {
                    validateGrantAgainstParent(proposed, parent)
                } catch {
                    throw new PermissionError("DELEGATION_DENIED", `grant "${proposed.id}" exceeds parent authority`)
                }
            }
            draft.grants = [...draft.grants, proposed]
            recordOperation(draft, input.operationId, kind, key, proposed.id)
            return proposed
        })
    }

    const revoke = (input: RevokeAuthorityInput): Promise<AuthorityGrantRecord> => {
        const key = fingerprint({ id: input.id })
        return mutation("revoke", input.actor, input.operationId, key, (draft, replayId, timestamp) => {
            const id = replayId ?? input.id
            const existing = draft.grants.find(item => item.id === id)
            if (!existing) throw new PermissionError("GRANT_INVALID", `grant "${id}" is undefined`)
            if (existing.revokedAt !== undefined) return existing
            const revoked = cloneGrant({ ...existing, revokedAt: timestamp })
            draft.grants = draft.grants.map(item => (item.id === id ? revoked : item))
            recordOperation(draft, input.operationId, "revoke", key, id)
            return revoked
        })
    }

    const bindResourceAuthority = (
        draft: PermissionRegistryDraft,
        resource: EntityRef,
        owner: EntityRef,
        requiredClaims: readonly PermissionClaim[],
        parentGrantIds: readonly string[],
        timestamp: number,
    ): readonly string[] => {
        const parents = parentGrantIds.map(id => {
            const parent = draft.grants.find(grant => grant.id === id)
            if (!parent || !sameEntity(parent.subject, owner) || !grantActive(parent, draft.grants, timestamp)) {
                throw new PermissionError("RESOURCE_BLOCKED", `owner authority grant "${id}" is unavailable`)
            }
            return parent
        })
        const grouped = new Map<string, { parent: AuthorityGrantRecord; claims: DelegableClaim[] }>()
        for (const required of requiredClaims) {
            const match = parents
                .flatMap(parent => parent.claims.map(entry => ({ parent, entry })))
                .find(
                    ({ entry }) =>
                        entry.delegation.includes("owned-resource") &&
                        covers(entry, { claim: required, delegation: [] }),
                )
            if (!match) {
                throw new PermissionError(
                    "RESOURCE_BLOCKED",
                    `owner authority does not cover ${required.permissionId}:${required.scope === "*" ? "*" : entityKey(required.scope)}`,
                )
            }
            const bucket = grouped.get(match.parent.id) ?? { parent: match.parent, claims: [] }
            bucket.claims.push({
                claim: required,
                delegation: match.entry.delegation.includes("subject") ? ["subject"] : [],
            })
            grouped.set(match.parent.id, bucket)
        }
        const ids: string[] = []
        let index = 0
        for (const { parent, claims } of grouped.values()) {
            const id = `${entityKey(resource)}:authority:${String(draft.revision + 1)}:${String(index)}`
            index += 1
            const grant = cloneGrant({
                id,
                subject: resource,
                issuer: owner,
                claims,
                parentGrantId: parent.id,
                delegatedVia: "owned-resource",
            })
            validateGrantAgainstParent(grant, parent)
            draft.grants = [...draft.grants, grant]
            ids.push(id)
        }
        return ids
    }

    const registerResource = async (input: RegisterResourceInput): Promise<OwnedResourceRecord> => {
        const id = entityRef(input.id.type, input.id.id)
        const owner = input.owner
            ? entityRef(input.owner.type, input.owner.id)
            : entityRef(input.actor.type, input.actor.id)
        const requiredClaims = input.requiredClaims.map(claim => permissionClaim(claim.permissionId, claim.scope))
        const key = fingerprint({ id, owner, requiredClaims, parentGrantIds: [...input.parentGrantIds] })
        await resourceMutation(
            "resource-register",
            input.actor,
            input.operationId,
            key,
            entityKey(id),
            (draft, replayId, timestamp) => {
                const existing = draft.resources.find(item => entityKey(item.id) === (replayId ?? entityKey(id)))
                if (existing) {
                    if (
                        entityKey(existing.owner) !== entityKey(owner) ||
                        fingerprint(existing.requiredClaims) !== fingerprint(requiredClaims)
                    ) {
                        throw new PermissionError("RESOURCE_ALREADY_REGISTERED", `resource ${entityKey(id)} differs`)
                    }
                    return existing
                }
                if (
                    !sameEntity(input.actor, owner) &&
                    !actorHas(draft, input.actor, permissionClaim("resource.create", owner), timestamp)
                ) {
                    throw new PermissionError(
                        "PERMISSION_DENIED",
                        "creating a resource for another owner requires resource.create",
                    )
                }
                for (const claim of requiredClaims) {
                    const definition = draft.definitions.find(item => item.id === claim.permissionId)
                    if (!definition || definition.retiredAt !== undefined) {
                        throw new PermissionError(
                            definition ? "PERMISSION_RETIRED" : "PERMISSION_UNDEFINED",
                            claim.permissionId,
                        )
                    }
                }
                const authorityGrantIds = bindResourceAuthority(
                    draft,
                    id,
                    owner,
                    requiredClaims,
                    input.parentGrantIds,
                    timestamp,
                )
                const resource = cloneResource({
                    id,
                    owner,
                    createdBy: input.actor,
                    requiredClaims,
                    authorityGrantIds,
                    desiredEnabled: true,
                    runtimeAttached: input.attach === undefined,
                    status: input.attach === undefined ? "active" : "blocked",
                    blockReasons: input.attach === undefined ? [] : ["runtime-attachment-failed"],
                    ownershipHistory: [{ owner, changedAt: timestamp, changedBy: input.actor }],
                })
                draft.resources = [...draft.resources, resource]
                recordOperation(draft, input.operationId, "resource-register", key, entityKey(id))
                return resource
            },
        )
        const registered = compiled.resources.get(entityKey(id))
        if (!registered) throw new PermissionError("BACKEND_INCONSISTENT", "registered resource is missing")
        if (!input.attach || registered.runtimeAttached) return registered
        await input.attach(registered)
        await resourceMutation(
            "resource-reconcile",
            input.actor,
            undefined,
            fingerprint({ id, runtimeAttached: true }),
            entityKey(id),
            draft => {
                const resource = draft.resources.find(item => sameEntity(item.id, id))
                if (!resource) throw new PermissionError("RESOURCE_NOT_FOUND", `resource ${entityKey(id)} is undefined`)
                const attached = cloneResource({ ...resource, runtimeAttached: true })
                draft.resources = draft.resources.map(item => (sameEntity(item.id, id) ? attached : item))
                return attached
            },
        )
        const attached = compiled.resources.get(entityKey(id))
        if (!attached) throw new PermissionError("BACKEND_INCONSISTENT", "attached resource is missing")
        return attached
    }

    const transferResource = async (input: TransferResourceInput): Promise<OwnedResourceRecord> => {
        const id = entityRef(input.id.type, input.id.id)
        const targetOwner = entityRef(input.targetOwner.type, input.targetOwner.id)
        const key = fingerprint({ id, targetOwner, parentGrantIds: [...input.parentGrantIds] })
        await resourceMutation(
            "resource-transfer",
            input.actor,
            input.operationId,
            key,
            entityKey(id),
            (draft, replayId, timestamp) => {
                const resource = draft.resources.find(item => entityKey(item.id) === (replayId ?? entityKey(id)))
                if (!resource) throw new PermissionError("RESOURCE_NOT_FOUND", `resource ${entityKey(id)} is undefined`)
                if (sameEntity(resource.owner, targetOwner)) return resource
                const canManage = actorHas(draft, input.actor, permissionClaim("resource.manage", id), timestamp)
                const canTarget = actorHas(
                    draft,
                    input.actor,
                    permissionClaim("resource.ownership.transfer", targetOwner),
                    timestamp,
                )
                if (!canManage || !canTarget) {
                    throw new PermissionError(
                        "OWNERSHIP_TRANSFER_DENIED",
                        "transfer requires source management and target scope",
                    )
                }
                const replacementIds = bindResourceAuthority(
                    draft,
                    id,
                    targetOwner,
                    resource.requiredClaims,
                    input.parentGrantIds,
                    timestamp,
                )
                draft.grants = draft.grants.map(grant =>
                    resource.authorityGrantIds.includes(grant.id) && grant.revokedAt === undefined
                        ? cloneGrant({ ...grant, revokedAt: timestamp })
                        : grant,
                )
                const transferred = cloneResource({
                    ...resource,
                    owner: targetOwner,
                    authorityGrantIds: replacementIds,
                    ownershipHistory: [
                        ...resource.ownershipHistory,
                        { owner: targetOwner, changedAt: timestamp, changedBy: input.actor },
                    ],
                })
                draft.resources = draft.resources.map(item => (sameEntity(item.id, id) ? transferred : item))
                recordOperation(draft, input.operationId, "resource-transfer", key, entityKey(id))
                return transferred
            },
        )
        const transferred = compiled.resources.get(entityKey(id))
        if (!transferred) throw new PermissionError("BACKEND_INCONSISTENT", "transferred resource is missing")
        return transferred
    }

    const setResourceEnabled = async (input: SetResourceEnabledInput): Promise<OwnedResourceRecord> => {
        const id = entityRef(input.id.type, input.id.id)
        const kind = input.enabled ? "resource-enable" : "resource-disable"
        const key = fingerprint({ id, enabled: input.enabled })
        await resourceMutation(kind, input.actor, input.operationId, key, entityKey(id), (draft, replayId) => {
            const resource = draft.resources.find(item => entityKey(item.id) === (replayId ?? entityKey(id)))
            if (!resource) throw new PermissionError("RESOURCE_NOT_FOUND", `resource ${entityKey(id)} is undefined`)
            const updated = cloneResource({ ...resource, desiredEnabled: input.enabled })
            draft.resources = draft.resources.map(item => (sameEntity(item.id, id) ? updated : item))
            recordOperation(draft, input.operationId, kind, key, entityKey(id))
            return updated
        })
        const updated = compiled.resources.get(entityKey(id))
        if (!updated) throw new PermissionError("BACKEND_INCONSISTENT", "updated resource is missing")
        return updated
    }

    const setOwnerStatus = async (input: SetResourceOwnerStatusInput): Promise<void> => {
        const operation =
            input.status === "active"
                ? "owner-restore"
                : input.status === "suspended"
                  ? "owner-suspend"
                  : "owner-remove"
        const key = fingerprint({ owner: input.owner, status: input.status })
        await resourceMutation(
            operation,
            input.actor,
            input.operationId,
            key,
            entityKey(input.owner),
            (draft, replayId, timestamp) => {
                if (replayId) return
                if (
                    !sameEntity(input.actor, input.owner) &&
                    !actorHas(draft, input.actor, permissionClaim("resource.manage", input.owner), timestamp)
                ) {
                    throw new PermissionError("PERMISSION_DENIED", "changing owner state requires resource.manage")
                }
                const record = {
                    owner: entityRef(input.owner.type, input.owner.id),
                    status: input.status,
                    changedAt: timestamp,
                } as const
                draft.owners = [...draft.owners.filter(item => !sameEntity(item.owner, input.owner)), record]
                if (input.status === "removed") {
                    const ids = new Set(
                        draft.resources
                            .filter(item => sameEntity(item.owner, input.owner))
                            .flatMap(item => item.authorityGrantIds),
                    )
                    draft.grants = draft.grants.map(grant =>
                        ids.has(grant.id) && grant.revokedAt === undefined
                            ? cloneGrant({ ...grant, revokedAt: timestamp })
                            : grant,
                    )
                }
                recordOperation(draft, input.operationId, operation, key, entityKey(input.owner))
            },
        )
    }

    const reconcileResource = async (id: EntityRef, actor: EntityRef): Promise<OwnedResourceRecord> => {
        await resourceMutation("resource-reconcile", actor, undefined, fingerprint(id), entityKey(id), draft => {
            const resource = draft.resources.find(item => sameEntity(item.id, id))
            if (!resource) throw new PermissionError("RESOURCE_NOT_FOUND", `resource ${entityKey(id)} is undefined`)
            return resource
        })
        const reconciled = compiled.resources.get(entityKey(id))
        if (!reconciled) throw new PermissionError("BACKEND_INCONSISTENT", "reconciled resource is missing")
        return reconciled
    }

    const stateFor = (grantId: string): GrantStateCell => {
        const state = compiled.states.get(grantId)
        if (!state) throw new PermissionError("BACKEND_INCONSISTENT", `grant state "${grantId}" is missing`)
        return state
    }

    const registryValue: PermissionRegistry = {
        define,
        retire,
        delegate: input => grant("delegate", input, input.parentGrantId, input.via),
        revoke,
        registerResource,
        transferResource,
        setResourceEnabled,
        setOwnerStatus,
        reconcileResource,
        definition: id => compiled.definitions.get(id),
        grant: id => compiled.grants.get(id),
        resource: id => compiled.resources.get(entityKey(id)),
        contributionsFor: subject =>
            Object.freeze(
                [...compiled.grants.values()]
                    .filter(item => sameEntity(item.subject, subject))
                    .flatMap(item =>
                        item.claims.map(entry => {
                            const resourceKey = compiled.grantResources.get(item.id)
                            return {
                                claim: entry.claim,
                                grant: stateFor(item.id),
                                ...(resourceKey ? { resource: compiled.resourceStates.get(resourceKey) } : {}),
                            }
                        }),
                    ),
            ),
        snapshot: () => compiled.snapshot,
    }
    const registry = Object.freeze(registryValue)
    const bootstrapValue: PermissionRegistryBootstrap = {
        grant: input => grant("grant-root", input),
    }
    const bootstrap = Object.freeze(bootstrapValue)
    return Object.freeze({ registry, bootstrap })
}
