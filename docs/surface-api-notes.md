# Companion surface API notes (`@companion-surface/base` 1.4)

Compiled 2026-10-13 from bitfocus/companion-surface-api at tag `companion-surface-base-v1.4.1`, host `companion-surface-host-v1.4.2`, Companion v5.1.0 source, and the bitfocus/website surface-development docs. Where the docs and the source disagree, the source wins.

## Version compatibility

Companion only loads plugins whose base version is at most its own (`shared-lib/lib/ModuleApiVersionCheck.ts`):

| Companion | Max base | Node runtimes |
|---|---|---|
| 4.3.x | 1.2 | node18, node22 |
| 5.0.x | 1.3 | node18, node22, node26 |
| 5.1.x | 1.4 | node18, node22, node26 |

- **Base 1.3 needs Companion 5.0+, not 4.3.** The website `api-changes` page ("v1.3 → v4.3+") and issue #1 are wrong; the base README and Companion source agree on 5.0.
- We pin `~1.4.1`, so the plugin needs **Companion 5.1+**; 5.0 refuses to load it.
- Manifest runtime `node22`. Base 1.4.1 engines are `^22.21 || ^26.5`, `@companion-module/tools` 3.1 is `^22.18`, nothing in 1.4 needs node26, and the 1.4 manifest schema only accepts `node22` or `node26`. `companion-surface-build` writes `runtime.apiVersion` from the installed base version (`1.4.1`).

## Reference repos

- **bitfocus/companion-surface-loupedeck**: scaffolding, build and lint config (on base `~1.3.0`).
- **bitfocus/companion-surface-elgato-stream-deck** `src/remote.ts`: the TCP remote pattern. Same base (1.4) but node26; we stay on node22.
- `companion-surface-template-ts` does not exist (404), though base's README links it.

## Plugin shape

`src/main.ts` must `export default` a `SurfacePlugin<TInfo>`: `init()`, `destroy()`, `openSurface(surfaceId, pluginInfo, context)`, and `remote` for network devices. Emit no remote events before `init()` resolves; they are lost.

## Remote (network) flow

1. Companion calls `remote.startConnections([{ connectionId, config }])`. It calls it again with the same `connectionId` when config is edited.
   Here `src/connection-settings.ts` owns the connection `configFields` (address, port, control positions) and `checkConfigMatchesExpression`, and reads each connection's config through `parseConnectionSettings`: valid connection settings (trimmed address, port defaulting to 9923 and rejected outside 1–65535, control map, link key, control-position warnings) or a rejection, which stops whatever link the connection held. `src/remote.ts` only ref-counts links per link key and queues announcements until `init`.
2. The plugin connects, then emits `surfacesConnected([{ surfaceId, deviceHandle, description, pluginInfo }])`.
3. The host may call `rejectSurface(info)` if declined or the id is already open. This plugin then announces the surface again with a fresh `deviceHandle` after a backoff (1 s doubling, at most five times in a row; then not until the panel reconnects), so a connection removed and re-added before Companion closed the old surface comes back once it has. Rejections of a stale `deviceHandle` are ignored.
4. Otherwise it calls `openSurface(...)`, then `surface.init()`.

Elgato's pattern:

- `surfaceId` stable (`streamdeck:${serial}`); `deviceHandle` fresh per connect (`nanoid()`).
- `pluginInfo` carries the live connection.
- Ref-counts connections by `address:port`; an edited config is a decrement plus an increment, so unrelated edits don't reconnect.
- `configFields`: `address` (textinput), `port` (number 1–65535). `checkConfigMatchesExpression: '$(objA:address) == $(objB:address) && $(objA:port) == $(objB:port)'`.
- No remote "surfaces removed" event exists in 1.4 (`surfacesRemoved` is commented out): drop a surface with `context.disconnect(err)`.

## Layout is fixed at `openSurface`

- The layout is returned once, in `registerProps.surfaceLayout` from `openSurface()`. There is no API to re-register it.
- So read `PanelTopology?` before emitting `surfacesConnected` (or inside `openSurface`, which is async) and build the layout from it.
- To change layout later: `context.disconnect(err)` and re-emit `surfacesConnected` with a new `deviceHandle`. `close()` must be idempotent.
- Settings that affect the layout (the custom `control → row/column` map) must be remote connection `configFields`: they arrive in `startConnections` before `openSurface`. Saving one reconnects. Surface `configFields` arrive via `updateConfig` after open, too late for layout.
- Here that is `controlMap` (`src/control-map.ts`, applied last in `buildLayout`). Its canonical form is part of the link key (`address:port|map`), so a changed map stops the old link (`disconnect('Connection removed')`) and starts a new one, which re-announces (and retries if Companion still holds the old surface); a re-save with only whitespace or separators changed does nothing. Two connection entries for one panel with different maps make two links to it, and Companion rejects the second surface (same id).

