import type { AuthorityContribution } from "./authority"
import type { PermissionRegistryBackend, PermissionRegistryDraft } from "./backend"
import { PermissionError } from "./errors"
import { entityKey, entityRef, permissionClaim, validatePermissionId, type EntityRef } from "./model"
import type { PermissionRegistryAuditSink } from "./registry-audit"
import {
    cloneDefinition,
    cloneGrant,
    cloneSnapshot,
    type AuthorityGrantRecord,
    type DelegableClaim,
    type DelegationMode,
    type IdempotencyRecord,
    type PermissionDefinition,
    type PermissionRegistrySnapshot,
    type RegistryMutationKind,
} from "./registry-model"
import { GrantStateCell } from "./state"

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

export interface PermissionRegistry {
    define(input: DefinePermissionInput): Promise<PermissionDefinition>
    retire(input: RetirePermissionInput): Promise<PermissionDefinition>
    delegate(input: DelegateAuthorityInput): Promise<AuthorityGrantRecord>
    revoke(input: RevokeAuthorityInput): Promise<AuthorityGrantRecord>
    definition(id: string): PermissionDefinition | undefined
    grant(id: string): AuthorityGrantRecord | undefined
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
    readonly states: Map<string, GrantStateCell>
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
    const operations = new Set<string>()
    for (const operation of snapshot.operations) {
        if (operations.has(operation.id)) {
            throw new PermissionError("BACKEND_INCONSISTENT", `duplicate operation "${operation.id}"`)
        }
        operations.add(operation.id)
    }
    return { snapshot, definitions, grants, states }
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

/** Load, validate, and compile a permission registry. Invalid durable state fails startup closed. */
export const createPermissionRegistry = async (
    options: PermissionRegistryOptions,
): Promise<{ readonly registry: PermissionRegistry; readonly bootstrap: PermissionRegistryBootstrap }> => {
    const now = options.now ?? Date.now
    let compiled = compile(await options.backend.snapshot())

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
        compiled = compile(await options.backend.snapshot(), compiled.states)
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
        definition: id => compiled.definitions.get(id),
        grant: id => compiled.grants.get(id),
        contributionsFor: subject =>
            Object.freeze(
                [...compiled.grants.values()]
                    .filter(item => sameEntity(item.subject, subject))
                    .flatMap(item =>
                        item.claims.map(entry => ({
                            claim: entry.claim,
                            grant: stateFor(item.id),
                        })),
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
