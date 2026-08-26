import { describe, expect, it } from "vitest"
import { isPublicIPv4 } from "../src/ip"

describe("isPublicIPv4", () => {
    it.each([
        "8.8.8.8",
        "1.1.1.1",
        "99.101.203.4",
        "172.15.0.1", // just below the private block
        "172.32.0.1", // just above the private block
        "223.255.255.255", // last address before multicast
        "  8.8.8.8  ", // surrounding whitespace is tolerated
    ])("accepts routable address %s", ip => {
        expect(isPublicIPv4(ip)).toBe(true)
    })

    it.each([
        ["", "empty"],
        ["0.0.0.0", "the unspecified placeholder a router advertises mid-redial"],
        ["10.0.0.1", "RFC1918 10/8"],
        ["172.16.0.1", "RFC1918 172.16/12 lower bound"],
        ["172.31.255.255", "RFC1918 172.16/12 upper bound"],
        ["192.168.1.1", "RFC1918 192.168/16"],
        ["127.0.0.1", "loopback"],
        ["169.254.10.10", "link-local"],
        ["100.64.0.1", "CGNAT lower bound"],
        ["100.127.255.255", "CGNAT upper bound"],
        ["224.0.0.1", "multicast"],
        ["255.255.255.255", "broadcast / reserved"],
        ["1.2.3", "too few octets"],
        ["1.2.3.4.5", "too many octets"],
        ["256.1.1.1", "octet out of range"],
        ["1.2.3.256", "octet out of range"],
        ["abc", "not numeric"],
        ["1.2.3.-1", "negative octet"],
    ])("rejects %s (%s)", ip => {
        expect(isPublicIPv4(ip)).toBe(false)
    })
})
