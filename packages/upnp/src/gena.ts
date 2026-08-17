import { createServer, request, type Server } from "node:http"
import { isPublicIPv4 } from "./ip.js"

/** A GENA event subscription. */
export interface Subscription {
    /** The subscription id (SID header). */
    sid: string
    /** How long the subscription lasts, in seconds. */
    timeoutSeconds: number
}

/** Severity for the NOTIFY server's log callback. */
export type NotifyLevel = "info" | "warn" | "error"

/** Options for {@link createNotifyServer}. */
export interface NotifyServerOptions {
    /** Port the NOTIFY callback server listens on. */
    port: number
    /** Whether a NOTIFY's SID matches the live subscription (spoof/stale guard). */
    isCurrentSid: (sid: string | undefined) => boolean
    /** Called with each new routable external IPv4. */
    onExternalIp: (ip: string) => void
    /** Optional log sink. */
    log?: (message: string, level?: NotifyLevel) => void
}

const header = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value)

/**
 * Send a GENA SUBSCRIBE/UNSUBSCRIBE request.
 * @param url the event-subscription URL
 * @param headers request headers (CALLBACK/NT/TIMEOUT or SID)
 * @param method SUBSCRIBE (default) or UNSUBSCRIBE
 * @returns the resulting subscription (SID and timeout)
 */
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
                response.resume()
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
 * Start the HTTP server that receives GENA NOTIFY callbacks, validating SID and SEQ
 * and surfacing routable external-IP changes.
 * @param options port, SID guard, IP callback, and optional logger
 * @returns the listening server
 */
export const createNotifyServer = (options: NotifyServerOptions): Promise<Server> => {
    const log = options.log ?? ((): void => undefined)
    const lastSeq = new Map<string, number>()

    const server = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on("data", (chunk: Buffer) => chunks.push(chunk))
        req.on("end", () => {
            res.writeHead(200, { "Content-Length": "0" })
            res.end()

            const sid = header(req.headers["sid"])
            if (!sid || !options.isCurrentSid(sid)) {
                log(`ignoring NOTIFY with unknown SID ${sid ?? "(none)"}`, "warn")
                return
            }

            const seq = Number(header(req.headers["seq"]) ?? "0")
            const previous = lastSeq.get(sid)
            if (seq !== 0 && previous !== undefined && seq <= previous) {
                log(`ignoring out-of-order NOTIFY (seq ${String(seq)} <= ${String(previous)})`)
                return
            }
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
