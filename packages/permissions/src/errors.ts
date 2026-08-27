/** Stable failures produced by the permission authority kernel. */
export type PermissionErrorCode =
    | "INVALID_ENTITY_REF"
    | "INVALID_PERMISSION_ID"
    | "INVALID_GRANT_STATE"
    | "PERMISSION_ALREADY_DEFINED"
    | "PERMISSION_UNDEFINED"
    | "PERMISSION_RETIRED"
    | "DELEGATION_DENIED"
    | "IDEMPOTENCY_CONFLICT"
    | "BACKEND_INCONSISTENT"
    | "AUTHORITY_MISSING"
    | "GRANT_INVALID"
    | "GRANT_REVOKED"
    | "GRANT_EXPIRED"
    | "PERMISSION_DENIED"
    | "RESOURCE_ALREADY_REGISTERED"
    | "RESOURCE_NOT_FOUND"
    | "RESOURCE_BLOCKED"
    | "OWNERSHIP_TRANSFER_DENIED"

/** Error with a machine-readable permission failure code. */
export class PermissionError extends Error {
    readonly code: PermissionErrorCode

    constructor(code: PermissionErrorCode, message: string) {
        super(message)
        this.name = "PermissionError"
        this.code = code
    }
}
