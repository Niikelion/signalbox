import { poll } from "../defineWorkflow.js"
import { publicIPv4 } from "@signalbox/commons"

const phaseSource = { startup: "startup", interval: "http", retry: "reconnect" } as const

export const fallbackPoll = (intervalMinutes: number) =>
    poll({
        name: "fallback-poll",
        every: intervalMinutes * 60 * 1000,
        probe: (log) =>
            publicIPv4((message) => {
                log(message, "warn")
            }),
        emit: "wan-ip:observed",
        toPayload: (ip, phase) => ({ ip, source: phaseSource[phase] }),
        retryOn: { event: "wan-ip:recheck", backoff: [5, 15, 30, 60] },
    })
