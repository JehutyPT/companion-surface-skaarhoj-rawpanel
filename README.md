# companion-surface-skaarhoj-rawpanel

A [Bitfocus Companion](https://bitfocus.io/companion) surface plugin that makes a SKAARHOJ Raw Panel a Companion surface over the Raw Panel TCP protocol: buttons, encoders, LEDs and display text, with analog controls (joysticks, rockers, faders) as input variables. Needs Companion 5.1+.

**Supported hardware:** built and tested on the SK_PTZEXTREMEV2, for which a preset page is planned. The layout comes from the panel's own topology report, so other Raw Panels may work, but they are untested. Issues and PRs for other panels are welcome.

**Status: in development.** Buttons, encoders, LEDs and display text work, with the layout read from the panel. Joysticks, rockers and faders send their values to Companion custom variables, and the panel's sleep timeout and brightness can optionally be set from Companion. The PTZ Extreme preset page is not done yet.

See [HELP.md](./companion/HELP.md) and [LICENSE](./LICENSE).

## Docs

- [AGENTS.md](./AGENTS.md): scope, rules, versions and conventions.
- [docs/raw-panel-protocol.md](./docs/raw-panel-protocol.md): the Raw Panel protocol.
- [docs/surface-api-notes.md](./docs/surface-api-notes.md): the Companion surface API (`@companion-surface/base` 1.4).
- Spec, decisions, slices and backlog: [JehutyPT/companion-surface-skaarhoj-rawpanel#1](https://github.com/JehutyPT/companion-surface-skaarhoj-rawpanel/issues/1).

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
