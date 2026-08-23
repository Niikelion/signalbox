# Workflows as data

`@signalbox/graph` lets you describe a workflow as data — nodes and edges — and compile it into a real [`WorkflowDefinition`](../concepts/workflows.md) you hand to `createApp`. This is how you drive workflows from a stored JSON document, a UI, or user configuration instead of code.

## The graph

A `WorkflowGraph` is a name, a list of nodes, and the edges between them:

```ts
const graph = {
    name: "ddns",
    nodes: [
        { id: "wan", type: "upnp.source", config: {} },
        { id: "dns", type: "cloudflare.update", config: { records: ["home.example.com"] } },
    ],
    edges: [{ from: "wan", to: "dns" }],
}
```

Each node has an `id` (referenced by edges), a registered `type`, and optional `config`. Edges connect one node's output to another's input.

## Node types and the registry

Nodes come from a **registry**. A node type is either a **trigger** (a source — it starts a flow) or an **action** (it runs per value). Plugin packages ship their own nodes and register them:

```ts
import { registerUpnpNodes } from "@signalbox/upnp"
import { registerCloudflareNodes } from "@signalbox/cloudflare"

registerUpnpNodes() // adds "upnp.source" to the default registry
registerCloudflareNodes() // adds "cloudflare.update"
```

Built-in node types include `upnp.source`, `cloudflare.update`, and `ovh.update`. Register your own with `registerNode(type)` on `defaultRegistry`, or build an isolated registry with `createNodeRegistry()`.

## Compiling

`compileGraph` validates every node's config against its type, wires the edges, and returns a `WorkflowDefinition`:

```ts
import { compileGraph, defaultRegistry } from "@signalbox/graph"

const ddns = compileGraph(graph, {
    registry: defaultRegistry, // defaults to defaultRegistry
    config: {}, // values referenced by node config templates
    secrets: { cfToken: process.env.CF_TOKEN! }, // wrapped in memory and redacted from framework output
})

await createApp({ name: "ddns", plugins, workflows: [ddns] }).run()
```

An unknown node type or invalid config throws at compile time, with a hint listing the registered types.

## Templates and control flow

- **Templates** — node config can reference values from the `config`/`secrets` scopes; they're resolved (`resolveTemplate` / `resolveDeep`) as the graph runs, and secret values are redacted from any log or error.
- **`STOP`** — an action can return the `STOP` sentinel to halt propagation for that value, so nothing downstream runs.
- **`fanOut(values)`** — emit several values from one node, running the downstream path once per value.

## Next

[Workflows](../concepts/workflows.md) · [Flow](../concepts/flow.md)
