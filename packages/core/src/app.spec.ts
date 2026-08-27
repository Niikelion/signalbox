import { Secret } from "@signalbox/secrets"
import { createPermissionExecution, entityRef, GrantStateCell, permissionClaim } from "@signalbox/permissions"
import { afterEach, describe, expect, it, vi } from "vitest"

const observed = vi.hoisted(() => ({
    errors: [] as Error[],
    messages: [] as string[],
}))

vi.mock("@/log", async importOriginal => {
    const actual = await importOriginal<typeof import("@/log")>()
    return {
        ...actual,
        attachConsoleLogger: (channel: Parameters<typeof actual.attachConsoleLogger>[0]) => {
            const offLog = channel.on("log", ({ message }) => {
                observed.messages.push(message)
            })
            const offError = channel.on("error", ({ error }) => {
                observed.errors.push(error)
            })
            return () => {
                offLog()
                offError()
            }
        },
    }
})

import { createApp, definePlugin, write, type Channel } from "@/index"

afterEach(() => {
    observed.errors.length = 0
    observed.messages.length = 0
    vi.restoreAllMocks()
})

const flush = async (): Promise<void> => {
    await Promise.resolve()
    await Promise.resolve()
}

const testPermissions = () => {
    const execution = createPermissionExecution()
    return {
        runtime: execution.runtime,
        core: execution.core,
        host: execution.identities.issue({ principal: entityRef("system", "test-host") }),
    }
}

