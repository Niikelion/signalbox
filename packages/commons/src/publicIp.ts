const SOURCES: readonly { url: string; parse: (body: string) => string }[] = [
    { url: "https://cloudflare.com/cdn-cgi/trace", parse: body => /^ip=(.+)$/m.exec(body)?.[1]?.trim() ?? "" },
    { url: "https://api.ipify.org", parse: body => body.trim() },
    { url: "https://ifconfig.me/ip", parse: body => body.trim() },
]

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/

/**
 * Whether `value` is a valid IPv4 address.
 * @param value the string to test
 */
export const isIPv4 = (value: string): boolean => IPV4.test(value)

/**
 * Resolve the host's public IPv4 over HTTP, racing several sources in order.
 * @param onSourceFailure called with a message when a source fails, before trying the next
 * @returns the public IPv4
 * @throws if no source yields a valid address
 */
export const publicIPv4 = async (onSourceFailure?: (message: string) => void): Promise<string> => {
    for (const { url, parse } of SOURCES) {
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
            if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)

            const ip = parse(await response.text())
            if (isIPv4(ip)) return ip
            throw new Error("unparseable response")
        } catch (error) {
            onSourceFailure?.(`IP lookup failed via ${url}: ${(error as Error).message}`)
        }
    }
    throw new Error("could not determine public IPv4 from any source")
}
