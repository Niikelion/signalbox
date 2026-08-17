import { config, createConfigStore, field, type Infer } from "@signalbox/config"

export const APP_NAME = "signalbox-ddns-ovh"

export const configSchema = config({
    // DNS
    dynhostUser: field().string().min(1).describe("DynHost username created in the OVH panel (e.g. example.com-home)"),
    dynhostPassword: field().string().min(1).secret().describe("Password set for that DynHost username"),
    records: field().list().nonempty().describe("Comma-separated DynHost hostnames to keep updated"),
    watchPort: field().int().positive().default(5960).describe("TCP port the UPnP NOTIFY callback listens on"),
    fallbackMinutes: field().int().positive().default(15).describe("Safety-net re-check interval"),

    // Reminders bot
    discordToken: field().string().min(1).secret().describe("Discord bot token for the reminders bot"),
    discordGuildId: field().string().optional().describe("Guild to register /remind in instantly (else global, ~1h)"),
    timezone: field().string().default("UTC").describe("IANA timezone for recurring reminders, e.g. Europe/Warsaw"),
    remindersDb: field().string().default("reminders.db").describe("SQLite file where reminders are stored"),
})

export type DdnsOvhConfig = Infer<typeof configSchema>

export const createDdnsOvhConfigStore = (path?: string) =>
    createConfigStore({ appName: APP_NAME, schema: configSchema, ...(path ? { path } : {}) })
