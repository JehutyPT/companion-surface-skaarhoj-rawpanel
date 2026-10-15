# Architecture

Which module owns what, how events move between the panel and Companion, and where to make common changes. Terms follow [GLOSSARY.md](../GLOSSARY.md). The protocol is in [raw-panel-protocol.md](raw-panel-protocol.md), the Companion API in [surface-api-notes.md](surface-api-notes.md), and the decisions behind the design in [adr/](adr/README.md).

## Modules

All source is in `src/`; tests are in `src/__tests__/`.

| Module | Owns | Main interface |
|---|---|---|
| `main.ts` | The plugin entry point Companion loads. Opens a surface for an announced link. | `createRawPanelPlugin`, default export |
| `remote.ts` | Companion's remote connection entries: builds one connection and one link per link key, ref-counted, and holds announcements until `init`. | `RawPanelPluginRemoteService` |
| `connection-settings.ts` | The connection settings: address, port and control positions. Rejects an invalid entry. | `connectionConfigFields`, `CONNECTION_CONFIG_MATCH_EXPRESSION`, `parseConnectionSettings` |
| `link.ts` | The link: one panel at one `address:port`. Builds the layout when the connection comes online and decides when to announce, resync or replace the surface. | `PanelLink`, `LinkConnection`, `LinkTimings` |
| `connection.ts` | The connection: TCP, line framing, the connect sequence, liveness and reconnect. Feeds writes, `BSY`/`RDY` and resets to its write queue. | `PanelConnection`, `ConnectionTimings` |
| `write-queue.ts` | The write queue: pending and last-sent lines per key, coalescing, dropping unchanged lines, bursts paced per interval, the `BSY` hold with its timeout, and the reset for a new connection. Hands each burst to a send callback; knows nothing of the socket. | `WriteQueue`, `WriteQueueTimings` |
| `topology.ts` | Parsing the topology, the control kind of each HWC, and the layout and analog axes (`AnalogAxis`) built from it. | `parseTopology`, `buildLayout`, `ControlKind`, `PanelLayout`, `AnalogAxis` |
| `control-map.ts` | Parsing control positions into a `ControlMap`. Knows nothing about the panel. | `parseControlMap`, `formatControlMap` |
| `instance.ts` | The surface: turns draws into panel commands and panel input into Companion key, rotate and variable events. Holds the desired state of every control for resync. | `RawPanelSurface` |
| `protocol.ts` | Raw Panel ASCII v1: parsing inbound lines and encoding LED and display commands. | `parseLine`, `PanelEvent`, `PanelCommand`, `ledCommands`, `textCommand` |
| `analog.ts` | What an axis mode means to the user (range text, default tuning, the transfer variable declaration) and sending each axis as a transfer variable: dead zone, saturation and send interval. | `AnalogSender`, `AnalogTuning`, `axisTransferVariable`, `rangeText`, `defaultAxisTuning` |
| `settings.ts` | The surface settings: panel settings and analog tuning. Clamps bad values. | `surfaceConfigFields`, `parseSurfaceSettings`, `settingCommands` |

The link talks to its connection only through `LinkConnection`. `PanelConnection` meets it in production; tests use an in-memory one (`src/__tests__/helpers/fake-connection.ts`).

## Panel input to Companion

1. `PanelConnection` frames a line, parses it with `parseLine` and emits `event` (connection chatter such as `ack`, `ping`, `BSY` and the panel's `map=` lines stays inside the connection).
2. `PanelLink` turns `_isSleeping=0` into a resync (see Lifecycle), drops other `_isSleeping` replies, and passes the rest on as `input`.
3. `RawPanelSurface` handles the input:
   - a button or encoder push: `keyDownById` / `keyUpById` (a four-way button is one key, [ADR 0003](adr/0003-four-way-button-is-one-key.md)), or `keyDownUpById` on firmware that reports a push as `Press`;
   - an encoder turn: `rotateById`;
   - an axis: `AnalogSender`, which calls `sendVariableValue` ([ADR 0002](adr/0002-analog-axes-as-transfer-variables.md)).

## Companion draw to panel

1. Companion calls `RawPanelSurface.draw` with a control's colour, text and pressed state.
2. The surface stores that as the control's desired state and encodes it with `ledCommands` and `textCommand`.
3. `PanelLink.write` hands each `PanelCommand` to the connection, keyed by what it sets (for example `HWCc#12`, an LED colour).
4. `PanelConnection` passes each line to its `WriteQueue`, which sends only changes, paced and coalesced per key: see [What the plugin sends](raw-panel-protocol.md#what-the-plugin-sends).

## Lifecycle

- **Connect.** Companion calls `startConnections`. `parseConnectionSettings` reads the entry; `remote.ts` builds a `PanelConnection` and a `PanelLink` and starts it. The connection sends `list` and `PanelTopology?`, then emits `online` with the panel's identity and topology. The link builds the layout with `buildLayout` and announces the surface. Companion calls `openSurface` (in `main.ts`), then the surface's `init`, which attaches to the link (the link has the connection forget what it sent) and pushes every control.
- **Resync.** On a reconnect with the same panel and layout, or on wake, the link calls its connection's `resetDiffs`, then emits `resync`. The surface pushes every control again, and all of it goes out, since the panel has blanked itself. A first connect needs no reset: the connection forgets what it sent on every connect.
- **Replace surface.** If the panel or its layout changed on reconnect, the link emits `disconnect`, the surface asks Companion to close it, and the link announces again once it has. Changed control positions start a new link instead, since it is part of the link key ([ADR 0005](adr/0005-layout-settings-on-the-connection.md)). If Companion rejects an announcement, the link retries with a backoff: see [Remote (network) flow](surface-api-notes.md#remote-network-flow).

## Where to change what

- **A surface setting** (applied live): add its field and parsing in `settings.ts`, then use it in `RawPanelSurface.updateConfig`. If it sends a panel setting, add the command to `settingCommands`; panel settings stay opt-in ([ADR 0004](adr/0004-panel-settings-opt-in.md)).
- **A connection setting** (reconnects): add its field and parsing in `connection-settings.ts`, return it from `parseConnectionSettings`, and make it part of `linkKey`: `remote.ts` ignores an edit that leaves `linkKey` unchanged ([ADR 0005](adr/0005-layout-settings-on-the-connection.md)). Then pass it from `remote.ts` to the `PanelConnection` or `PanelLink` that needs it.
- **A new topology `in` type**: classify it in `topology.ts` (`ControlKind`), never by HWC number or model ([ADR 0001](adr/0001-layout-from-topology.md)). If the panel reports it with a new event shape, add it to `parseLine` in `protocol.ts` and handle it in `RawPanelSurface`. Unknown types are skipped and logged.
- **A new panel command** for an HWC: add a function in `protocol.ts` that returns a `PanelCommand` with a `key` per HWC or setting, so the write queue can coalesce it, and list it in [What the plugin sends](raw-panel-protocol.md#what-the-plugin-sends). Panel-wide setting commands live in `settings.ts` (see above).