describe("createApp", () => {
    it("should initialize plugins before workflows and run plugin setup after workflows", async () => {
        const events: string[] = []
        const plugin = definePlugin({
            name: "plugin",
            init: () => {
                events.push("plugin:init")
                return { value: 1 }
            },
            setup: () => {
                events.push("plugin:setup")
            },
        })

        const app = createApp({
            name: "app",
            permissions: testPermissions(),
            plugins: { plugin },
            logging: false,
            workflows: [
                {
                    name: "workflow",
                    setup: ctx => {
                        events.push(`workflow:${String(ctx.plugins.plugin.value)}`)
                    },
                },
            ],
        })

        await app.start()

        expect(app.name).toBe("app")
        expect(events).toEqual(["plugin:init", "workflow:1", "plugin:setup"])
    })

    it("should be idempotent across repeated start and stop calls", async () => {
        let initCalls = 0
        const cleanup = vi.fn()
        const app = createApp({
            name: "app",
            permissions: testPermissions(),
            logging: false,
            plugins: {
                plugin: definePlugin({
                    name: "plugin",
                    init: ctx => {
                        initCalls += 1
                        ctx.onStop(cleanup)
                        return {}
                    },
                }),
            },
            workflows: [],
        })

        await app.start()
        await app.start()
        await app.stop()
        await app.stop()

        expect(initCalls).toBe(1)
        expect(cleanup).toHaveBeenCalledOnce()
    })

    it("should run start hooks after workflows are wired and the bus resumes", async () => {
        const seen: string[] = []
        const app = createApp({
            name: "app",
            permissions: testPermissions(),
            plugins: {
                plugin: definePlugin({
                    name: "plugin",
                    init: ctx => {
                        ctx.onStart(() => {
                            ctx.channel.emit("ready", "value")
                        })
                        return { events: ctx.channel }
                    },
                }),
            },
            workflows: [
                {
                    name: "workflow",
                    setup: ctx => {
                        ctx.plugins.plugin.events.on("ready", value => {
                            seen.push(String(value))
                        })
                    },
                },
            ],
        })

        await app.start()
        await flush()

        expect(seen).toEqual(["value"])
    })

    it("should run cleanup callbacks in reverse registration order", async () => {
        const order: string[] = []
        const app = createApp({
            name: "app",
            permissions: testPermissions(),
            logging: false,
            plugins: {
                plugin: definePlugin({
                    name: "plugin",
                    init: ctx => {
                        ctx.onStop(() => {
                            order.push("plugin")
                        })
                        return {}
                    },
                }),
            },
            workflows: [
                {
                    name: "workflow",
                    setup: ctx => {
                        ctx.onStop(() => {
                            order.push("workflow")
                        })
                    },
                },
            ],
        })

        await app.start()
        await app.stop()

        expect(order).toEqual(["workflow", "plugin"])
    })

    it("should report onStart and interval failures through framework errors", async () => {
        vi.useFakeTimers()
        const app = createApp({
            name: "app",
            permissions: testPermissions(),
            plugins: {},
            workflows: [
                {
                    name: "workflow",
                    setup: ctx => {
                        ctx.onStart(() => {
                            throw new Error("start failed")
                        })
                        ctx.interval(100, () => {
                            throw new Error("interval failed")
                        })
                    },
                },
            ],
        })

        await app.start()
        vi.advanceTimersByTime(100)
        await flush()
        await app.stop()
        vi.useRealTimers()

        expect(observed.errors.map(error => error.message)).toEqual(["start failed", "interval failed"])
    })

    it("should sanitize workflow messages and errors before framework subscribers receive them", async () => {
        const secret = Secret.from("subscriber-secret-value")
        const app = createApp({
            name: "containment-test",
            permissions: testPermissions(),
            plugins: {},
            workflows: [
                {
                    name: "workflow",
                    setup: ctx => {
                        ctx.log(`message ${secret.reveal()}`)
                        ctx.fail(new Error(`failure ${secret.reveal()}`))
                    },
                },
            ],
        })

        await app.start()
        await app.stop()

        expect(observed.messages).toEqual(["message [redacted]"])
        expect(observed.errors).toHaveLength(1)
        expect(observed.errors[0]?.message).toBe("failure [redacted]")
    })

    it("should sanitize final output using secrets registered by another module evaluation", async () => {
        vi.resetModules()
        const secondCopy = await import("@signalbox/secrets")
        const secret = secondCopy.Secret.from("duplicate-copy-output-secret")
        const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

        write("info", `revealed ${secret.reveal()}`)

        expect(output).toHaveBeenCalledOnce()
        expect(String(output.mock.calls[0]?.[0])).toContain("revealed [redacted]")
        expect(String(output.mock.calls[0]?.[0])).not.toContain("duplicate-copy-output-secret")
    })

    it("derives command actors and workflow run principals from opaque identities", async () => {
        type Events = { trigger: string }
        const permissions = createPermissionExecution()
        const host = permissions.identities.issue({ principal: entityRef("system", "host") })
        const alice = permissions.identities.issue({ principal: entityRef("user", "alice") })
        let events!: Channel<Events>
        const principals: string[] = []
        const app = createApp<Events, Record<string, never>>({
            name: "commands",
            logging: false,
            permissions: { runtime: permissions.runtime, core: permissions.core, host },
            plugins: {},
            workflows: [
                {
                    name: "manual-trigger",
                    setup: ctx => {
                        events = ctx.app
                        ctx.app.flow("trigger").effect((_value, run) => {
                            principals.push(run.principal?.id ?? "missing")
                        })
                    },
                },
            ],
        })
        await app.start()

        const actor = await app.command({ identity: alice, operation: "trigger.invoke" }, commandActor => {
            events.emit("trigger", "payload-with-forged-actor")
            return commandActor
        })
        await flush()

        expect(actor).toEqual(entityRef("user", "alice"))
        expect(principals).toEqual(["alice"])
        await app.stop()
    })

    it("validates and authorizes declared manual triggers using the authenticated identity", async () => {
        type Events = { sync: { force: boolean } }
        const permissions = createPermissionExecution()
        const trigger = entityRef("manual-trigger", "sync-now")
        const invoke = permissionClaim("trigger.invoke", trigger)
        const host = permissions.identities.issue({ principal: entityRef("system", "host") })
        const alice = permissions.identities.issue({
            principal: entityRef("user", "alice"),
            contributions: [{ claim: invoke, grant: new GrantStateCell({ id: "alice-trigger" }) }],
        })
        const received: boolean[] = []
        const app = createApp<Events, Record<string, never>>({
            name: "manual-triggers",
            logging: false,
            permissions: { runtime: permissions.runtime, core: permissions.core, host },
            plugins: {},
            manualTriggers: [
                {
                    id: "sync-now",
                    event: "sync",
                    schema: {
                        parse: input => {
                            if (typeof input !== "object" || input === null || !("force" in input))
                                throw new Error("invalid")
                            return { force: Boolean(input.force) }
                        },
                    },
                },
            ],
            workflows: [
                {
                    name: "sync",
                    setup: ctx => {
                        ctx.app.flow("sync").effect(value => {
                            received.push(value.force)
                        })
                    },
                },
            ],
        })
        await app.start()

        const result = await app.manualTriggers.invoke(
            "sync-now",
            { force: true, actor: "forged" },
            {
                identity: alice,
                operation: "ui.trigger",
            },
        )
        await flush()

        expect(result.actor).toEqual(entityRef("user", "alice"))
        expect(result.eventId).toMatch(/^[0-9a-f-]{36}$/u)
        expect(received).toEqual([true])
        await app.stop()
    })
})
