import { describe, expect, it } from "vitest"
import { toApplicationCommand } from "../src/commands.js"

describe("toApplicationCommand", () => {
    it("maps a spec to Discord application-command JSON", () => {
        const command = toApplicationCommand({
            name: "remind",
            description: "Set a reminder",
            options: [
                { name: "message", description: "What to remind you about", type: "string", required: true },
                { name: "minutes", description: "In how many minutes", type: "integer" },
                { name: "weekly", description: "Repeat weekly", type: "boolean" },
            ],
        })

        expect(command).toEqual({
            name: "remind",
            description: "Set a reminder",
            options: [
                { type: 3, name: "message", description: "What to remind you about", required: true },
                { type: 4, name: "minutes", description: "In how many minutes", required: false },
                { type: 5, name: "weekly", description: "Repeat weekly", required: false },
            ],
        })
    })

    it("handles a command with no options", () => {
        expect(toApplicationCommand({ name: "ping", description: "pong" }).options).toEqual([])
    })
})
