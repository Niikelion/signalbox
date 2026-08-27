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

/** Synchronous audit boundary; a thrown sink error prevents the protected action. */
export type PermissionAuditSink = (event: AuthorizationAuditEvent) => void
