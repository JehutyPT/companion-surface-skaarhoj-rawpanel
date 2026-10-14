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
2. The plugin connects, then emits `surfacesConnected([{ surfaceId, deviceHandle, description, pluginInfo }])`.
3. The host may call `rejectSurface(info)` if declined or the id is already open.
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
- No absolute-value input (faders). Not needed: the joystick belongs to PTZJoystickControl.

## Loading a dev build into Companion

1. `yarn install && yarn build` (or `yarn dev` to watch). Companion hot-reloads.
2. Companion launcher → cog → Developer: set the developer modules folder to the **parent** of this repo's folder and enable "Enable Developer Modules". Headless: `--extra-module-path` or `COMPANION_DEV_MODULES`.
3. Surfaces → settings panel → "Add Surface Integration" → pick the dev version.
4. Surfaces → Remote Surfaces → add a connection with address and port.

Keep `@companion-surface/base` in `dependencies`: Companion's scanner reads the dev apiVersion from `node_modules/@companion-surface/base/package.json`, which is why `apiVersion: "0.0.0"` and `entrypoint: "../dist/main.js"` work in dev. `yarn package` builds a `.tgz` for offline import.

Surface plugins get no Node `--permission` flags, so raw TCP needs nothing in the manifest.
