import { describe, expect, it } from "vitest"
import { createSystemdServiceAdapter } from "../src/index"
import { renderSystemdUnit } from "../src/systemd"

const render = (systemService = {}) =>
    renderSystemdUnit({
        appName: "proxybox",
        description: "manages local proxy routes",
        scope: "system",
        configPath: "/etc/proxybox/config.json",
        executable: "/usr/bin/node",
        runArgs: ["/usr/bin/proxybox", "run"],
        credentials: [],
        systemService,
    })

describe("systemd service profiles", () => {
    it("should preserve the default account and hardening", () => {
        const unit = render()

        expect(unit).toContain("Description=manages local proxy routes")
        expect(unit).toContain("User=signalbox\nGroup=signalbox")
        expect(unit).toContain("ExecStart=/usr/bin/node /usr/bin/proxybox run")
        expect(unit).toContain("ProtectSystem=strict")
        expect(unit).toContain("RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX")
    })

    it("should render structured account and filesystem settings", () => {
        const unit = render({
            user: "proxybox",
            group: "proxybox",
            supplementaryGroups: ["proxy-users"],
            runtimeDirectory: { name: "proxybox", mode: 0o750 },
            readWritePaths: ["/var/lib/proxybox"],
        })

        expect(unit).toContain("User=proxybox\nGroup=proxybox")
        expect(unit).toContain("SupplementaryGroups=proxy-users")
        expect(unit).toContain("RuntimeDirectory=proxybox\nRuntimeDirectoryMode=0750")
        expect(unit).toContain("ReadWritePaths=/var/lib/proxybox")
    })

    it("should reject values that could inject unit directives", () => {
        expect(() => createSystemdServiceAdapter({ profile: { user: "proxybox\nUser=root" } })).toThrow(
            "invalid system account",
        )
        expect(() => createSystemdServiceAdapter({ profile: { readWritePaths: ["/var/lib/proxybox extra"] } })).toThrow(
            "invalid writable path",
        )
        expect(() =>
            renderSystemdUnit({
                appName: "proxybox",
                description: "proxybox\nUser=root",
                scope: "system",
                configPath: "/etc/proxybox/config.json",
                executable: "/usr/bin/node",
                runArgs: ["/usr/bin/proxybox", "run"],
                credentials: [],
            }),
        ).toThrow("description cannot contain")
    })
})

describe("systemd service adapter", () => {
    it("declares system and user scopes with system as default", () => {
        const adapter = createSystemdServiceAdapter()
        expect(adapter.defaultScope).toBe("system")
        expect(adapter.scopes.map(scope => scope.name)).toEqual(["system", "user"])
    })
})