Layout types (1.4 derives them from the zod schema in `src/surface-layout-schema.ts`, re-exported from the root):

```ts
interface SurfaceSchemaLayoutDefinition {
	stylePresets: { default: SurfaceSchemaControlStylePreset; [k: string]: SurfaceSchemaControlStylePreset }
	controls: { [k: string]: { row: number; column: number; stylePreset?: string } } // int, >= 0
}
interface SurfaceSchemaControlStylePreset {
	bitmap?: { w: number; h: number; format?: 'rgb' | 'rgba' | 'bgr' | 'bgra' }
	text?: boolean
	textStyle?: boolean // not implemented by Companion 5.1
	colors?: 'hex' | 'rgb'
	leds?: { segments: number; mode: 'full-ring' | 'simple' } // 1.4
}
```

- The host runs `validateSurfaceLayout()` on the result of `openSurface()` and fails the open if it doesn't match. Call it in tests.
- Control ids must match `^[a-zA-Z0-9\-\/]+$`: no `_`, `.` or `:`. Use ids like `hwc/12` or `hwc/12/1`.
- `row`/`column` must be integers ≥ 0.
- Drawing a controlId not in the layout throws.

## Surface instance

```ts
interface SurfaceInstance {
	readonly surfaceId: string
	readonly productName: string
	init(): Promise<void>
	close(): Promise<void>
	updateConfig?(config: Record<string, any>): Promise<void>
	ready(): Promise<void>
	setBrightness(percent: number): Promise<void> // 0-100
	blank(): Promise<void>
	draw(signal: AbortSignal, drawProps: SurfaceDrawProps): Promise<void>
	onVariableValue?(name: string, value: any): void
	showStatus(signal: AbortSignal, cardGenerator: CardGenerator, statusMessage: string): Promise<void> // required; docs omit it
}
```

Order after open: `showStatus` → `updateConfig` → `ready` → `draw`s. The host calls `blank()` before the first draw after a state change. Draws are skipped while locked.

`registerProps` also carries `brightness`, `pincodeMap` (null for none), `location` (the address), `configFields`, `transferVariables`, `canChangePage`.

Config field types (`input.d.ts`): `static-text` (`value: string`), `textinput`, `dropdown`, `number`, `checkbox`; all take `label`, `tooltip`, `description`, `isVisibleExpression`. The preset-page pointer is a `static-text` field; Companion 5.1.0 renders its `value` as sanitised Markdown (`webui/src/Controls/StaticTextField.tsx`, `parse()` then `sanitizeHtmlString`), so links work.

## What `draw()` receives (Companion 5.1.0 `PluginPanel.ts`)

```ts
interface SurfaceDrawProps {
	controlId: string
	pageNumber?: number
	image?: Uint8Array
	color?: string
	text?: string
	pressed: boolean // 1.4.1
	leds?: Uint8Array // 1.4, only if the style preset has `leds`
}
```

- **Text** (`text: true`): the button's resolved text, variables already substituted. `''` when empty. No truncation, no max length, may contain `\n`. We must sanitise, wrap and truncate for the panel (63-char command, 24 chars per line, ASCII only, no `|`).
- **Colour** (`colors: 'hex'`): background colour as `#rrggbb`. With `'rgb'` it arrives as `rgba(r,g,b,a)`. **Use `'hex'`.** Text colour, size and alignment are not sent.
- **`pressed`**: the button's pushed state (`style.state.pushed`), for pressed feedback on text-only displays.
- **`leds`**: packed RGB, 3 bytes per segment, `segments * 3` long, segment 0 first. Read it with `readLedColor(buffer, index)`; `colorToIntensity(color)` flattens to 0–255 (Rec.709) for monochrome LEDs. Declare `leds` only when `context.capabilities.supportsLeds` is true (Companion 5.1 sets it).

## Input (`SurfaceContext`)

`keyDownById`, `keyUpById`, `keyDownUpById`, `rotateLeftById`, `rotateRightById`, `changePage(forward)`, `sendVariableValue`, `disconnect(err)`, `isLocked`.

