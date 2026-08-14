---
"@signalbox/service-cli": minor
"@signalbox/ovh": minor
---

Add an OVH DynHost DDNS target as a second app, and extract the generic service
scaffolding both apps share.

- `@signalbox/service-cli` (new): the provider-agnostic command-line and systemd
  lifecycle — argument parsing, the `config` subcommands, and setup/teardown/
  start/stop/status/run/once — driven by a small `ServiceApp` descriptor. No DNS
  or domain logic lives here; the one-shot command and the firewall port are
  optional hooks an app opts into.
- `@signalbox/ovh` (new): a plugin that points OVH DynHost records at the current
  address over the dyndns2 protocol (HTTP Basic auth), plus an `ovh.update`
  graph node. DynHost reports `good`/`nochg`, so changed-vs-unchanged is exact;
  every other response is surfaced as an error.
- `@signalbox/ddns-ovh` (new): the OVH counterpart to `@signalbox/ddns`, driven by
  the same UPnP WAN-IP detection. It defaults its UPnP callback to port 5960 so
  it can run alongside the Cloudflare app on one host.
- `@signalbox/ddns` now consumes `@signalbox/service-cli` for its CLI and systemd
  management instead of carrying its own copies. No behaviour change.
