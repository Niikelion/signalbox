import { describe, expect, it } from "vitest"
import { definePlugin, type PluginApis } from "@/index"

describe("definePlugin", () => {
    it("should return the plugin definition unchanged", () => {
        const plugin = {
            name: "plugin",
            init: () => ({ value: 1 }),
        }

        expect(definePlugin(plugin)).toBe(plugin)
    })

    it("should preserve plugin API types", () => {
        const plugins = {
            numbers: definePlugin({
                name: "numbers",
                init: () => ({ next: (): number => 1 }),
            }),
        }
        const apis: PluginApis<typeof plugins> = {
            numbers: { next: () => 2 },
        }

        expect(Object.keys(plugins)).toEqual(["numbers"])
        expect(apis.numbers.next()).toBe(2)
    })
})
