import { Secret } from "@signalbox/secrets"
import { describe, expect, expectTypeOf, it } from "vitest"
import { config, field, secret, z, type ConfigOf, type InputOf } from "../src/index.js"

describe("config type projections", () => {
    const schema = config({
        host: field().string(),
        token: field().string().min(3).secret().max(100),
        optionalOne: field().string().secret().optional(),
        optionalTwo: field().string().optional().secret(),
        retries: field().int().default(3),
        rawSecret: secret(z.array(z.string())),
    })

    it("keeps direct Zod parsing plaintext while projecting store secrets", () => {
        const parsed = schema.parse({ host: "localhost", token: "token", rawSecret: ["x"] })
        expect(parsed.token).toBe("token")

        expectTypeOf<InputOf<typeof schema>["token"]>().toEqualTypeOf<string>()
        expectTypeOf<InputOf<typeof schema>["optionalOne"]>().toEqualTypeOf<string | undefined>()
        expectTypeOf<ConfigOf<typeof schema>["token"]>().toEqualTypeOf<Secret<string>>()
        expectTypeOf<ConfigOf<typeof schema>["optionalOne"]>().toEqualTypeOf<Secret<string> | undefined>()
        expectTypeOf<ConfigOf<typeof schema>["optionalTwo"]>().toEqualTypeOf<Secret<string> | undefined>()
        expectTypeOf<ConfigOf<typeof schema>["rawSecret"]>().toEqualTypeOf<Secret<string[]>>()
        expectTypeOf<ConfigOf<typeof schema>["host"]>().toEqualTypeOf<string>()
        expectTypeOf<ConfigOf<typeof schema>["retries"]>().toEqualTypeOf<number>()
    })
})

describe("secret schema constraints", () => {
    it("rejects secret defaults in either builder order", () => {
        expect(() => config({ token: field().string().secret().default("source-secret") })).toThrow(
            "cannot have a default",
        )
        expect(() => config({ token: field().string().default("source-secret").secret() })).toThrow(
            "cannot have a default",
        )
        expect(() => config({ token: secret(z.string()).default("source-secret") })).toThrow("cannot have a default")
    })

    it("rejects nested markers and accepts an outermost raw secret", () => {
        expect(() => config({ credentials: z.object({ token: secret(z.string()) }) })).toThrow("outermost top-level")
        expect(() => config({ credentials: z.array(secret(z.string())) })).toThrow("outermost top-level")
        expect(() => config({ credentials: secret(z.object({ token: z.string() })) })).not.toThrow()
    })
})
