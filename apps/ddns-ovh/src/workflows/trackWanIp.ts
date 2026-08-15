import { dedupe } from "../defineWorkflow.js"

export const trackWanIp = dedupe({
    name: "track-wan-ip",
    on: "wan-ip:observed",
    emit: "wan-ip:changed",
    key: ({ ip }) => ip,
    toPayload: ({ ip, source }, previous) => ({ previous, current: ip, source }),
    message: ({ ip, source }, previous) =>
        previous === null ? `WAN IP is ${ip} (via ${source})` : `WAN IP changed ${previous} -> ${ip} (via ${source})`,
})
