import { AsyncLocalStorage } from "node:async_hooks"
import type { PermissionAuditEvent, PermissionAuditSink } from "./audit"
import { PermissionError } from "./errors"
import {
    authorityFromIdentity,
    createActiveAuthority,
    createTrustedIdentityIssuer,
    requireAuthorityRecord,
    type AuthorityEvaluator,
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

/** Core-only authority propagation capability; not exposed to plugins or workflow definitions. */
export interface PermissionCoreRuntime {
    authorityFor(identity: IdentityGrant): ActiveAuthority
    currentAuthority(): ActiveAuthority
    run<T>(authority: ActiveAuthority, context: PermissionExecutionContext, callback: () => T | Promise<T>): Promise<T>
    intersect(eventAuthority: ActiveAuthority, ceiling: ActiveAuthority): ActiveAuthority
    narrow(
        authority: ActiveAuthority,
        claims: PermissionClaim | readonly PermissionClaim[],
        context: PermissionExecutionContext,
    ): ActiveAuthority
    elevate(
        authority: ActiveAuthority,
        ceiling: ActiveAuthority,
        claims: PermissionClaim | readonly PermissionClaim[],
        context: PermissionExecutionContext,
    ): ActiveAuthority
    assume(identity: IdentityGrant, ceiling: ActiveAuthority, context: PermissionExecutionContext): ActiveAuthority
    authorize(
        authority: ActiveAuthority,
        claims: PermissionClaim | readonly PermissionClaim[],
        context: PermissionExecutionContext,
    ): void
}

export interface PermissionExecution {
    readonly runtime: PermissionRuntime
    readonly core: PermissionCoreRuntime
    readonly identities: TrustedIdentityIssuer
}

const normalizeClaims = (claims: PermissionClaim | readonly PermissionClaim[]): readonly PermissionClaim[] =>
    (Array.isArray(claims) ? (claims as readonly PermissionClaim[]) : [claims as PermissionClaim]).map(claim =>
        permissionClaim(claim.permissionId, claim.scope),
    )

const covers = (allowed: PermissionClaim, requested: PermissionClaim): boolean =>
    allowed.permissionId === requested.permissionId &&
    (allowed.scope === "*" ||
        (requested.scope !== "*" &&
            allowed.scope.type === requested.scope.type &&
            allowed.scope.id === requested.scope.id))

const requireClaims = (
    evaluator: AuthorityEvaluator,
    claims: PermissionClaim | readonly PermissionClaim[],
    at?: number,
): void => {
    const requested = normalizeClaims(claims)
    const missing = requested.filter(claim => !evaluator.allows(claim, at))
    if (missing.length > 0) evaluator.require(missing, at)
}

const intersection = (left: AuthorityEvaluator, right: AuthorityEvaluator): AuthorityEvaluator => ({
    allows: (claim, at) => left.allows(claim, at) && right.allows(claim, at),
    require: (claims, at) => {
        requireClaims(left, claims, at)
        requireClaims(right, claims, at)
    },
    matchingGrantIds: (claim, at) =>
        left.allows(claim, at) && right.allows(claim, at)
            ? [...new Set([...left.matchingGrantIds(claim, at), ...right.matchingGrantIds(claim, at)])]
            : [],
})

const limited = (base: AuthorityEvaluator, allowed: readonly PermissionClaim[]): AuthorityEvaluator => ({
    allows: (claim, at) => allowed.some(candidate => covers(candidate, claim)) && base.allows(claim, at),
    require: (claims, at) => {
        const requested = normalizeClaims(claims)
        if (requested.some(claim => !allowed.some(candidate => covers(candidate, claim)))) {
            throw new PermissionError("PERMISSION_DENIED", "authority is outside the branch claim limit")
        }
        base.require(requested, at)
    },
    matchingGrantIds: (claim, at) =>
        allowed.some(candidate => covers(candidate, claim)) ? base.matchingGrantIds(claim, at) : [],
})

const union = (left: AuthorityEvaluator, right: AuthorityEvaluator): AuthorityEvaluator => ({
    allows: (claim, at) => left.allows(claim, at) || right.allows(claim, at),
    require: (claims, at) => {
        const missing = normalizeClaims(claims).filter(claim => !left.allows(claim, at) && !right.allows(claim, at))
        if (missing.length > 0) left.require(missing, at)
    },
    matchingGrantIds: (claim, at) => [
        ...new Set([...left.matchingGrantIds(claim, at), ...right.matchingGrantIds(claim, at)]),
    ],
})

/** Create paired runtime and trusted identity-issuance capabilities. */
export const createPermissionExecution = (options: PermissionExecutionOptions = {}): PermissionExecution => {
    const owner = Symbol("permission-runtime")
    const storage = new AsyncLocalStorage<ExecutionLease>()
    const now = options.now ?? Date.now

    const emit = (event: PermissionAuditEvent): void => options.audit?.(Object.freeze(event))

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

    const run = async <T>(
        authority: ActiveAuthority,
        context: PermissionExecutionContext,
        callback: () => T | Promise<T>,
    ): Promise<T> => {
        requireAuthorityRecord(owner, authority)
        const lease: ExecutionLease = {
            authority,
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
    }

    const runtime: PermissionRuntime = {
        authorityFor,
        currentAuthority: () => currentLease().authority,
        runAs: (identity, context, callback) => run(authorityFor(identity), context, callback),
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

    const changeEvent = (
        operation: "narrow" | "elevate" | "assume",
        authority: ActiveAuthority,
        claims: readonly PermissionClaim[],
        context: PermissionExecutionContext,
    ): void => {
        emit({
            type: "authority-change",
            timestamp: now(),
            operation,
            ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
            principal: authority.principal,
            origin: authority.origin,
            claims,
        })
    }

    const derived = (authority: ActiveAuthority, evaluator: AuthorityEvaluator): ActiveAuthority => {
        const record = requireAuthorityRecord(owner, authority)
        return createActiveAuthority(owner, { ...record, authority: evaluator })
    }

    const core: PermissionCoreRuntime = {
        authorityFor,
        currentAuthority: () => currentLease().authority,
        run,
        intersect: (eventAuthority, ceiling) => {
            const event = requireAuthorityRecord(owner, eventAuthority)
            const ceilingRecord = requireAuthorityRecord(owner, ceiling)
            return createActiveAuthority(owner, {
                ...event,
                authority: intersection(event.authority, ceilingRecord.authority),
            })
        },
        narrow: (authority, requested, context) => {
            const claims = normalizeClaims(requested)
            const record = requireAuthorityRecord(owner, authority)
            const narrowed = derived(authority, limited(record.authority, claims))
            changeEvent("narrow", narrowed, claims, context)
            return narrowed
        },
        elevate: (authority, ceiling, requested, context) => {
            requireAuthorityRecord(owner, authority)
            const ceilingRecord = requireAuthorityRecord(owner, ceiling)
            const claims = normalizeClaims(requested)
            authorize(ceiling, claims, { ...context, operation: "authority.elevate" })
            const current = requireAuthorityRecord(owner, authority)
            const elevated = derived(authority, union(current.authority, limited(ceilingRecord.authority, claims)))
            changeEvent("elevate", elevated, claims, context)
            return elevated
        },
        assume: (identity, ceiling, context) => {
            const assumed = authorityFor(identity)
            const bounded = core.intersect(assumed, ceiling)
            changeEvent("assume", bounded, [], context)
            return bounded
        },
        authorize,
    }

    return Object.freeze({
        runtime: Object.freeze(runtime),
        core: Object.freeze(core),
        identities: createTrustedIdentityIssuer(owner),
    })
}
