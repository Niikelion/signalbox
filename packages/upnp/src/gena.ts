import { createServer, request, type Server } from "node:http"
import { isPublicIPv4 } from "./ip.js"

export interface Subscription {
    sid: string
    timeoutSeconds: number
}

export type NotifyLevel = "info" | "warn" | "error"

export interface NotifyServerOptions {
    port: number
    isCurrentSid: (sid: string | undefined) => boolean
    onExternalIp: (ip: string) => void
    log?: (message: string, level?: NotifyLevel) => void
}

const header = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value)

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
