const ENDPOINT = "https://www.ovh.com/nic/update"

const USER_AGENT = "signalbox-ddns/0.1"

/** OVH DynHost credentials. */
export interface OvhDynHostCredentials {
    /** DynHost username created in the OVH panel. */
    username: string
    /** Password for that DynHost username. */
    password: string
}

/** The result of a DynHost update. */
export interface DynHostUpdate {
    /** Whether the record's address changed (`good` vs `nochg`). */
    changed: boolean
    /** The address that was set. */
    ip: string
}

/**
 * Point a DynHost record at an address over the dyndns2 protocol.
 * @param credentials DynHost username and password
 * @param hostname the DynHost hostname to update
 * @param ip the target IPv4 address
 * @returns whether the address changed
 * @throws with a descriptive message on any dyndns2 error response
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
