import type { CommandSpec } from "@signalbox/discord-bot"

export const REMIND_COMMAND: CommandSpec = {
    name: "remind",
    description: "Set a reminder (one-time or recurring)",
    options: [
        { name: "message", description: "What to remind you about", type: "string", required: true },
        { name: "in", description: "One-time: minutes from now", type: "integer" },
        { name: "cron", description: "Recurring: a cron expression, e.g. 0 9 * * 1", type: "string" },
    ],
}
