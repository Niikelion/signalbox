import { createSocket } from "node:dgram"
import { readFileSync } from "node:fs"

const SSDP_ADDRESS = "239.255.255.250"
const SSDP_PORT = 1900

export interface GatewayService {
    eventUrl: string
    serviceType: string
    host: string
}

export const defaultGateway = (): string => {
    let table: string
    try {
        table = readFileSync("/proc/net/route", "utf8")
    } catch {
        throw new Error("cannot read /proc/net/route (UPnP discovery is Linux-only)")
    }

    for (const line of table.split("\n").slice(1)) {
        const [, destination, gateway, flagsHex] = line.trim().split(/\s+/)
        if (!destination || !gateway || !flagsHex) continue
        if (destination !== "00000000" || (parseInt(flagsHex, 16) & 0x2) === 0) continue

        const value = parseInt(gateway, 16)
        return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff].join(".")
    }
    throw new Error("no default gateway found")
}

export const sourceIpToward = (host: string): Promise<string> =>
    new Promise((resolve, reject) => {
        const socket = createSocket("udp4")
        socket.once("error", (error) => {
            socket.close()
            reject(error)
        })
        socket.connect(SSDP_PORT, host, () => {
            const { address } = socket.address()
            socket.close()
            resolve(address)
        })
    })

const tagValue = (xml: string, tag: string): string | undefined =>
    new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i").exec(xml)?.[1]?.trim()

const ssdpSearch = (gateway: string, sourceIp: string, waitMs: number): Promise<string[]> =>
    new Promise((resolve, reject) => {
        const socket = createSocket({ type: "udp4", reuseAddr: true })
        const locations: string[] = []

        const finish = (): void => {
            clearTimeout(timer)
            try {
                socket.close()
            } catch {}
            resolve(locations)
        }
        const timer = setTimeout(finish, waitMs)

        socket.once("error", (error) => {
            clearTimeout(timer)
            socket.close()
            reject(error)
        })

        socket.on("message", (buffer) => {
            const location = /^location:\s*(.+)$/im.exec(buffer.toString("utf8"))?.[1]?.trim()
            if (!location || locations.includes(location)) return
            try {
                if (new URL(location).hostname === gateway) locations.push(location)
            } catch {}
        })

        socket.bind(0, sourceIp, () => {
            const search = [
                "M-SEARCH * HTTP/1.1",
                `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
                'MAN: "ssdp:discover"',
                "MX: 3",
                "ST: ssdp:all",
                "",
                "",
            ].join("\r\n")
            socket.send(search, SSDP_PORT, SSDP_ADDRESS)
        })
    })

export const discoverGateway = async (): Promise<GatewayService> => {
    const gateway = defaultGateway()
    const sourceIp = await sourceIpToward(gateway)
    const locations = await ssdpSearch(gateway, sourceIp, 5_000)

    for (const location of locations) {
        let xml: string
        try {
            const response = await fetch(location, { signal: AbortSignal.timeout(10_000) })
            if (!response.ok) continue
            xml = await response.text()
        } catch {
            continue
        }

        for (const [, block] of xml.matchAll(/<service>([\s\S]*?)<\/service>/gi)) {
            if (!block) continue
            const serviceType = tagValue(block, "serviceType")
            const eventSubURL = tagValue(block, "eventSubURL")
            if (!serviceType || !eventSubURL) continue
            if (!/WAN(PPP|IP)Connection/i.test(serviceType)) continue

            return { eventUrl: new URL(eventSubURL, location).toString(), serviceType, host: gateway }
        }
    }
    throw new Error("no UPnP gateway with a WAN connection service found on the LAN")
}
