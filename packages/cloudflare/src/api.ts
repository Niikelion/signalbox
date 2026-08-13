const API = "https://api.cloudflare.com/client/v4"

interface CfEnvelope<TResult> {
    success: boolean
    errors: { code: number; message: string }[]
    result: TResult
}

export interface DnsRecord {
    id: string
    name: string
    type: string
    content: string
    ttl: number
    proxied: boolean
}

export interface CloudflareCredentials {
    apiToken: string
    zoneId: string
}

const call = async <TResult>(
    credentials: CloudflareCredentials,
    method: string,
    path: string,
    body?: unknown,
): Promise<TResult> => {
    const response = await fetch(`${API}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${credentials.apiToken}`,
            "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
    })

    const text = await response.text()
    if (!response.ok) {
        throw new Error(`Cloudflare ${method} ${path} -> HTTP ${String(response.status)}: ${text}`)
    }

    const payload = JSON.parse(text) as CfEnvelope<TResult>
    if (!payload.success) {
        const detail = payload.errors.map((error) => `${String(error.code)} ${error.message}`).join("; ") || text
        throw new Error(`Cloudflare ${method} ${path} failed: ${detail}`)
    }
    return payload.result
}

/** Confirm the token can see the zone. Used by `setup` to fail early. */
export const verifyZone = async (credentials: CloudflareCredentials): Promise<{ name: string }> =>
    call<{ name: string }>(credentials, "GET", `/zones/${credentials.zoneId}`)

export const findARecord = async (credentials: CloudflareCredentials, name: string): Promise<DnsRecord | undefined> => {
    const records = await call<DnsRecord[]>(
        credentials,
        "GET",
        `/zones/${credentials.zoneId}/dns_records?type=A&name=${encodeURIComponent(name)}`,
    )
    return records[0]
}

export const createARecord = async (
    credentials: CloudflareCredentials,
    record: { name: string; content: string; ttl: number; proxied: boolean },
): Promise<DnsRecord> =>
    call<DnsRecord>(credentials, "POST", `/zones/${credentials.zoneId}/dns_records`, { type: "A", ...record })

export const patchARecord = async (
    credentials: CloudflareCredentials,
    id: string,
    record: { name: string; content: string; ttl: number; proxied: boolean },
): Promise<DnsRecord> =>
    call<DnsRecord>(credentials, "PATCH", `/zones/${credentials.zoneId}/dns_records/${id}`, { type: "A", ...record })
