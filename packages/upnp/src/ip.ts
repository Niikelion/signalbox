/**
 * Whether `value` is a routable public IPv4 address (rejects empty, `0.0.0.0`,
 * private, CGNAT, loopback, link-local, and multicast/reserved ranges).
 * @param value the string to test
 */
export const isPublicIPv4 = (value: string): boolean => {
    const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value.trim())
    if (!match) return false

    const octets = match.slice(1, 5).map(Number)
    if (octets.some(octet => octet > 255)) return false

    const [a, b] = octets as [number, number, number, number]
    if (a === 0) return false
    if (a === 10) return false
    if (a === 127) return false
    if (a === 169 && b === 254) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 100 && b >= 64 && b <= 127) return false
    if (a >= 224) return false

    return true
}
