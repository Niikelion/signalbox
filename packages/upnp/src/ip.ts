/**
 * Whether `value` is an address we would actually want to publish to DNS.
 *
 * A router mid-reconnect happily NOTIFYs a placeholder ExternalIPAddress —
 * `0.0.0.0`, an empty string, or (on some firmwares) its LAN-side private
 * address — for the second or two before the WAN link settles. None of those
 * should ever reach the DNS updater, so every address entering the pipeline is
 * filtered here first.
 */
export const isPublicIPv4 = (value: string): boolean => {
    const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value.trim())
    if (!match) return false

    const octets = match.slice(1, 5).map(Number)
    if (octets.some((octet) => octet > 255)) return false

    const [a, b] = octets as [number, number, number, number]
    if (a === 0) return false // "this" network, includes 0.0.0.0
    if (a === 10) return false // RFC 1918 private
    if (a === 127) return false // loopback
    if (a === 169 && b === 254) return false // link-local
    if (a === 172 && b >= 16 && b <= 31) return false // RFC 1918 private
    if (a === 192 && b === 168) return false // RFC 1918 private
    if (a === 100 && b >= 64 && b <= 127) return false // CGNAT (RFC 6598)
    if (a >= 224) return false // multicast and reserved

    return true
}
