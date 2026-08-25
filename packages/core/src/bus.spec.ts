import { describe, expect, it, vi } from "vitest"
import { createBus, type Flow } from "@/index"

const flush = async (): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, 0))
}

type TestEvents = {
    value: number
    text: string
}

describe("Bus", () => {
    it("should dispatch emitted events to listeners on the same channel", () => {
        const channel = createBus().channel<TestEvents>("test")
        const values: number[] = []

        channel.on("value", value => {
            values.push(value)
        })

        channel.emit("value", 1)
        channel.emit("value", 2)

        expect(values).toEqual([1, 2])
    })

    it("should isolate listeners by channel and event", () => {
        const bus = createBus()
        const a = bus.channel<TestEvents>("a")
        const b = bus.channel<TestEvents>("b")
        const values: string[] = []

        a.on("value", value => {
            values.push(`a:${String(value)}`)
        })
        a.on("text", value => {
            values.push(`a:${value}`)
        })
        b.on("value", value => {
            values.push(`b:${String(value)}`)
        })

        a.emit("value", 1)
        a.emit("text", "x")
        b.emit("value", 2)

        expect(values).toEqual(["a:1", "a:x", "b:2"])
    })

    it("should unsubscribe listeners returned by on", () => {
        const channel = createBus().channel<TestEvents>("test")
        const values: number[] = []
        const unsubscribe = channel.on("value", value => {
            values.push(value)
        })

        channel.emit("value", 1)
        unsubscribe()
        channel.emit("value", 2)

        expect(values).toEqual([1])
    })

    it("should remove a specific listener with off", () => {
        const channel = createBus().channel<TestEvents>("test")
        const first = vi.fn()
        const second = vi.fn()

        channel.on("value", first)
        channel.on("value", second)
        channel.off("value", first)

        channel.emit("value", 1)

        expect(first).not.toHaveBeenCalled()
        expect(second).toHaveBeenCalledWith(1)
    })

    it("should run once listeners only once", () => {
        const channel = createBus().channel<TestEvents>("test")
        const values: number[] = []

        channel.once("value", value => {
            values.push(value)
        })

        channel.emit("value", 1)
        channel.emit("value", 2)

        expect(values).toEqual([1])
    })

    it("should allow a once listener to be cancelled before it runs", () => {
        const channel = createBus().channel<TestEvents>("test")
        const listener = vi.fn()
        const unsubscribe = channel.once("value", listener)

        unsubscribe()
        channel.emit("value", 1)

        expect(listener).not.toHaveBeenCalled()
    })

    it("should buffer events while paused and flush them in order on resume", () => {
        const bus = createBus({ paused: true })
        const channel = bus.channel<TestEvents>("test")
        const values: number[] = []

        channel.on("value", value => {
            values.push(value)
        })
        channel.emit("value", 1)
        channel.emit("value", 2)

        expect(bus.paused).toBe(true)
        expect(bus.buffered).toBe(2)
        expect(values).toEqual([])

        bus.resume()

        expect(bus.paused).toBe(false)
        expect(bus.buffered).toBe(0)
        expect(values).toEqual([1, 2])
    })

    it("should clear listeners and buffered events", () => {
        const bus = createBus({ paused: true })
        const channel = bus.channel<TestEvents>("test")
        const values: number[] = []

        channel.on("value", value => {
            values.push(value)
        })
        channel.emit("value", 1)
        bus.clear()
        bus.resume()
        channel.emit("value", 2)

        expect(values).toEqual([])
        expect(bus.buffered).toBe(0)
    })

    it("should report synchronous and asynchronous listener errors", async () => {
        const errors: string[] = []
        const channel = createBus({
            onListenerError: (error, channelId, event) => {
                errors.push(`${channelId}/${event}:${error.message}`)
            },
        }).channel<TestEvents>("test")

        channel.on("value", () => {
            throw new Error("sync failed")
        })
        channel.on("value", async () => {
            throw new Error("async failed")
        })

        channel.emit("value", 1)
        await flush()

        expect(errors).toEqual(["test/value:sync failed", "test/value:async failed"])
    })

    it("should expose events as flows", async () => {
        const channel = createBus().channel<TestEvents>("test")
        const flow: Flow<number> = channel.flow("value")
        const values: number[] = []

        flow.map(value => value * 2).effect(value => {
            values.push(value)
        })

        channel.emit("value", 2)
        channel.emit("value", 3)
        await flush()

        expect(values).toEqual([4, 6])
    })
})
