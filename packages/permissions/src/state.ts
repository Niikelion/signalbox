import type { EntityRef } from "./model"
import { PermissionError } from "./errors"

export interface GrantStateOptions {
    readonly id: string
    readonly expiresAt?: number
    readonly parent?: GrantStateCell
}

/** Mutable validity cell shared by every compiled reference to one grant. */
export class GrantStateCell {
    readonly id: string
    readonly expiresAt?: number
    readonly parent?: GrantStateCell
    readonly #children = new Set<GrantStateCell>()
    #version = 0
    #revokedAt?: number

    constructor(options: GrantStateOptions) {
        if (options.id.length === 0) throw new PermissionError("INVALID_GRANT_STATE", "grant ID must be non-empty")
        if (options.expiresAt !== undefined && !Number.isFinite(options.expiresAt)) {
            throw new PermissionError("INVALID_GRANT_STATE", "grant expiration must be a finite timestamp")
        }
        this.id = options.id
        this.parent = options.parent
        const parentExpiry = options.parent?.expiresAt
        this.expiresAt =
            parentExpiry === undefined
                ? options.expiresAt
                : options.expiresAt === undefined
                  ? parentExpiry
                  : Math.min(parentExpiry, options.expiresAt)
        if (options.parent) options.parent.#children.add(this)
        if (options.parent?.revokedAt !== undefined) this.#revokedAt = options.parent.revokedAt
    }

    /** Monotonic version changed by validity mutations. */
    get version(): number {
        return this.#version
    }

    /** Revocation timestamp, including revocation inherited from a parent. */
    get revokedAt(): number | undefined {
        return this.#revokedAt
    }

    /** Whether this grant can contribute authority at the supplied time. */
    isValid(at = Date.now()): boolean {
        return this.#revokedAt === undefined && (this.expiresAt === undefined || at < this.expiresAt)
    }

    /** Revoke this grant and every descendant synchronously. */
    revoke(at = Date.now()): void {
        const pending: GrantStateCell[] = [this]
        while (pending.length > 0) {
            const current = pending.pop()
            if (!current || current.#revokedAt !== undefined) continue
            current.#revokedAt = at
            current.#version += 1
            pending.push(...current.#children)
        }
    }
}

export interface MembershipStateOptions {
    readonly principal: EntityRef
    readonly group: EntityRef
    readonly active?: boolean
}

/** Versioned membership dependency attached to group-derived authority. */
export class MembershipStateCell {
    readonly principal: EntityRef
    readonly group: EntityRef
    #active: boolean
    #version = 0

    constructor(options: MembershipStateOptions) {
        this.principal = options.principal
        this.group = options.group
        this.#active = options.active ?? true
    }

    get active(): boolean {
        return this.#active
    }

    get version(): number {
        return this.#version
    }

    /** Change membership validity without rebuilding compiled authorities. */
    setActive(active: boolean): void {
        if (this.#active === active) return
        this.#active = active
        this.#version += 1
    }
}
