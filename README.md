# companion-surface-skaarhoj-rawpanel

A [Bitfocus Companion](https://bitfocus.io/companion) surface plugin that makes a SKAARHOJ panel (first the PTZ Extreme V2) a Companion surface over the Raw Panel TCP protocol, so it can replace Stream Decks: buttons, encoders, LEDs, display text and the sleep timer. The joystick stays with [PTZJoystickControl](https://github.com/JehutyPT/PTZJoystickControl), which shares the panel.

**Status: in development.** The plugin loads but does not connect to a panel yet.

See [HELP.md](./companion/HELP.md) and [LICENSE](./LICENSE).

## Docs

- [AGENTS.md](./AGENTS.md): scope, rules for sharing the panel, versions and conventions.
- [docs/raw-panel-protocol.md](./docs/raw-panel-protocol.md): the Raw Panel protocol.
- [docs/surface-api-notes.md](./docs/surface-api-notes.md): the Companion surface API (`@companion-surface/base` 1.4).
- Spec and decisions: [JehutyPT/companion-surface-skaarhoj-rawpanel#1](https://github.com/JehutyPT/companion-surface-skaarhoj-rawpanel/issues/1).

## Development

Requires Node 22.18+ and Yarn 4 via corepack.

```sh
corepack enable
yarn install
yarn build   # or `yarn dev` to rebuild on change
yarn lint
yarn test
```

To load the dev build into Companion, point Companion's developer modules folder at the **parent** of this repo's folder, enable developer modules, then add the surface integration and a Remote Surface connection. Details in [docs/surface-api-notes.md](./docs/surface-api-notes.md#loading-a-dev-build-into-companion).

`yarn package` builds a `.tgz` that can be imported into Companion offline.
