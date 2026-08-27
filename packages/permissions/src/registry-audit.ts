import type { EntityRef } from "./model"
import type { RegistryMutationKind } from "./registry-model"

/** Sanitized record of a committed registry mutation. */
export interface PermissionRegistryAuditEvent {
    readonly type: "permission-registry"
    readonly timestamp: number
    readonly operation: RegistryMutationKind
    readonly operationId?: string
    readonly actor: EntityRef
    readonly targetId: string
}

export type PermissionRegistryAuditSink = (event: PermissionRegistryAuditEvent) => void
