/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest"
import { schedulePlugin, type ScheduleApi } from "../src/index.js"

const stubCtx = { onStop: () => undefined, fail: () => undefined } as any

const makeApi = async (): Promise<ScheduleApi> => (await schedulePlugin().init(stubCtx)) as ScheduleApi

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe("schedule", () => {
    it("runs a one-shot at a date", async () => {
        const api = await makeApi()
        const fired: string[] = []

        api.at(new Date(Date.now() + 40), () => {
            fired.push("fired")
        })
        await sleep(120)
        expect(fired).toEqual(["fired"])
    })

    it("cancel prevents a scheduled run", async () => {
        const api = await makeApi()
        const fired: string[] = []

        const handle = api.at(new Date(Date.now() + 40), () => {
            fired.push("fired")
        })
        handle.cancel()
        await sleep(120)
        expect(fired).toEqual([])
    })

    it("computes the next run of a cron expression (timezone-aware)", async () => {
        const api = await makeApi()
        const next = api.next("0 9 * * 1", { timezone: "UTC" }, new Date("2026-08-16T00:00:00Z"))
        // 2026-08-16 is a Sunday, so the next Monday 09:00 UTC is 2026-08-17
        expect(next?.toISOString()).toBe("2026-08-17T09:00:00.000Z")
    })
})
