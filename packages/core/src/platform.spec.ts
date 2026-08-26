import { describe, expect, it } from "vitest"
import { isRoot } from "@/index"

describe("isRoot", () => {
    it("should return a boolean", () => {
        expect(typeof isRoot()).toBe("boolean")
    })
})
