const ENDPOINT = "https://www.ovh.com/nic/update"

// dyndns2 servers reject a request with no User-Agent as `badagent`.
const USER_AGENT = "flowkit-ddns/0.1"

export interface OvhDynHostCredentials {
    /** The DynHost username created in the OVH panel (looks like `zone.tld-suffix`). */
    username: string
    password: string
}

export interface DynHostUpdate {
    /** True when OVH accepted a new address (`good`), false when it was already set (`nochg`). */
    changed: boolean
    ip: string
}

/**
 * Point one OVH DynHost record at an address via the dyndns2 protocol.
 *
 * Unlike a full DNS API, DynHost cannot create a record or read its current
 * value: the record must already exist in the OVH panel, and the server itself
 * reports whether the address moved (`good`) or was already current (`nochg`).
 * Every other response is an error we surface rather than silently ignore.
 */
export const updateDynHost = async (
    credentials: OvhDynHostCredentials,
    hostname: string,
    ip: string,
): Promise<DynHostUpdate> => {
    const url = `${ENDPOINT}?system=dyndns&hostname=${encodeURIComponent(hostname)}&myip=${encodeURIComponent(ip)}`
    const auth = Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")

    const response = await fetch(url, {
        headers: { Authorization: `Basic ${auth}`, "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(30_000),
    })

    const body = (await response.text()).trim()
    if (!response.ok) {
        throw new Error(`OVH DynHost ${hostname} -> HTTP ${String(response.status)}: ${body}`)
    }

    // responses look like `good 1.2.3.4` / `nochg 1.2.3.4` / `badauth`
    const code = body.split(/\s+/)[0]?.toLowerCase() ?? ""
    switch (code) {
        case "good":
            return { changed: true, ip }
        case "nochg":
            return { changed: false, ip }
        case "nohost":
            throw new Error(`OVH DynHost: ${hostname} has no DynHost record configured (nohost)`)
        case "badauth":
            throw new Error("OVH DynHost: authentication failed (badauth) - check the DynHost username and password")
        case "notfqdn":
            throw new Error(`OVH DynHost: ${hostname} is not a fully-qualified hostname (notfqdn)`)
        case "abuse":
            throw new Error(`OVH DynHost: ${hostname} is temporarily blocked for abuse`)
        case "badagent":
            throw new Error("OVH DynHost: request rejected (badagent)")
        case "911":
            throw new Error("OVH DynHost: server-side error (911), retry later")
        default:
            throw new Error(`OVH DynHost: unexpected response for ${hostname}: ${body}`)
    }
}
