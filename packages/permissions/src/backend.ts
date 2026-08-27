import type { PermissionRegistrySnapshot } from "./registry-model"

/** Mutable transaction view. The backend publishes it only when the callback succeeds. */
export interface PermissionRegistryDraft {
    revision: number
    definitions: PermissionRegistrySnapshot["definitions"]
    grants: PermissionRegistrySnapshot["grants"]
    resources: PermissionRegistrySnapshot["resources"]
    owners: PermissionRegistrySnapshot["owners"]
    operations: PermissionRegistrySnapshot["operations"]
}

/** Persistence boundary for permission registry state. */
export interface PermissionRegistryBackend {
    snapshot(): Promise<PermissionRegistrySnapshot>
    transaction<T>(callback: (draft: PermissionRegistryDraft) => T | Promise<T>): Promise<T>
}
