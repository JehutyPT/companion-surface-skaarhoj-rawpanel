# companion-surface-skaarhoj-rawpanel

A [Bitfocus Companion](https://bitfocus.io/companion) surface plugin that makes a SKAARHOJ Raw Panel a Companion surface over the Raw Panel TCP protocol: buttons, encoders, LEDs and display text, with analog controls (joysticks, rockers, faders) as input variables. Needs Companion 5.1+.

**Supported hardware:** built and tested on the SK_PTZEXTREMEV2, with a starter preset page in [presets/ptz-extreme.companionconfig](./presets/ptz-extreme.companionconfig) (import steps and the custom variables it needs are in [HELP.md](./companion/HELP.md#ptz-extreme-preset-page)). The layout comes from the panel's own topology report, so other Raw Panels may work, but they are untested. Issues and PRs for other panels are welcome.

## Features

- Buttons, encoders, LEDs and display text, laid out on the Companion grid from the panel's own topology report.
- **Control positions**: move any control to a row and column of your choice from the connection settings.
- Joysticks, rockers and faders as input variables, with a per-axis on/off switch, dead zone and saturation, and a send interval.
- Optional: set the panel's sleep timeout and brightness from Companion. By default the panel's own settings are left alone.
- Reconnects on its own, and restores every LED and display on reconnect and when the panel wakes.
- A starter preset page for the PTZ Extreme.

## Installing

Once published, the plugin installs from Companion's surface store. Until then, download the `.tgz` from a [GitHub release](https://github.com/JehutyPT/companion-surface-skaarhoj-rawpanel/releases) and import it into Companion, or build one with `yarn package` (see Development). Setup and settings are in [HELP.md](./companion/HELP.md).

Use one Companion integration per panel: don't run this plugin and SKAARHOJ's own Companion connection module against the same panel at once. The panel has one command queue shared by every client, so two integrations writing to it slow each other down.

See [HELP.md](./companion/HELP.md) and [LICENSE](./LICENSE).

## Docs

- [AGENTS.md](./AGENTS.md): scope, rules, versions and conventions.
- [docs/raw-panel-protocol.md](./docs/raw-panel-protocol.md): the Raw Panel protocol.
- [docs/surface-api-notes.md](./docs/surface-api-notes.md): the Companion surface API (`@companion-surface/base` 1.4).
- Spec, decisions, slices and backlog: [JehutyPT/companion-surface-skaarhoj-rawpanel#1](https://github.com/JehutyPT/companion-surface-skaarhoj-rawpanel/issues/1).

## Development

Requires Node 22.21+ and Yarn 4 via corepack.

```sh
corepack enable
yarn install
yarn build   # or `yarn dev` to rebuild on change
yarn lint
yarn test
```

To load the dev build into Companion, point Companion's developer modules folder at the **parent** of this repo's folder, enable developer modules, then add the surface integration and a Remote Surface connection. Details in [docs/surface-api-notes.md](./docs/surface-api-notes.md#loading-a-dev-build-into-companion).

`yarn package` builds a `.tgz` that can be imported into Companion offline.
