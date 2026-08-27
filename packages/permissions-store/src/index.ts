import {
    cloneSnapshot,
    emptyPermissionRegistrySnapshot,
    type PermissionRegistryBackend,
    type PermissionRegistryDraft,
    type PermissionRegistrySnapshot,
} from "@signalbox/permissions"
import type { Store } from "@signalbox/store"

interface SnapshotDocument extends PermissionRegistrySnapshot {
    readonly id: string
}

export interface StorePermissionBackendOptions {
    readonly collectionName?: string
    readonly documentId?: string
}

/** Persist the registry as one atomic store document. */
export const createStorePermissionBackend = (
    store: Store,
    options: StorePermissionBackendOptions = {},
): PermissionRegistryBackend => {
    const collection = store.collection<SnapshotDocument>(options.collectionName ?? "permission_registry")
    const documentId = options.documentId ?? "state"
    let pending: Promise<void> = Promise.resolve()

    const read = (): PermissionRegistrySnapshot => {
        const document = collection.get(documentId)
        if (!document) return emptyPermissionRegistrySnapshot()
        return cloneSnapshot(document)
    }

    const transaction = <T>(callback: (draft: PermissionRegistryDraft) => T | Promise<T>): Promise<T> => {
        return new Promise<T>((resolve, reject) => {
            pending = pending.then(async () => {
                try {
                    const base = read()
                    const draft: PermissionRegistryDraft = {
                        revision: base.revision,
                        definitions: [...base.definitions],
                        grants: [...base.grants],
                        resources: [...base.resources],
                        owners: [...base.owners],
                        operations: [...base.operations],
                    }
                    const value = await callback(draft)
                    const snapshot = cloneSnapshot({ ...draft, revision: base.revision + 1 })
                    collection.upsert({ id: documentId, ...snapshot })
                    resolve(value)
                } catch (error) {
                    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
                    reject(error)
                }
            })
        })
    }

    return Object.freeze({ snapshot: async () => read(), transaction })
}