Rotation in 1.4:

```ts
rotateLeftById(controlId: string, amount?: number): void // |amount| steps left, default 1
rotateRightById(controlId: string, amount?: number): void // |amount| steps right, default 1
rotateById(controlId: string, delta: number): void // signed: negative = left; 0 is ignored
```

- Use `rotateById` with the panel's signed pulse count rather than one call per detent.

## Analog input (transfer variables)

Companion 5.1 has no analog input control type (bitfocus/companion#1708, open). Analog controls go through transfer variables instead:

```ts
interface SurfaceInputVariable {
	id: string
	type: 'input' // produced by the surface
	name: string
	description?: string
}
// registerProps.transferVariables?: Array<SurfaceInputVariable | SurfaceOutputVariable>
// context.sendVariableValue(variable: string, value: any): void
```

- One input variable per axis (`iv`/`ih`/`ir`/`av`/`ah`/`ar`), numeric value.
- Send only on change past a dead zone, coalesced to at most one send per interval per axis. Both are user settings here (below, the dead zone per axis); the default interval follows Companion's variable-trigger throttle (~20 Hz). Defaults and ranges: [HELP.md](../companion/HELP.md#analog-tuning).
- The surface settings show, per transfer variable, a dropdown of the user's existing custom variables, with no default. A plugin cannot create or preselect them, and page exports don't include custom variables. So tooltips and HELP.md suggest names (`skaarhoj_zoom`, `skaarhoj_lr`, …) for the user to create once.
- Recommend "persist value" off on those custom variables; otherwise each change is a database write.

What the plugin does (`src/analog.ts`, `buildAxes` in `src/topology.ts`):

- Variable id `hwc_<n>`; name from the topology type's `desc`, else the HWC's `txt`, plus `(HWC n)` (e.g. `4-Axis Joystick, Left-Right (HWC 60)`). The description gives the range and suggests `skaarhoj_<txt>` (`skaarhoj_zoom`, `skaarhoj_lr`, `skaarhoj_ud`, `skaarhoj_rotate` on the PTZ Extreme), with `_<n>` added when two axes share a label and `skaarhoj_hwc_<n>` with no label.
- Linear rescale per axis, with dead zone `d` and saturation `s` (by default full scale `F`: 500 for `Speed`, 1000 for `Abs`), both measured as distance from 0: `|raw| <= d` reads 0, `|raw| >= s` reads `±F`, in between `sign(raw) * round(F * (|raw| - d) / (s - d))`, continuous at both edges. The output stays in the panel's range. Saturation exists because some axes stop a few steps short (e.g. -496 one way, 500 the other). With the defaults the ends still map to `±F` but mid-travel values shift by up to `d`.
- `d` is also the change threshold (hysteresis), applied to the rescaled value: smaller changes are not sent. 0 and the ends of travel (±500, or 0 and 1000) always bypass it, so the return to centre is never swallowed. `d = 0` sends every change. A consequence: the first move out of rest needs roughly `2d` raw steps before anything is sent. First change after an idle send interval goes out at once; later ones within the window collapse into one trailing send of the latest value.
- Nothing is sent before `ready()` (Companion 5.1 drops variable values sent before the surface is registered, logging "Received input variable value for unknown surface"). On `ready()` each enabled axis sends its current value: the latest the panel reported since `init()`, or 0 for an intensity axis (`Speed`) that reported none. Intensity axes also send 0 when the link drops and when the surface closes, so a camera never keeps moving on a stale value. Absolute axes (`Abs`) have no rest position and keep their value.
- While Companion is locked, non-zero values (including one already queued) are dropped but 0 still goes out (mirrors encoders, which are ignored while locked). Whether the host itself drops variable values while locked is unverified.
- The axes are part of the layout signature: transfer variables are fixed at open, like the layout.

## Surface settings (per-surface `configFields`)

The sleep timeout, the brightness link and the analog tuning are **surface** `configFields` (`registerProps.configFields`, delivered through `updateConfig`, called before `ready()` and on every edit), not remote connection fields. They don't affect the layout, and surface fields apply without reconnecting, whereas saving a remote connection field restarts the connection. They show in Companion under **Surfaces**, in the panel's surface settings. What each one does, its default and its range are in [HELP.md](../companion/HELP.md) (Analog tuning, Panel settings); these notes cover the API and implementation only. `src/settings.ts` owns every field (`surfaceConfigFields(layout.axes)`) and reads a config back into typed settings (`parseSurfaceSettings`: the panel settings and the analog tuning).

- **Panel sleep timeout** (`sleepTimer`, dropdown): default `panel` sends nothing. A choice in ms (0 = never) sends `SleepTimer=<ms>` at once, then with every full-state push (connect and wake), since the panel resets it to 4 h on reboot. A number field can't express "leave alone" (it needs a default and 0 already means never), hence the dropdown.
- **Set panel brightness from Companion** (`linkBrightness`, checkbox): when on, `setBrightness(percent)` sends `PanelBrightness=<l>,<l>` with `l = round(percent / 100 * 8)` (0 % is the panel's 0). Turning it on sends the last brightness Companion gave at once.
- **Analog send interval (ms)** (`analogInterval`, number), one for all axes, and per axis in the topology **`<axis name>`: enabled** (`analogEnabled_<hwc>`, checkbox), **`<axis name>`: dead zone** (`analogDeadband_<hwc>`, number) and **`<axis name>`: saturation** (`analogSaturation_<hwc>`, number, range on the axis's own scale). Field defaults come from the sender's own fallback in `src/analog.ts` (`defaultAxisTuning`, `DEFAULT_ANALOG_INTERVAL_MS`). Plugin-side only, nothing goes to the panel. Applied to the next analog value; a trailing send already queued keeps its time. Number fields' `min`/`max` are only a UI hint, so `parseSurfaceSettings` (`src/settings.ts`) rounds, clamps, and falls back to the default for a missing or non-numeric value; a saturation not above the dead zone falls back to full scale.
- A disabled axis sends nothing: turning it off drops its queued value and sends 0 once if it is a `Speed` axis Companion holds at non-zero (an `Abs` axis keeps its value), then its events are ignored, and `rest()` (ready, link drop, close) skips it. Its transfer variable stays declared, since transfer variables are fixed at open. With every axis disabled, `AnalogSender.input` returns at once and starts no timers. The panel keeps sending the events: Raw Panel ASCII v1 has no command to stop input reporting (see `docs/raw-panel-protocol.md`), so "disabled" is plugin-side only.
- `registerProps.brightness` is fixed at open, so it is always `true`: Companion shows its brightness slider even when the link is off, and then the slider does nothing.
- Going back to the defaults stops sending but does not restore the panel's previous values: the plugin never reads them.
- **PTZ Extreme preset page** (`presetPage`, static-text, first): Markdown with a link to `presets/ptz-extreme.companionconfig` on GitHub `main` (the blob page, so the user downloads the raw file there) and the import steps in short. The repo URL is also in package.json, manifest.json and HELP.md; a rename touches all four. Shown for every panel; the text names the model, since the plugin has no per-model code.

### The preset page file

`presets/ptz-extreme.companionconfig` is a byte-for-byte Companion 5.1 page export, kept outside `companion/` so `companion-surface-build` (which copies all of `companion/` into the package) doesn't ship it; the setting and HELP.md link to GitHub instead. To refresh it, export the page with secrets excluded and as plain JSON so diffs stay readable:

`GET <companion>/int/export/page/<page>?includeSecrets=false&format=json` (the web UI's own export route; `/int` needs no API key but only answers local or trusted hosts. `includeSecrets` defaults to true, `format` takes `json`, `json-gz` or `yaml`.)

Check that `instances` is `{}` and every `connectionId` is `internal`; `src/__tests__/preset.spec.ts` checks that, the page name, and that every custom variable it uses is listed in HELP.md. Importing a page grows Companion's grid to the page's `gridSize` (default grid is 4 × 8).

## Loading a dev build into Companion

1. `yarn install && yarn build` (or `yarn dev` to watch). Companion hot-reloads.
2. Companion launcher → cog → Developer: set the developer modules folder to the **parent** of this repo's folder and enable "Enable Developer Modules". Headless: `--extra-module-path` or `COMPANION_DEV_MODULES`.
3. Surfaces → settings panel → "Add Surface Integration" → pick the dev version.
4. Surfaces → Remote Surfaces → add a connection with address and port.

Keep `@companion-surface/base` in `dependencies`: Companion's scanner reads the dev apiVersion from `node_modules/@companion-surface/base/package.json`, which is why `apiVersion: "0.0.0"` and `entrypoint: "../dist/main.js"` work in dev. `yarn package` builds a `.tgz` for offline import.

Surface plugins get no Node `--permission` flags, so raw TCP needs nothing in the manifest.
