import { PermissionError } from "./errors"
import { entityKey, permissionClaim, type PermissionClaim } from "./model"
import type { GrantStateCell, MembershipStateCell, ResourceStateCell } from "./state"

/** One grant-backed contribution to a compiled authority snapshot. */
export interface AuthorityContribution {
    readonly claim: PermissionClaim
    readonly grant: GrantStateCell
    readonly membership?: MembershipStateCell
    readonly resource?: ResourceStateCell
}

interface PermissionIndex {
    readonly wildcard: AuthorityContribution[]
    readonly exact: Map<string, AuthorityContribution[]>
}

const valid = (contribution: AuthorityContribution, at: number): boolean =>
    contribution.grant.isValid(at) &&
    (contribution.membership?.active ?? true) &&
    (contribution.resource?.active ?? true)

/** Immutable claim index whose shared state cells reflect revocation without rebuilding. */
export class CompiledAuthority {
    readonly #permissions = new Map<string, PermissionIndex>()
    readonly size: number

    constructor(contributions: readonly AuthorityContribution[]) {
        this.size = contributions.length
        for (const contribution of contributions) {
            const stored = Object.freeze({
                ...contribution,
                claim: permissionClaim(contribution.claim.permissionId, contribution.claim.scope),
            })
            let index = this.#permissions.get(stored.claim.permissionId)
            if (!index) {
                index = { wildcard: [], exact: new Map() }
                this.#permissions.set(stored.claim.permissionId, index)
            }
            if (stored.claim.scope === "*") {
                index.wildcard.push(stored)
                continue
            }
            const key = entityKey(stored.claim.scope)
            const bucket = index.exact.get(key) ?? []
            bucket.push(stored)
            index.exact.set(key, bucket)
        }
    }

    /** Whether at least one currently valid grant covers the requested claim. */
    allows(claim: PermissionClaim, at = Date.now()): boolean {
        return this.#candidates(claim).some(contribution => valid(contribution, at))
    }

    /** Require every claim or throw a stable denial error. */
    require(claim: PermissionClaim | readonly PermissionClaim[], at = Date.now()): void {
        const claims: readonly PermissionClaim[] = Array.isArray(claim)
            ? (claim as readonly PermissionClaim[])
            : [claim as PermissionClaim]
        const [firstMissing, ...remainingMissing] = claims.filter(required => !this.allows(required, at))
        if (!firstMissing) return
        const missing = [firstMissing, ...remainingMissing]
        const rendered = missing
            .map(item => `${item.permissionId}:${item.scope === "*" ? "*" : entityKey(item.scope)}`)
            .join(", ")
        const candidates = this.#candidates(firstMissing).filter(
            contribution => contribution.membership?.active ?? true,
        )
        const code = candidates.some(contribution => contribution.resource && !contribution.resource.active)
            ? "RESOURCE_BLOCKED"
            : candidates.some(contribution => contribution.grant.revokedAt !== undefined)
              ? "GRANT_REVOKED"
              : candidates.some(
                      contribution => contribution.grant.expiresAt !== undefined && at >= contribution.grant.expiresAt,
                  )
                ? "GRANT_EXPIRED"
                : "PERMISSION_DENIED"
        throw new PermissionError(code, `missing required permission claim(s): ${rendered}`)
    }

    /** Grant IDs currently satisfying a claim, for audit provenance. */
    matchingGrantIds(claim: PermissionClaim, at = Date.now()): readonly string[] {
        return [
            ...new Set(
                this.#candidates(claim)
                    .filter(contribution => valid(contribution, at))
                    .map(item => item.grant.id),
            ),
        ]
    }

    #candidates(claim: PermissionClaim): readonly AuthorityContribution[] {
        const index = this.#permissions.get(claim.permissionId)
        if (!index) return []
        return claim.scope === "*"
            ? index.wildcard
            : [...index.wildcard, ...(index.exact.get(entityKey(claim.scope)) ?? [])]
    }
}
