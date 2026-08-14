import { describe, expect, it } from "vitest"
import { defaultGateway } from "../src/discovery.js"

const onLinux = process.platform === "linux"

describe("defaultGateway", () => {
    // A real integration check: on Linux it must parse an address out of the live
    // /proc/net/route. This is the platform the package actually targets.
    it.runIf(onLinux)("reads a dotted-quad gateway from /proc/net/route", () => {
        expect(defaultGateway()).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/)
    })

    it.skipIf(onLinux)("throws where /proc/net/route is absent", () => {
        expect(() => defaultGateway()).toThrow(/proc\/net\/route/)
    })
})
