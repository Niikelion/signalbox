import type { PermissionRegistryBackend, PermissionRegistryDraft } from "./backend"
import { cloneSnapshot, emptyPermissionRegistrySnapshot, type PermissionRegistrySnapshot } from "./registry-model"

/** Transactional in-memory backend, useful for tests and ephemeral runtimes. */
export const createMemoryPermissionBackend = (
    initial: PermissionRegistrySnapshot = emptyPermissionRegistrySnapshot(),
): PermissionRegistryBackend => {
    let current = cloneSnapshot(initial)
    let pending: Promise<void> = Promise.resolve()

    const transaction = <T>(callback: (draft: PermissionRegistryDraft) => T | Promise<T>): Promise<T> => {
        return new Promise<T>((resolve, reject) => {
            pending = pending.then(async () => {
                try {
                    const base = cloneSnapshot(current)
                    const draft: PermissionRegistryDraft = {
                        revision: base.revision,
                        definitions: [...base.definitions],
                        grants: [...base.grants],
                        resources: [...base.resources],
                        owners: [...base.owners],
                        operations: [...base.operations],
                    }
                    const value = await callback(draft)
                    current = cloneSnapshot({ ...draft, revision: base.revision + 1 })
                    resolve(value)
                } catch (error) {
                    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
                    reject(error)
                }
            })
        })
    }

    return Object.freeze({
        snapshot: async () => cloneSnapshot(current),
        transaction,
    })
}
