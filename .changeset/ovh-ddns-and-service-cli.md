---
"@flowkit/service-cli": minor
"@flowkit/ovh": minor
"@flowkit/ddns-ovh": minor
"@flowkit/ddns": patch
---

Add an OVH DynHost DDNS target as a second app, and extract the generic service
scaffolding both apps share.

- `@flowkit/service-cli` (new): the provider-agnostic command-line and systemd
  lifecycle — argument parsing, the `config` subcommands, and setup/teardown/
  start/stop/status/run/once — driven by a small `ServiceApp` descriptor. No DNS
  or domain logic lives here; the one-shot command and the firewall port are
  optional hooks an app opts into.
- `@flowkit/ovh` (new): a plugin that points OVH DynHost records at the current
  address over the dyndns2 protocol (HTTP Basic auth), plus an `ovh.update`
  graph node. DynHost reports `good`/`nochg`, so changed-vs-unchanged is exact;
  every other response is surfaced as an error.
- `@flowkit/ddns-ovh` (new): the OVH counterpart to `@flowkit/ddns`, driven by
  the same UPnP WAN-IP detection. It defaults its UPnP callback to port 5960 so
  it can run alongside the Cloudflare app on one host.
- `@flowkit/ddns` now consumes `@flowkit/service-cli` for its CLI and systemd
  management instead of carrying its own copies. No behaviour change.
