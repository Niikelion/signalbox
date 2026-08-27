import { AsyncLocalStorage } from "node:async_hooks"
import type { AuthorizationAuditEvent, PermissionAuditSink } from "./audit"
import { PermissionError } from "./errors"
import {
    authorityFromIdentity,
    createTrustedIdentityIssuer,
    requireAuthorityRecord,
    type ActiveAuthority,
    type IdentityGrant,
    type TrustedIdentityIssuer,
} from "./identity"
import { permissionClaim, type PermissionClaim } from "./model"

export interface PermissionExecutionContext {
    readonly operation: string
    readonly requestId?: string
}

export interface ProtectOptions {
    readonly operation?: string
}

export interface PermissionExecutionOptions {
    readonly audit?: PermissionAuditSink
    readonly now?: () => number
}

type ClaimSelector<TInput> = (
    input: TInput,
) => PermissionClaim | readonly PermissionClaim[] | Promise<PermissionClaim | readonly PermissionClaim[]>

type ProtectedHandler<TInput, TOutput> = (input: TInput) => TOutput | Promise<TOutput>

interface ExecutionLease {
    readonly authority: ActiveAuthority
    readonly context: PermissionExecutionContext
    open: boolean
}

/** Restricted enforcement capability supplied to core and plugin contexts. */
export interface PermissionRuntime {
    authorityFor(identity: IdentityGrant): ActiveAuthority
    currentAuthority(): ActiveAuthority
    runAs<T>(identity: IdentityGrant, context: PermissionExecutionContext, callback: () => T | Promise<T>): Promise<T>
    authorize(
        authority: ActiveAuthority,
        claims: PermissionClaim | readonly PermissionClaim[],
        context: PermissionExecutionContext,
    ): void
    protect<TInput, TOutput>(
        selector: ClaimSelector<TInput>,
        handler: ProtectedHandler<TInput, TOutput>,
        options?: ProtectOptions,
    ): (input: TInput) => Promise<TOutput>
}

export interface PermissionExecution {
    readonly runtime: PermissionRuntime
    readonly identities: TrustedIdentityIssuer
}

const normalizeClaims = (claims: PermissionClaim | readonly PermissionClaim[]): readonly PermissionClaim[] =>
    (Array.isArray(claims) ? (claims as readonly PermissionClaim[]) : [claims as PermissionClaim]).map(claim =>
        permissionClaim(claim.permissionId, claim.scope),
    )

/** Create paired runtime and trusted identity-issuance capabilities. */
export const createPermissionExecution = (options: PermissionExecutionOptions = {}): PermissionExecution => {
    const owner = Symbol("permission-runtime")
    const storage = new AsyncLocalStorage<ExecutionLease>()
    const now = options.now ?? Date.now

    const emit = (event: AuthorizationAuditEvent): void => options.audit?.(Object.freeze(event))

    const authorityFor = (identity: IdentityGrant): ActiveAuthority => authorityFromIdentity(owner, identity)

    const authorize: PermissionRuntime["authorize"] = (authority, requested, context) => {
        requireAuthorityRecord(owner, authority)
        const claims = normalizeClaims(requested)
        const timestamp = now()
        const contributingGrantIds = [...new Set(claims.flatMap(claim => authority.matchingGrantIds(claim, timestamp)))]
        try {
            authority.require(claims, timestamp)
        } catch (error) {
            const permissionError =
                error instanceof PermissionError
                    ? error
                    : new PermissionError("PERMISSION_DENIED", "permission authorization failed")
            emit({
                type: "authorization",
                timestamp,
                operation: context.operation,
                ...(context.requestId !== undefined ? { requestId: context.requestId } : {}),
                principal: authority.principal,
                origin: authority.origin,
                requiredClaims: Object.freeze([...claims]),
                contributingGrantIds: Object.freeze(contributingGrantIds),
                decision: "deny",
                code: permissionError.code,
            })
            throw permissionError
        }
        emit({
            type: "authorization",
            timestamp,
            operation: context.operation,
            ...(context.requestId !== undefined ? { requestId: context.requestId } : {}),
            principal: authority.principal,
            origin: authority.origin,
            requiredClaims: Object.freeze([...claims]),
            contributingGrantIds: Object.freeze(contributingGrantIds),
            decision: "allow",
        })
    }

    const currentLease = (): ExecutionLease => {
        const lease = storage.getStore()
        if (!lease?.open)
            throw new PermissionError("AUTHORITY_MISSING", "protected action has no active execution lease")
        return lease
    }

    const runtime: PermissionRuntime = {
        authorityFor,
        currentAuthority: () => currentLease().authority,
        runAs: async (identity, context, callback) => {
            const lease: ExecutionLease = {
                authority: authorityFor(identity),
                context: Object.freeze({ ...context }),
                open: true,
            }
            return storage.run(lease, async () => {
                try {
                    return await callback()
                } finally {
                    lease.open = false
                }
            })
        },
        authorize,
        protect:
            (selector, handler, protectOptions = {}) =>
            async input => {
                const lease = currentLease()
                const claims = normalizeClaims(await selector(input))
                if (!lease.open) {
                    throw new PermissionError("AUTHORITY_MISSING", "execution lease closed before authorization")
                }
                authorize(lease.authority, claims, {
                    ...lease.context,
                    operation: protectOptions.operation ?? lease.context.operation,
                })
                return handler(input)
            },
    }

    return Object.freeze({ runtime: Object.freeze(runtime), identities: createTrustedIdentityIssuer(owner) })
}
