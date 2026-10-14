# AGENTS.md

A Bitfocus Companion **surface plugin** (TypeScript) that makes a SKAARHOJ Raw Panel, first the SK_PTZEXTREMEV2, a first-class Companion surface: buttons, encoders, LEDs, display text and the sleep timer, so it can replace Stream Decks. It talks Raw Panel ASCII v1 over TCP 9923 through the plugin's `remote` (`SurfacePluginRemote`).

Spec, decisions and history: [JehutyPT/companion-surface-skaarhoj-rawpanel#1](https://github.com/JehutyPT/companion-surface-skaarhoj-rawpanel/issues/1). Read it before changing scope.

## Reference

- **Protocol** (commands, input events, topology, sleep, flow control, the PTZ Extreme HWC table): [docs/raw-panel-protocol.md](docs/raw-panel-protocol.md). Measured panel behaviour lives upstream in [PTZJoystickControl `docs/skaarhoj-integration.md`](https://github.com/JehutyPT/PTZJoystickControl/blob/main/docs/skaarhoj-integration.md).
- **Surface API** (version compatibility, remote flow, layout, draw props, dev loading): [docs/surface-api-notes.md](docs/surface-api-notes.md).
- Upstream: bitfocus/companion-surface-api (tag `companion-surface-base-v1.4.1`), bitfocus/companion-surface-loupedeck (scaffold), bitfocus/companion-surface-elgato-stream-deck `src/remote.ts` (network pattern), SKAARHOJ/rawpanel-lib (protocol, has its own CLAUDE.md).

## The panel is shared

PTZJoystickControl is a second Raw Panel client on the same panel. It owns the joystick and stops the cameras if its 300 ms ping/ack dead-man trips. Every rule below protects it or the panel's settings:

- **Ignore intensity controls.** Topology `in` of `iv`/`ih`/`ir` (HWC 58 zoom, 60, 61, 62 joystick) is never declared as a surface control. Classify by topology type, not by hard-coded id. HWC 63 (the stick's top button) is an ordinary button and is ours.
- **Rate-limit every write.** Send diffs, coalesce per HWC, pace the queue, honour `BSY`. A flooded panel delays the other client's `ack`s.
- **Own the sleep timer.** Send `SleepTimer=1800000` on every connect (the panel resets it to 4 h on reboot). Re-push all LED and display state on connect and on `_isSleeping=0`. Tolerate the >300 ms stall after connect and wake.
- **Companion owns logic.** Key presses and encoder turns go to Companion through `SurfaceContext`. The plugin sets no Companion variables (in particular never `Joystick_Controlled_Camera`).

## Ask the user first

- Before connecting to the real panel (192.168.1.163:9923). Develop and test against a fake panel.
- Before sending any panel setting: `Clear`, `ClearLEDs`, `ClearDisplays`, `encoderPressMode=`, `HeartBeatTimer=`, `PanelBrightness=`, `SleepMode=`, `SleepScreenSaver=`, and `SleepTimer=` during testing. The shipped behaviour of sending `SleepTimer=1800000` is approved.

## Versions

`@companion-surface/base` is pinned `~1.4.1`, so the plugin needs Companion 5.1+ (5.0 accepts base ≤ 1.3 and refuses to load it). 1.4 API is available: `rotateById(id, delta)`, the `leds` style preset with `drawProps.leds`, and `drawProps.pressed`. Manifest runtime stays `node22` (engines `^22.21`); nothing in 1.4 needs node26.

## Conventions

- `package.json` scripts are the source of truth for build, lint and format. Yarn 4 via corepack (`corepack yarn …`).
- Commits are authored by the user alone: no `Co-Authored-By` trailers.
- Solo project: no PR process required; branch, commit, merge.
