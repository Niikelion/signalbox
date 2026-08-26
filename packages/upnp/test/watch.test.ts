import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest"

// Replace the two network modules so we can drive the router's behaviour from the
// test: discovery, the SUBSCRIBE/renew round-trips, and the callback server.
vi.mock("../src/discovery", () => ({
    discoverGateway: vi.fn(),
    sourceIpToward: vi.fn(),
}))
vi.mock("../src/gena", () => ({
    gena: vi.fn(),
    createNotifyServer: vi.fn(),
}))

import { discoverGateway, sourceIpToward } from "../src/discovery"
import { gena } from "../src/gena"
import { createUpnpWatcher, type UpnpWatcherHooks } from "../src/watch"

const GATEWAY = {
    eventUrl: "http://192.168.0.1:5000/evt",
    serviceType: "urn:schemas-upnp-org:service:WANIPConnection:1",
    host: "192.168.0.1",
}

const discover = discoverGateway as Mock
const source = sourceIpToward as Mock
const subscribe = gena as Mock

/** A NOTIFY renew reuses SID; a fresh SUBSCRIBE carries CALLBACK; distinguish them. */
const isRenew = (headers: Record<string, string>): boolean => "SID" in headers && !("CALLBACK" in headers)

const makeHooks = (): UpnpWatcherHooks & { [K in keyof UpnpWatcherHooks]: Mock } => ({
    onObserved: vi.fn(),
    onSubscribed: vi.fn(),
    onUnavailable: vi.fn(),
    onReconnected: vi.fn(),
    log: vi.fn(),
})

let clock = 1_000_000
const now = (): number => clock

beforeEach(() => {
    vi.useFakeTimers()
    clock = 1_000_000
    discover.mockReset()
    source.mockReset().mockResolvedValue("192.168.0.50")
    subscribe.mockReset()
})

afterEach(() => {
    vi.useRealTimers()
})

describe("createUpnpWatcher", () => {
    it("subscribes and reports the subscription", async () => {
        discover.mockResolvedValue(GATEWAY)
        subscribe.mockResolvedValue({ sid: "uuid:s1", timeoutSeconds: 1800 })

        const hooks = makeHooks()
        const watcher = createUpnpWatcher({ port: 5959, now, hooks })
        await watcher.connect()

        expect(watcher.subscribed()).toBe(true)
        expect(watcher.gateway()).toEqual(GATEWAY)
        expect(hooks.onSubscribed).toHaveBeenCalledWith({
            sid: "uuid:s1",
            eventUrl: GATEWAY.eventUrl,
            serviceType: GATEWAY.serviceType,
        })
        expect(hooks.onUnavailable).not.toHaveBeenCalled()
    })

    it("reports unavailable once, then reconnected when the router returns", async () => {
        // The router is offline for the first attempt, then answers.
        discover.mockRejectedValueOnce(new Error("no gateway")).mockResolvedValue(GATEWAY)
        subscribe.mockResolvedValue({ sid: "uuid:s1", timeoutSeconds: 1800 })

        const hooks = makeHooks()
        const watcher = createUpnpWatcher({ port: 5959, minRetrySeconds: 5, now, hooks })

        await watcher.connect()
        expect(hooks.onUnavailable).toHaveBeenCalledTimes(1)
        expect(watcher.subscribed()).toBe(false)

        // 30s pass while it is down, then the 5s backoff retry fires and succeeds.
        clock += 30_000
        await vi.advanceTimersByTimeAsync(5_000)

        expect(hooks.onUnavailable).toHaveBeenCalledTimes(1) // still one-shot, not per retry
        expect(hooks.onReconnected).toHaveBeenCalledTimes(1)
        expect(hooks.onReconnected).toHaveBeenCalledWith({ downSeconds: 30, attempts: 1 })
        expect(watcher.subscribed()).toBe(true)
    })

    it("treats a failed renew as a reboot and resubscribes, reporting recovery", async () => {
        discover.mockResolvedValue(GATEWAY)
        subscribe.mockImplementation((_url: string, headers: Record<string, string>) => {
            if (isRenew(headers)) return Promise.reject(new Error("subscription forgotten"))
            return Promise.resolve({ sid: "uuid:s2", timeoutSeconds: 1800 })
        })

        const hooks = makeHooks()
        const watcher = createUpnpWatcher({ port: 5959, now, hooks })
        await watcher.connect()

        // renew is scheduled at half the timeout (900s); firing it fails, which
        // triggers a resubscribe that reports the router as recovered.
        await vi.advanceTimersByTimeAsync(900_000)

        expect(hooks.onReconnected).toHaveBeenCalledTimes(1)
        expect(hooks.onUnavailable).not.toHaveBeenCalled()
        expect(watcher.subscribed()).toBe(true)
    })

    it("does not subscribe or emit if stopped mid-discovery", async () => {
        let resolveDiscover: (g: typeof GATEWAY) => void = () => undefined
        discover.mockReturnValue(
            new Promise(resolve => {
                resolveDiscover = resolve
            }),
        )
        subscribe.mockResolvedValue({ sid: "uuid:s1", timeoutSeconds: 1800 })

        const hooks = makeHooks()
        const watcher = createUpnpWatcher({ port: 5959, now, hooks })

        const connecting = watcher.connect()
        await watcher.stop() // stop lands while discovery is still in flight
        resolveDiscover(GATEWAY) // discovery now completes, but we are stopped
        await connecting

        expect(hooks.onSubscribed).not.toHaveBeenCalled()
        expect(watcher.subscribed()).toBe(false)
    })
})
