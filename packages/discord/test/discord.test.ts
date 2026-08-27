/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import { afterAll, describe, expect, it, vi } from "vitest"
import { createPermissionExecution, entityRef, GrantStateCell, permissionClaim } from "@signalbox/permissions"
import { DISCORD_SEND_PERMISSION, discordPlugin, discordWebhookRef } from "../src/index"

const fetchMock = vi.spyOn(globalThis, "fetch")
afterAll(() => {
    fetchMock.mockRestore()
})

const makeApi = async (allowed = true) => {
    const permissions = createPermissionExecution()
    const identity = permissions.identities.issue({
        principal: entityRef("workflow", "discord-test"),
        contributions: allowed
            ? [
                  {
                      claim: permissionClaim(DISCORD_SEND_PERMISSION, discordWebhookRef("alerts")),
                      grant: new GrantStateCell({ id: "discord-send" }),
                  },
              ]
            : [],
    })
    const api = await discordPlugin({
        webhookUrl: "https://discord/webhook",
        username: "bot",
        resourceId: "alerts",
    }).init({ permissions: permissions.runtime } as any)
    return {
        send: (message: { content: string; username?: string; avatarUrl?: string }) =>
            permissions.runtime.runAs(identity, { operation: "test" }, () => api.send(message)),
    }
}

describe("discord plugin", () => {
    it("posts a webhook payload with the username default", async () => {
        fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 204 }))
        const api = await makeApi()

        await api.send({ content: "hello" })

        expect(fetchMock).toHaveBeenCalledTimes(1)
        const call = fetchMock.mock.calls[0]
        expect(call?.[0]).toBe("https://discord/webhook")
        const payload = JSON.parse((call?.[1]?.body as string) ?? "{}")
        expect(payload).toEqual({ content: "hello", username: "bot" })
    })

    it("retries once on 429 then succeeds", async () => {
        fetchMock
            .mockReset()
            .mockResolvedValueOnce(new Response("rate", { status: 429, headers: { "retry-after": "0" } }))
            .mockResolvedValueOnce(new Response(null, { status: 204 }))
        const api = await makeApi()

        await api.send({ content: "x" })
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it("throws on a non-retryable error", async () => {
        fetchMock.mockReset().mockResolvedValue(new Response("bad", { status: 400 }))
        const api = await makeApi()

        await expect(api.send({ content: "x" })).rejects.toThrow(/400/)
    })

    it("denies sends without the webhook-scoped permission", async () => {
        fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 204 }))
        const api = await makeApi(false)

        await expect(api.send({ content: "x" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" })
        expect(fetchMock).not.toHaveBeenCalled()
    })
})
