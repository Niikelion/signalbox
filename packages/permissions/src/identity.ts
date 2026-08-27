import type { AuthorityContribution } from "./authority"
import { CompiledAuthority } from "./authority"
import { PermissionError } from "./errors"
import { entityRef, type EntityRef, type PermissionClaim } from "./model"

declare const identityGrantBrand: unique symbol
declare const activeAuthorityBrand: unique symbol

/** Opaque proof of an identity issued by a trusted provider. */
export interface IdentityGrant {
    readonly [identityGrantBrand]: true
    toJSON(): never
}

/** Immutable effective authority derived from a trusted identity grant. */
export interface ActiveAuthority {
    readonly [activeAuthorityBrand]: true
    readonly principal: EntityRef
    readonly origin: EntityRef
    readonly groups: readonly EntityRef[]
    allows(claim: PermissionClaim, at?: number): boolean
    require(claim: PermissionClaim | readonly PermissionClaim[], at?: number): void
    matchingGrantIds(claim: PermissionClaim, at?: number): readonly string[]
    toJSON(): never
}

export interface IdentityGrantInput {
    readonly principal: EntityRef
    readonly origin?: EntityRef
    readonly groups?: readonly EntityRef[]
    readonly contributions?: readonly AuthorityContribution[]
}

/** Trusted capability kept outside ordinary plugin and workflow contexts. */
export interface TrustedIdentityIssuer {
    issue(input: IdentityGrantInput): IdentityGrant
}

interface IdentityRecord {
    readonly owner: symbol
    readonly principal: EntityRef
    readonly origin: EntityRef
    readonly groups: readonly EntityRef[]
    readonly authority: AuthorityEvaluator
}

export interface AuthorityEvaluator {
    allows(claim: PermissionClaim, at?: number): boolean
    require(claim: PermissionClaim | readonly PermissionClaim[], at?: number): void
    matchingGrantIds(claim: PermissionClaim, at?: number): readonly string[]
}

export interface ActiveAuthorityRecord {
    readonly principal: EntityRef
    readonly origin: EntityRef
    readonly groups: readonly EntityRef[]
    readonly authority: AuthorityEvaluator
}

const identities = new WeakMap<object, IdentityRecord>()
const authorities = new WeakMap<object, IdentityRecord>()

class IdentityGrantValue implements IdentityGrant {
    declare readonly [identityGrantBrand]: true

    toJSON(): never {
        throw new PermissionError("GRANT_INVALID", "identity grants cannot be serialized")
    }
}

class ActiveAuthorityValue implements ActiveAuthority {
    declare readonly [activeAuthorityBrand]: true
    readonly principal: EntityRef
    readonly origin: EntityRef
    readonly groups: readonly EntityRef[]
    readonly #authority: AuthorityEvaluator

    constructor(record: IdentityRecord) {
        this.principal = record.principal
        this.origin = record.origin
        this.groups = record.groups
        this.#authority = record.authority
    }

    allows(claim: PermissionClaim, at?: number): boolean {
        return this.#authority.allows(claim, at)
    }

    require(claim: PermissionClaim | readonly PermissionClaim[], at?: number): void {
        this.#authority.require(claim, at)
    }

    matchingGrantIds(claim: PermissionClaim, at?: number): readonly string[] {
        return this.#authority.matchingGrantIds(claim, at)
    }

    toJSON(): never {
        throw new PermissionError("GRANT_INVALID", "active authority cannot be serialized")
    }
}

const cloneEntity = (entity: EntityRef): EntityRef => entityRef(entity.type, entity.id)

export const createTrustedIdentityIssuer = (owner: symbol): TrustedIdentityIssuer =>
    Object.freeze({
        issue: (input: IdentityGrantInput) => {
            const principal = cloneEntity(input.principal)
            const record: IdentityRecord = {
                owner,
                principal,
                origin: cloneEntity(input.origin ?? principal),
                groups: Object.freeze((input.groups ?? []).map(cloneEntity)),
                authority: new CompiledAuthority(input.contributions ?? []),
            }
            const grant = Object.freeze(new IdentityGrantValue())
            identities.set(grant, record)
            return grant
        },
    })

export const authorityFromIdentity = (owner: symbol, grant: IdentityGrant): ActiveAuthority => {
    const record = identities.get(grant)
    if (record?.owner !== owner) {
        throw new PermissionError("GRANT_INVALID", "identity grant was not issued by this permission runtime")
    }
    const authority = Object.freeze(new ActiveAuthorityValue(record))
    authorities.set(authority, record)
    return authority
}

export const createActiveAuthority = (owner: symbol, record: ActiveAuthorityRecord): ActiveAuthority => {
    const stored: IdentityRecord = {
        owner,
        principal: cloneEntity(record.principal),
        origin: cloneEntity(record.origin),
        groups: Object.freeze(record.groups.map(cloneEntity)),
        authority: record.authority,
    }
    const authority = Object.freeze(new ActiveAuthorityValue(stored))
    authorities.set(authority, stored)
    return authority
}

export const requireAuthorityRecord = (owner: symbol, authority: ActiveAuthority): ActiveAuthorityRecord => {
    const record = authorities.get(authority)
    if (record?.owner !== owner) {
        throw new PermissionError("GRANT_INVALID", "authority was not created by this permission runtime")
    }
    return record
}
