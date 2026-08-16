import { createRequire } from "node:module"
import { FlowKitError } from "@signalbox/core"

// node:sqlite is a recent builtin that some bundlers/test runners don't yet resolve
// via a static import, so load it through require (which they leave alone).
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite")

export interface Collection<T extends { id: string }> {
    all: () => T[]
    get: (id: string) => T | undefined
    insert: (item: T) => void
    upsert: (item: T) => void
    update: (id: string, patch: Partial<Omit<T, "id">>) => void
    delete: (id: string) => void
}

export interface Store {
    collection: <T extends { id: string }>(name: string) => Collection<T>
    close: () => void
}

const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export const createStore = (path: string): Store => {
    const db = new DatabaseSync(path)
    db.exec("PRAGMA journal_mode = WAL")

    const collections = new Map<string, unknown>()

    const build = <T extends { id: string }>(name: string): Collection<T> => {
        if (!VALID_NAME.test(name)) {
            throw new FlowKitError(`invalid collection name "${name}"`, "use letters, digits, and underscores")
        }
        db.exec(`CREATE TABLE IF NOT EXISTS "${name}" (id TEXT PRIMARY KEY, data TEXT NOT NULL)`)

        const insertStmt = db.prepare(`INSERT INTO "${name}" (id, data) VALUES (?, ?)`)
        const upsertStmt = db.prepare(
            `INSERT INTO "${name}" (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
        )
        const getStmt = db.prepare(`SELECT data FROM "${name}" WHERE id = ?`)
        const allStmt = db.prepare(`SELECT data FROM "${name}"`)
        const deleteStmt = db.prepare(`DELETE FROM "${name}" WHERE id = ?`)

        const parse = (row: unknown): T => JSON.parse((row as { data: string }).data) as T

        const get = (id: string): T | undefined => {
            const row = getStmt.get(id)
            return row === undefined ? undefined : parse(row)
        }

        return {
            all: () => allStmt.all().map(parse),
            get,
            insert: (item) => {
                insertStmt.run(item.id, JSON.stringify(item))
            },
            upsert: (item) => {
                upsertStmt.run(item.id, JSON.stringify(item))
            },
            update: (id, patch) => {
                const existing = get(id)
                if (!existing) throw new FlowKitError(`no item "${id}" in "${name}"`)
                upsertStmt.run(id, JSON.stringify({ ...existing, ...patch, id }))
            },
            delete: (id) => {
                deleteStmt.run(id)
            },
        }
    }

    return {
        collection: <T extends { id: string }>(name: string): Collection<T> => {
            const cached = collections.get(name)
            if (cached) return cached as Collection<T>
            const created = build<T>(name)
            collections.set(name, created)
            return created
        },
        close: () => {
            db.close()
        },
    }
}
