import { PermissionError } from "./errors"

/** Stable reference to a principal, group, resource, or other permission scope. */
export interface EntityRef {
    readonly type: string
    readonly id: string
}

/** Scope matched by a permission claim. */
export type PermissionScope = EntityRef | "*"

/** One permission action applied to an exact entity or every entity. */
export interface PermissionClaim {
    readonly permissionId: string
    readonly scope: PermissionScope
}

const PERMISSION_ID = /^[A-Za-z][A-Za-z0-9]*(?:[._:-][A-Za-z0-9]+)+$/u

const requireIdentifier = (kind: "type" | "id", value: string): void => {
    let hasControlCharacter = false
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index)
        if (code <= 0x1f || code === 0x7f) {
            hasControlCharacter = true
            break
        }
    }
    if (value.length !== 0 && !hasControlCharacter) return

    throw new PermissionError(
        "INVALID_ENTITY_REF",
        `entity ${kind} must be non-empty and contain no control characters`,
    )
}

/** Create and validate an immutable entity reference. */
export const entityRef = (type: string, id: string): EntityRef => {
    requireIdentifier("type", type)
    requireIdentifier("id", id)
    return Object.freeze({ type, id })
}

/** Produce an unambiguous structural key for an entity reference. */
export const entityKey = (entity: EntityRef): string => JSON.stringify([entity.type, entity.id])

/** Validate a globally namespaced permission identifier. */
export const validatePermissionId = (permissionId: string): string => {
    if (!PERMISSION_ID.test(permissionId)) {
        throw new PermissionError(
            "INVALID_PERMISSION_ID",
            `permission ID "${permissionId}" must be a namespaced identifier`,
        )
    }
    return permissionId
}

/** Create an immutable scoped permission claim. */
export const permissionClaim = (permissionId: string, scope: PermissionScope): PermissionClaim =>
    Object.freeze({
        permissionId: validatePermissionId(permissionId),
        scope: scope === "*" ? scope : entityRef(scope.type, scope.id),
    })
