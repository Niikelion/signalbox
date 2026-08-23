# @signalbox/cloudflare-ddns

## 0.1.2

### Patch Changes

- Updated dependencies [c69b3bb]
    - @signalbox/service-cli@0.4.0

## 0.1.1

### Patch Changes

- Updated dependencies [669a2b7]
    - @signalbox/config@0.3.0
    - @signalbox/core@0.3.0
    - @signalbox/service-cli@0.3.0
    - @signalbox/cloudflare@0.2.1
    - @signalbox/commons@0.2.1
    - @signalbox/upnp@0.2.1

## 0.1.0

### Minor Changes

- b98eb9d: Publish the Cloudflare DDNS reference app. A config-driven CLI (via `@signalbox/service-cli`) with a systemd lifecycle that keeps Cloudflare A records pointed at a home connection's public IP, driven by UPnP push and a polling fallback.
