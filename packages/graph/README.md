# @signalbox/graph

signalbox workflows as data: a node registry and a compiler that turns a JSON graph into a runnable workflow.

Part of [signalbox](https://github.com/Niikelion/signalbox) — see the [full documentation](https://github.com/Niikelion/signalbox/tree/master/docs).

## Install

```bash
npm install @signalbox/graph
```

## Usage

Describe a workflow as nodes and edges, then compile it into a `WorkflowDefinition` you hand to `createApp`.

```ts
import { compileGraph, defaultRegistry } from "@signalbox/graph"

const graph = {
    nodes: [
        { id: "src", type: "upnp.source", config: {} },
        { id: "dns", type: "cloudflare.update", config: { records: ["home.example.com"] } },
    ],
    edges: [{ from: "src", to: "dns" }],
}

const workflow = compileGraph(graph, {
    registry: defaultRegistry,
    config: {}, // values referenced by node templates
    secrets: {}, // wrapped in memory; revealed only while resolving $secret templates
})

// createApp({ ..., workflows: [workflow] })
```

Node types come from a `NodeRegistry`: use `defaultRegistry`, or build your own with `createNodeRegistry()` / `registerNode()`. Plugin packages expose their nodes (e.g. `registerUpnpNodes`, `registerCloudflareNodes`). Templates in node config are resolved with `resolveTemplate` / `resolveDeep`; node kinds mirror Flow operators such as `map`, `filter`, `fork`, `detach`, and `effect`.

## License

MIT
