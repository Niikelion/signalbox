export { cloudflarePlugin } from "./plugin.js"
export type { CloudflareApi, CloudflareEvents, CloudflareOptions } from "./plugin.js"

export { createARecord, findARecord, patchARecord, verifyZone } from "./api.js"
export type { CloudflareCredentials, DnsRecord } from "./api.js"
