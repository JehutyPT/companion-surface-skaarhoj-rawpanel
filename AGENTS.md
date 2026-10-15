# AGENTS.md

A Bitfocus Companion **surface plugin** (TypeScript) that makes a SKAARHOJ Raw Panel a first-class Companion surface: buttons, encoders, LEDs, display text and analog controls. A standalone community plugin.

**Support scope:** generic by construction, supported on one panel. The SK_PTZEXTREMEV2 is the only tested and supported panel. Code is driven by the panel's topology and control classes, never by model, so other Raw Panels may work. Do not add per-model code, bitmap/graphic displays, motorised faders or other hardware research unless the user asks; unknown control types are skipped and logged. It talks Raw Panel ASCII v1 over TCP 9923 through the plugin's `remote` (`SurfacePluginRemote`).

Spec, decisions, slices and backlog: [JehutyPT/companion-surface-skaarhoj-rawpanel#1](https://github.com/JehutyPT/companion-surface-skaarhoj-rawpanel/issues/1). Read it before changing scope.

## Reference

- **Protocol** (commands, input events, topology, sleep, flow control, the PTZ Extreme HWC table): [docs/raw-panel-protocol.md](docs/raw-panel-protocol.md). Measured panel behaviour lives in [PTZJoystickControl `docs/skaarhoj-integration.md`](https://github.com/JehutyPT/PTZJoystickControl/blob/main/docs/skaarhoj-integration.md).
- **Surface API** (version compatibility, remote flow, layout, draw props, transfer variables, dev loading): [docs/surface-api-notes.md](docs/surface-api-notes.md).
- Upstream: bitfocus/companion-surface-api (tag `companion-surface-base-v1.4.1`), bitfocus/companion-surface-loupedeck (scaffold), bitfocus/companion-surface-elgato-stream-deck `src/remote.ts` (network pattern), SKAARHOJ/rawpanel-lib (protocol, has its own CLAUDE.md).

## Rules

- **Build from topology.** Read `PanelTopology?` and build the layout from it, positions from the physical coordinates. Classify controls by topology `in` type, never by hard-coded HWC id or model. Must work on any Raw Panel.
- **Analog controls are input transfer variables.** `iv`/`ih`/`ir`/`av`/`ah`/`ar` (rockers, joystick axes, faders, T-bars) are not layout controls. Declare one `transferVariables` entry (type `input`) per axis and send its numeric value with `context.sendVariableValue`: only on change past the axis's dead zone, coalesced to at most one send per interval per axis. Each axis has its own enabled switch (`analogEnabled_<hwc>`, default on; disabled sends nothing and is ignored plugin-side, since the panel can't be told to stop reporting it), dead zone (default 6 panel units, 0-100, 0 = off) and saturation (default full travel = off; 100-500 for `Speed`, 100-1000 for `Abs`), surface `configFields` `analogDeadband_<hwc>`/`analogSaturation_<hwc>` generated from the topology's axes; the interval (default 50 ms, 10-1000, `analogInterval`) is one field for all axes. All apply live; don't bake in tuning values a user would want to change. The value sent stays in the panel's range (`Speed` −500..500, `Abs` 0..1000) but is rescaled linearly: within the dead zone reads 0, at or past saturation reads full travel. No easing curves.
- **Four-way buttons are one key** (slice 1): any edge down is key down, all edges up is key up. Per-edge keys are backlog.
- **Be gentle with the panel.** Send diffs only, coalesce per HWC, pace the write queue, honour `BSY`. The panel has one queue shared by all clients.
- **Re-push on connect and wake.** The panel blanks LEDs and displays on connect: push full state on connect and on `_isSleeping=0`. Tolerate the stall (>300 ms) after connect and wake.
- **Panel settings are opt-in.** Send `SleepTimer=` or `PanelBrightness=` only when the user has set the matching option. Default is to leave the panel's settings alone.
- **Layout-affecting settings are remote connection `configFields`.** They arrive before `openSurface`; saving one reconnects.
- **Companion owns logic.** Keys, encoder turns and analog values go to Companion through `SurfaceContext`. The plugin holds no button logic of its own.

## Ask the user first

- Before connecting to the real panel (192.168.1.163:9923). Develop and test against a fake panel.
- Before sending the real panel any setting during testing: `Clear`, `ClearLEDs`, `ClearDisplays`, `encoderPressMode=`, `HeartBeatTimer=`, `PanelBrightness=`, `SleepMode=`, `SleepScreenSaver=`, `SleepTimer=`.

## Versions

`@companion-surface/base` is pinned `~1.4.1`, so the plugin needs Companion 5.1+ (5.0 accepts base ≤ 1.3 and refuses to load it). 1.4 API is available: `rotateById(id, delta)`, the `leds` style preset with `drawProps.leds`, and `drawProps.pressed`. Manifest runtime stays `node22` (engines `^22.21`); nothing in 1.4 needs node26.

## Conventions

- `package.json` scripts are the source of truth for build, lint and format. Yarn 4 via corepack (`corepack yarn …`).
- Commits are authored by the user alone: no `Co-Authored-By` trailers.
- Solo project: no PR process required; branch, commit, merge.
- Local dev: the Companion REST API URL and key are in `.env.local` (gitignored; `COMPANION_URL`, `COMPANION_API_KEY`, Bearer auth). It can press/rotate buttons at a location and read/set custom variables, but cannot create buttons or pages.

## Agent skills

### Issue tracker

GitHub issues on this repo, via `gh`; PRDs are parent issues, implementation tickets are sub-issues with formal blocked-by edges. External issues and PRs are not triage surfaces. See `docs/agents/issue-tracker.md`.

### Issue labels and readiness

`prd` for parents, `bug` or `enhancement` for tickets, `ready-for-agent` applied last to a validated contract with no open blockers. See `docs/agents/issue-labels.md`.

### Implementation contracts

A ticket's `## Implementation Contract` section is its sole implementation authority. See `docs/agents/implementation-contract.md`.

### Domain docs

Single context: root `GLOSSARY.md` and `docs/adr/`. See `docs/agents/domain.md`.
