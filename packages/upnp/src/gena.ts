import { createServer, request, type Server } from "node:http"
import { isPublicIPv4 } from "./ip.js"

export interface Subscription {
    sid: string
    timeoutSeconds: number
}

export type NotifyLevel = "info" | "warn" | "error"

export interface NotifyServerOptions {
    /** TCP port the callback listens on. */
    port: number
    /**
     * Accept a NOTIFY only when its SID header matches our live subscription.
     * The server binds 0.0.0.0, so without this any host on the LAN could POST a
     * forged ExternalIPAddress and drive a DNS update.
     */
    isCurrentSid: (sid: string | undefined) => boolean
    /** Fired with a validated, routable ExternalIPAddress. */
    onExternalIp: (ip: string) => void
    log?: (message: string, level?: NotifyLevel) => void
}

const header = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value)

/** Send a GENA SUBSCRIBE / UNSUBSCRIBE and read back the SID and timeout. */
export const gena = (
    url: string,
    headers: Record<string, string>,
    method: "SUBSCRIBE" | "UNSUBSCRIBE" = "SUBSCRIBE",
): Promise<Subscription> => {
    const target = new URL(url)

    return new Promise((resolve, reject) => {
        const req = request(
            {
                method,
                hostname: target.hostname,
                port: target.port || 80,
                path: `${target.pathname}${target.search}`,
                headers,
                timeout: 10_000,
            },
            (response) => {
                response.resume() // drain
                if ((response.statusCode ?? 500) >= 300) {
                    reject(new Error(`${method} ${url} -> HTTP ${String(response.statusCode)}`))
                    return
                }
                const seconds = /Second-(\d+)/i.exec(header(response.headers["timeout"]) ?? "")?.[1]
                resolve({
                    sid: header(response.headers["sid"]) ?? "",
                    timeoutSeconds: seconds ? Number(seconds) : 1800,
                })
            },
        )

        req.once("timeout", () => {
            req.destroy(new Error(`${method} ${url} timed out`))
        })
        req.once("error", reject)
        req.end()
    })
}

/**
 * Listen for the router's GENA NOTIFY callbacks. `onExternalIp` fires only for a
 * notification that is (a) from our live subscription, (b) not superseded by a
 * later one we already handled, and (c) carrying a routable public address.
 */
export const createNotifyServer = (options: NotifyServerOptions): Promise<Server> => {
    const log = options.log ?? ((): void => undefined)
    // GENA numbers events per subscription; a NOTIFY can arrive out of order or
    // be redelivered. Track the high-water SEQ per SID and ignore anything at or
    // below it, so a stale re-dial address cannot overwrite the current one.
    const lastSeq = new Map<string, number>()

    const server = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on("data", (chunk: Buffer) => chunks.push(chunk))
        req.on("end", () => {
            res.writeHead(200, { "Content-Length": "0" })
            res.end()

            const sid = header(req.headers["sid"])
            // a GENA NOTIFY always carries a SID; without a live match it is either
            // stale or forged, so drop it rather than act on it
            if (!sid || !options.isCurrentSid(sid)) {
                log(`ignoring NOTIFY with unknown SID ${sid ?? "(none)"}`, "warn")
                return
            }

            // SEQ 0 is the router's initial full-state push after a (re)subscribe;
            // it resets the sequence, so always accept it.
            const seq = Number(header(req.headers["seq"]) ?? "0")
            const previous = lastSeq.get(sid)
            if (seq !== 0 && previous !== undefined && seq <= previous) {
                log(`ignoring out-of-order NOTIFY (seq ${String(seq)} <= ${String(previous)})`)
                return
            }
            // every resubscribe mints a fresh SID; only the current one is ever
            // read again, so drop stale keys rather than let the map grow forever
            if (!lastSeq.has(sid)) lastSeq.clear()
            lastSeq.set(sid, seq)

            const body = Buffer.concat(chunks).toString("utf8")
            const ip = /<ExternalIPAddress>([\s\S]*?)<\/ExternalIPAddress>/i.exec(body)?.[1]?.trim()
            if (!ip) return
            if (!isPublicIPv4(ip)) {
                log(`ignoring non-routable ExternalIPAddress ${ip}`, "warn")
                return
            }
            options.onExternalIp(ip)
        })
    })

    return new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(options.port, "0.0.0.0", () => {
            resolve(server)
        })
    })
}
