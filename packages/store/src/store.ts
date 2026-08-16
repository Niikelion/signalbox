import { createRequire } from "node:module"
import { FlowKitError } from "@signalbox/core"

// node:sqlite is a recent builtin that some bundlers/test runners don't yet resolve
// via a static import, so load it through require (which they leave alone).
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite")

/**
 * A typed collection of JSON documents keyed by `id`, backed by one SQLite table.
 * @typeParam T the document shape; must carry a string `id`
 */
export interface Collection<T extends { id: string }> {
    /** Every document in the collection. */
    all: () => T[]
    /**
     * The document with `id`, or `undefined` if absent.
     * @param id the document id
     */
    get: (id: string) => T | undefined
    /**
     * Insert a new document; throws if `item.id` already exists.
     * @param item the document to store
     */
    insert: (item: T) => void
    /**
     * Insert `item`, or replace the existing document with the same id.
     * @param item the document to store
     */
    upsert: (item: T) => void
    /**
     * Merge `patch` into the existing document; throws if `id` is absent.
     * @param id the document id
     * @param patch fields to overwrite (the `id` itself cannot change)
     */
    update: (id: string, patch: Partial<Omit<T, "id">>) => void
    /**
     * Remove the document `id` (a no-op if absent).
     * @param id the document id
     */
    delete: (id: string) => void
}

/** A persistent document store backed by a SQLite database file. */
export interface Store {
    /**
     * Get, creating on first use, a typed collection by name.
     * @typeParam T the document shape stored in the collection
     * @param name the collection name; letters, digits, and underscores only
     */
    collection: <T extends { id: string }>(name: string) => Collection<T>
    /** Close the underlying database. */
    close: () => void
}

const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Open (or create) a document store at `path`.
 * @param path SQLite file path, or `":memory:"` for an ephemeral store
 */
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
