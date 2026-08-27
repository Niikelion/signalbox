import type { IdentityGrant } from "./identity"
import { entityRef, permissionClaim, type EntityRef, type PermissionClaim } from "./model"

export interface PermissionSourceOptions<TInput> {
    readonly entity: EntityRef
    readonly subscriptionClaims: readonly PermissionClaim[]
    readonly identity: (input: TInput) => IdentityGrant | Promise<IdentityGrant>
}

/** Framework-neutral source declaration consumed by core during attachment and event delivery. */
export interface PermissionSourcePolicy<TInput> {
    readonly entity: EntityRef
    readonly subscriptionClaims: readonly PermissionClaim[]
    eventIdentity(input: TInput): Promise<IdentityGrant>
}

/** Define immutable source requirements without embedding authorization logic in a plugin. */
export const definePermissionSource = <TInput>(
    options: PermissionSourceOptions<TInput>,
): PermissionSourcePolicy<TInput> => {
    const entity = entityRef(options.entity.type, options.entity.id)
    const subscriptionClaims = Object.freeze(
        options.subscriptionClaims.map(claim => permissionClaim(claim.permissionId, claim.scope)),
    )
    return Object.freeze({
        entity,
        subscriptionClaims,
        eventIdentity: async (input: TInput) => options.identity(input),
    })
}
