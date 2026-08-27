import type { PermissionErrorCode } from "./errors"
import type { EntityRef, PermissionClaim } from "./model"

/** Sanitized authorization decision emitted before a protected handler begins. */
export interface AuthorizationAuditEvent {
    readonly type: "authorization"
    readonly timestamp: number
    readonly operation: string
    readonly requestId?: string
    readonly principal: EntityRef
    readonly origin: EntityRef
    readonly requiredClaims: readonly PermissionClaim[]
    readonly contributingGrantIds: readonly string[]
    readonly decision: "allow" | "deny"
    readonly code?: PermissionErrorCode
}

/** Sanitized branch-local authority transformation. */
export interface AuthorityChangeAuditEvent {
    readonly type: "authority-change"
    readonly timestamp: number
    readonly operation: "narrow" | "elevate" | "assume"
    readonly requestId?: string
    readonly principal: EntityRef
    readonly origin: EntityRef
    readonly claims: readonly PermissionClaim[]
}

export type PermissionAuditEvent = AuthorizationAuditEvent | AuthorityChangeAuditEvent

/** Synchronous audit boundary; a thrown sink error prevents the protected action. */
export type PermissionAuditSink = (event: PermissionAuditEvent) => void
