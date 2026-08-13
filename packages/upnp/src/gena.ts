import { createServer, request, type Server } from "node:http"

export interface Subscription {
    sid: string
    timeoutSeconds: number
}

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
                // node types every header as string | string[]
                const first = (value: string | string[] | undefined): string =>
                    Array.isArray(value) ? (value[0] ?? "") : (value ?? "")

                const seconds = /Second-(\d+)/i.exec(first(response.headers["timeout"]))?.[1]
                resolve({
                    sid: first(response.headers["sid"]),
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
 * Listen for the router's NOTIFY callbacks. `onExternalIp` fires whenever a
 * notification carries an ExternalIPAddress value.
 */
export const createNotifyServer = (port: number, onExternalIp: (ip: string) => void): Promise<Server> => {
    const server = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on("data", (chunk: Buffer) => chunks.push(chunk))
        req.on("end", () => {
            res.writeHead(200, { "Content-Length": "0" })
            res.end()

            const body = Buffer.concat(chunks).toString("utf8")
            const ip = /<ExternalIPAddress>([\s\S]*?)<\/ExternalIPAddress>/i.exec(body)?.[1]?.trim()
            if (ip) onExternalIp(ip)
        })
    })

    return new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(port, "0.0.0.0", () => {
            resolve(server)
        })
    })
}
