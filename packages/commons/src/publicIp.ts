const SOURCES: readonly { url: string; parse: (body: string) => string }[] = [
    { url: "https://cloudflare.com/cdn-cgi/trace", parse: (body) => /^ip=(.+)$/m.exec(body)?.[1]?.trim() ?? "" },
    { url: "https://api.ipify.org", parse: (body) => body.trim() },
    { url: "https://ifconfig.me/ip", parse: (body) => body.trim() },
]

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/

export const isIPv4 = (value: string): boolean => IPV4.test(value)

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
