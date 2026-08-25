import { randomUUID } from "node:crypto"
import type { DdnsOvhConfig } from "./config"
import { defineWorkflow } from "./defineWorkflow"
import { REMIND_COMMAND } from "./remind"

interface Reminder {
    id: string
    userId: string
    message: string
    kind: "once" | "cron"
    /** ISO date string for `once`, a cron expression for `cron`. */
    spec: string
    timezone?: string
}

export const reminders = (config: DdnsOvhConfig) =>
    defineWorkflow("reminders", ctx => {
        const collection = ctx.plugins.store.collection<Reminder>("reminders")

        const fire = (reminder: Reminder): void => {
            void ctx.plugins.discordBot.dm(reminder.userId, `⏰ ${reminder.message}`).catch((error: unknown) => {
                ctx.fail(error)
            })
        }

        const schedule = (reminder: Reminder): void => {
            if (reminder.kind === "cron") {
                ctx.plugins.schedule.cron(reminder.spec, { timezone: reminder.timezone }, () => {
                    fire(reminder)
                })
            } else {
                ctx.plugins.schedule.at(new Date(reminder.spec), () => {
                    fire(reminder)
                    collection.delete(reminder.id)
                })
            }
        }

        // reload persisted reminders on start
        ctx.onStart(() => {
            for (const reminder of collection.all()) schedule(reminder)
        })

        // handle /remind
        ctx.plugins.discordBot.events.flow("command").effect(async command => {
            if (command.command !== REMIND_COMMAND.name) return

            const message = typeof command.options["message"] === "string" ? command.options["message"] : ""
            const cron = typeof command.options["cron"] === "string" ? command.options["cron"] : undefined
            const inMinutes = typeof command.options["in"] === "number" ? command.options["in"] : undefined

            if (message.length === 0) {
                await command.reply("A message is required.")
                return
            }

            let reminder: Reminder
            if (cron !== undefined) {
                reminder = {
                    id: randomUUID(),
                    userId: command.userId,
                    message,
                    kind: "cron",
                    spec: cron,
                    timezone: config.timezone,
                }
                await command.reply(`Recurring reminder set (\`${cron}\`): ${message}`)
            } else if (inMinutes !== undefined && inMinutes > 0) {
                const at = new Date(Date.now() + inMinutes * 60_000)
                reminder = { id: randomUUID(), userId: command.userId, message, kind: "once", spec: at.toISOString() }
                await command.reply(`Reminder set for ${at.toISOString()}: ${message}`)
            } else {
                await command.reply("Give either `in` (minutes from now) or `cron` (a cron expression).")
                return
            }

            collection.upsert(reminder)
            schedule(reminder)
        })
    })
