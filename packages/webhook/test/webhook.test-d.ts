import { assertType, expectTypeOf, test } from "vitest"
import { webhookPlugin, z, type WebhookResponse } from "../src/index"

test("send() body is typed per the target's request schema", () => {
    const plugin = webhookPlugin({
        targets: {
            deploy: { url: "u", request: z.object({ ref: z.string(), force: z.boolean().optional() }) },
            ping: { url: "u" }, // no schema → body is unknown
        },
    })
    const { send } = undefined as unknown as Awaited<ReturnType<typeof plugin.init>>

    // valid calls type-check; a call resolves to WebhookResponse
    expectTypeOf(send("deploy", { ref: "main" })).resolves.toEqualTypeOf<WebhookResponse>()
    assertType(send("deploy", { ref: "main", force: true }))
    assertType(send("ping", { anything: 1 }))

    // @ts-expect-error — ref must be a string
    send("deploy", { ref: 123 })
    // @ts-expect-error — ref is required
    send("deploy", {})
    // @ts-expect-error — body is required when the target has a schema
    send("deploy")
    // @ts-expect-error — unknown target name
    send("nope", { ref: "x" })
})
