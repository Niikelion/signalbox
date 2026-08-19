import type { AddressInfo } from "node:net"
import { request } from "node:http"
import type { Server } from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { createNotifyServer } from "../src/gena.js"

const LIVE_SID = "uuid:live-subscription"

const body = (ip: string): string =>
    `<?xml version="1.0"?><e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0">` +
    `<e:property><ExternalIPAddress>${ip}</ExternalIPAddress></e:property></e:propertyset>`

/** POST a NOTIFY at the callback server exactly as a router would. */
const notify = (port: number, headers: Record<string, string>, payload: string): Promise<number> =>
    new Promise((resolve, reject) => {
        const req = request({ method: "NOTIFY", hostname: "127.0.0.1", port, path: "/", headers }, res => {
            res.resume()
            res.on("end", () => resolve(res.statusCode ?? 0))
        })
        req.once("error", reject)
        req.end(payload)
    })

describe("createNotifyServer", () => {
    let server: Server | undefined

    afterEach(async () => {
        if (server) await new Promise<void>(resolve => server?.close(() => resolve()))
        server = undefined
    })

    const start = async (): Promise<{ port: number; observed: string[]; warnings: string[] }> => {
        const observed: string[] = []
        const warnings: string[] = []
        server = await createNotifyServer({
            port: 0, // let the OS pick a free port
            isCurrentSid: sid => sid === LIVE_SID,
            onExternalIp: ip => observed.push(ip),
            log: (message, level) => {
                if (level === "warn") warnings.push(message)
            },
        })
        const { port } = server.address() as AddressInfo
        return { port, observed, warnings }
    }

    it("emits a routable address from a matching subscription", async () => {
        const { port, observed } = await start()
        const status = await notify(port, { SID: LIVE_SID, SEQ: "0" }, body("203.0.113.7"))
        expect(status).toBe(200)
        expect(observed).toEqual(["203.0.113.7"])
    })

    it("ignores a NOTIFY whose SID is not our live subscription", async () => {
        const { port, observed, warnings } = await start()
        await notify(port, { SID: "uuid:someone-else", SEQ: "0" }, body("203.0.113.7"))
        expect(observed).toEqual([])
        expect(warnings.some(w => w.includes("unknown SID"))).toBe(true)
    })

    it("ignores a NOTIFY with no SID at all", async () => {
        const { port, observed } = await start()
        await notify(port, { SEQ: "0" }, body("203.0.113.7"))
        expect(observed).toEqual([])
    })

    it("drops a non-routable ExternalIPAddress (the mid-redial placeholder)", async () => {
        const { port, observed, warnings } = await start()
        await notify(port, { SID: LIVE_SID, SEQ: "0" }, body("0.0.0.0"))
        expect(observed).toEqual([])
        expect(warnings.some(w => w.includes("non-routable"))).toBe(true)
    })

    it("drops an out-of-order SEQ so a stale address cannot win", async () => {
        const { port, observed } = await start()
        await notify(port, { SID: LIVE_SID, SEQ: "0" }, body("203.0.113.1")) // initial
        await notify(port, { SID: LIVE_SID, SEQ: "1" }, body("203.0.113.2")) // newer
        await notify(port, { SID: LIVE_SID, SEQ: "1" }, body("203.0.113.9")) // stale redelivery
        await notify(port, { SID: LIVE_SID, SEQ: "2" }, body("203.0.113.3")) // newer again
        expect(observed).toEqual(["203.0.113.1", "203.0.113.2", "203.0.113.3"])
    })

    it("accepts SEQ 0 again as a resubscribe resync", async () => {
        const { port, observed } = await start()
        await notify(port, { SID: LIVE_SID, SEQ: "5" }, body("203.0.113.1"))
        await notify(port, { SID: LIVE_SID, SEQ: "0" }, body("203.0.113.2")) // resubscribe
        expect(observed).toEqual(["203.0.113.1", "203.0.113.2"])
    })
})
