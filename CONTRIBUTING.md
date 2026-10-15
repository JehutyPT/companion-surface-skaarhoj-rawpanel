# Contributing

Thanks for helping. This guide gets you from a clone to a tested change. For what the plugin does, see the [README](README.md); for which module owns what, see [docs/architecture.md](docs/architecture.md).

## Ground rules

- **Build from topology.** The layout and every control kind come from the panel's own topology report, never from the panel model or a hard-coded HWC number. No per-model code ([ADR 0001](docs/adr/0001-layout-from-topology.md)).
- **Only the SK_PTZEXTREMEV2 is tested.** Other Raw Panels may work; see [Other panels](#other-panels).
- **Develop against the fake panel.** The tests run the plugin against a fake panel on localhost. You don't need hardware to make or test a change.
- **Be gentle with a real panel.** If you do try a change on hardware, the panel has one command queue and one set of settings shared by every client. Commands such as `Clear`, `ClearLEDs`, `SleepTimer=`, `PanelBrightness=` or `SleepMode=` change what other clients and users see, and some persist. Send them only to a panel you own and can reset.

Terms follow [GLOSSARY.md](GLOSSARY.md). Decisions that are hard to reverse are in [docs/adr/](docs/adr/README.md); read the ones touching your area before changing it.

## Setup

You need Node 22.21+. Corepack, which ships with Node 22, installs the Yarn 4 version the repo pins.

```sh
corepack enable
yarn install
```

`yarn install` also sets up a pre-commit hook: it formats staged Markdown and JSON with Prettier and runs ESLint on staged code.

## Scripts

| Script            | What it does                                  |
| ----------------- | --------------------------------------------- |
| `yarn build`      | Compile `src/` to `dist/`.                    |
| `yarn dev`        | Compile and rebuild on change.                |
| `yarn test`       | Run the tests once.                           |
| `yarn test:watch` | Run the tests on every change.                |
| `yarn typecheck`  | Typecheck the source and the tests.           |
| `yarn lint`       | Run ESLint.                                   |
| `yarn format`     | Format everything with Prettier.              |
| `yarn package`    | Build a `.tgz` you can import into Companion. |

Before you commit, `yarn lint`, `yarn typecheck`, `yarn test` and `yarn build` should all pass. CI runs the same.

To try a dev build in Companion, see [Loading a dev build into Companion](docs/surface-api-notes.md#loading-a-dev-build-into-companion).

## Tests

Tests use [Vitest](https://vitest.dev/) and live in `src/__tests__/`. Each module is tested through its own interface:

- **The whole plugin** (surface, analog, settings, connection settings, control positions, connection, and `replay.spec.ts`, which replays captured panel input): through `Harness` in `helpers/harness.ts`, which runs the real plugin against `FakeRawPanel` (`helpers/fake-panel.ts`), a fake panel on a local TCP port. `connectAndOpen` connects, opens the surface the way Companion does and waits for the resync on connect; `settle` waits for the panel's commands to go quiet. `FakeSurfaceContext` (`helpers/fake-context.ts`) records what the plugin sends to Companion.
- **The write queue's pacing** (bursts, coalescing, dropping unchanged lines, `BSY`/`RDY` and the busy timeout): `WriteQueue` directly with fake timers, no socket (`write-queue.spec.ts`). `write-pacing.spec.ts` checks the connection's writes end to end against `FakeRawPanel`.
- **The link**: `PanelLink` with `FakeConnection` (`helpers/fake-connection.ts`), an in-memory connection, so no TCP.
- **The layout**: `layoutOf` (`helpers/layout.ts`) builds and validates the layout for a topology fixture.
- **Parsing and encoding**: `protocol.ts`, `parseTopology` and the analog sender directly.
- **The plugin's shape and the preset page**: `main.spec.ts` and `preset.spec.ts`.

Other helpers:

- `helpers/timing.ts`: `waitFor` (poll until a condition holds), `waitForQuiet` (until a count stops changing) and `sleep`.
- `helpers/logs.ts`: `captureLogs` and `messagesAt`, to assert what the plugin logged.

When a test depends on time:

- Wait on a condition with `waitFor`, `waitForQuiet` or `settle`, not a fixed `sleep`, so the test passes on a slow machine too. Keep `sleep` for checking that something does _not_ happen.
- Where the timing itself is under test (the analog sender's send interval, the link's retry backoff, the write queue's pacing), use Vitest's fake timers, as `analog-sender.spec.ts`, `link.spec.ts` and `write-queue.spec.ts` do.

### Adding a panel's topology

Topology fixtures are in `src/__tests__/fixtures/`. To check how a new panel lays out, add its topology there in its own file (as `ptz-extreme-topology.ts` holds the PTZ Extreme's), export it from `topologies.ts`, and assert on `layoutOf(yourTopology)`. `asciiGrid` and `cellsOf` in `helpers/layout.ts` help write readable assertions.

## Other panels

To report how the plugin works with a panel other than the SK_PTZEXTREMEV2, open a [New panel report](https://github.com/JehutyPT/companion-surface-skaarhoj-rawpanel/issues/new?template=new_panel.yml). It asks for the panel's topology and explains how to get it.

Support stays topology-driven: a fix for a new panel goes into the generic code (for example a new topology `in` type in `topology.ts`), never into code for one model. Add the panel's topology as a fixture with a test that shows the fix. See [Where to change what](docs/architecture.md#where-to-change-what).

## Commits and pull requests

- Keep commits small and focused, with a short imperative subject (`Add …`, `Fix …`), and mention the issue it belongs to, e.g. `(#12)`.
- Pull requests are welcome. Fill in the pull request template; say how you tested and whether that was on the fake panel or a real one (which model and firmware). The maintainer commits directly and doesn't need a PR.
- Report bugs with the [Bug report](https://github.com/JehutyPT/companion-surface-skaarhoj-rawpanel/issues/new?template=bug_report.yml) form.
- Update [companion/HELP.md](companion/HELP.md) and the docs when behaviour changes.

By contributing you agree that your work is released under the project's [LICENSE](LICENSE).
