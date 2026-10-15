# Raw Panel ASCII v1: protocol notes

Reference for talking to a SKAARHOJ Raw Panel in server mode (TCP 9923). The plugin targets any Raw Panel; measured details come from the first test panel, an SK_PTZEXTREMEV2 on UniSketch v2.5.27. Compiled 2026-10-13 from primary sources; nothing here was re-measured.

Provenance tags:

- **[HW]** measured on the real panel: [PTZJoystickControl `docs/skaarhoj-integration.md`](https://github.com/JehutyPT/PTZJoystickControl/blob/main/docs/skaarhoj-integration.md)
- **[DC]** legacy manual `SKAARHOJ/Support` `Manuals/DC_SKAARHOJ_RawPanel.pdf`
- **[V2]** `Manuals/SKAARHOJ/SKAARHOJ_RawPanel_V2.pdf`
- **[LIB]** [SKAARHOJ/rawpanel-lib](https://github.com/SKAARHOJ/rawpanel-lib) (`converterFunctions.go`, `converter_segments.go`, `topology/topology.go`, `gorwp/rawpanel.go`)
- **[MOD]** bitfocus/companion-module-skaarhoj-rawpanel `src3/` (unmaintained; reference only)
- **[C#]** PTZJoystickControl `SkaarhojPanel/*.cs` (`SkaarhojPanelLink`, `LineFramer`, `RawPanelParser`)

## Framing

- ASCII lines terminated by `\n`. Strip a trailing `\r`. Buffer partial lines across TCP chunks.
- Inbound topology lines are tens of kB: allow at least 1 MiB per line [C#].
- Replies of the form `_key=value`: split on the **first** `=` only (topology values contain `=`).
- ASCII v1 addresses one HWC per line; comma lists are V2 only.

## Connecting

- Server mode needs no handshake [DC]. `ActivePanel=1` and answering the panel's `list` are client-mode only.
- On connect the panel sends `RDY` and one `map=<id>:<id>` per input HWC [HW]. `RDY` is not always first, and a second client gets `map=` but no `RDY`. Every new connection re-sends `map=` to all clients. Accept `map=` at any time; never wait for `RDY`.
- Captured 2026-10-14 (v2.5.27, another client connected): no `RDY`; the `list` reply (`_model`, `_serial`, `_version`, `_bluePillReady`) came ~20 ms after connect, then the `map=` lines, then the topology at ~110 ms with no stall. The panel sent no `ping`s of its own over 60 s. The `_panelTopology_svgbase` line was ~3 kB.
- On connect the panel **blanks all LEDs and displays** and hands them to the client; it restores its own lights on disconnect [HW]. Push full state on every connect.
- The panel reports no current control state. Start every axis at 0.
- The panel stalls ~0.4–0.5 s after every connect: `ack`s to pings sent then arrive 420–530 ms late [HW]. Allow ~1 s grace before any dead-man applies.
- If the panel sends `ping`, answer `ack` [LIB].

Recommended order:

1. Connect.
2. `list` → `_model=SK_PTZEXTREMEV2`, `_serial=…`, `_version=v2.5.27`, `_bluePillReady=0` [HW]. Does not return the HWC map on this firmware.
3. `PanelTopology?`
4. Panel-setting options, only if the user set them: `SleepTimer=<ms>`, `PanelBrightness=` (see Sleep and Panel-wide).
5. Push all LED and display state.
6. `ping` periodically; treat a missing `ack` as link loss.

Optional: `Connections?` → `_connections=<ip>;<ip>;…` [C#].

### Link loss and multiple clients

- With the cable pulled, the OS reported no socket error for ~10 s [HW]. Detect loss only by `ping`/`ack` timeout. Round trip 1.4–18 ms, median 12.5 ms.
- [C#] reference: ping every 100 ms, dead-man 300 ms (after 1 s grace), reconnect backoff 1 s doubling to 30 s, connect timeout 2 s, backoff resets only after an `ack`.
- Up to 7–8 clients. Every client gets every input event; replies go only to the asker; LEDs and displays are shared, last writer wins [HW].
- A client flooding the panel delayed another client's `ack`s past 300 ms [HW]. The panel has one queue: flooding slows input and `ack`s for every client. Rate-limit writes (see Flow control).
- `HeartBeatTimer=<ms>` makes the panel ping the client and drop it after 2 s silence [V2]. Not verified on v2.5.27. It is a panel setting: ask the user before sending it.

## Output commands (client → panel)

Commands get no reply; unknown commands get `nack` [DC].

### LED state: `HWC#<id>=<n>`

- Bits 0–3: `0` off, `4` on, `5` dimmed (`1`/`2`/`3` are legacy amber/red/green).
- Bit 4: legacy blink (single-colour buttons). Bit 5 (32): output/relay bit.
- Bits 8–11: blink mask against the ms clock. `0001` ≈ 4 Hz, `1000` ≈ 0.5 Hz. `HWC#3=260` blinks fast [HW].
- On is `4` [HW-verified] or `36` [DC][MOD]; the PTZ Extreme has no relays, so both work.

### LED colour: `HWCc#<id>=<n>`

- Indexed: `128 + idx`. 0 default, 1 off, 2 white, 3 warm white, 4 red, 5 rose, 6 pink, 7 purple, 8 amber, 9 yellow, 10 dark blue, 11 blue, 12 ice, 13 cyan, 14 spring, 15 green, 16 mint. Red: `HWCc#1=132`.
- RGB: `192 + (r<<4 | g<<2 | b)` with each channel **2 bits (0–3)**: only 64 colours. Quantise Companion's RGB.
- Colour applies to the on and dimmed states. Send colour and state together [HW]: `HWCc#1=132` + `HWC#1=4` is bright red; `HWCc#2=143` + `HWC#2=5` is dimmed green.

### Display text: `HWCt#<id>=<fields>`

Pipe-separated fields, in order:

`value|format|icon|title|isLabel|line1|line2|value2|pairMode|scaleType|rangeLo|rangeHi|limitLo|limitHi|img|fontFace|fontSize|advanced|inverted|pixelColor|bgColor`

Limits [DC]:

- Whole string at most 63 chars.
- ASCII 32–126 only. `|` cannot be escaped. No newlines. Sanitise all Companion text.
- Title and each line up to 24 chars.

Renderings:

| Goal | Command | Status |
|---|---|---|
| One big line, no title bar | `HWCt#1=1\|10\|\|CAM 1` (field 0 = size 1–4) | [HW] |
| Two lines, no title bar | `HWCt#46=1\|11\|\|\|1\|Line one\|Line two` (field 0 = size 1–2) | [HW] |
| Title bar + lines | `HWCt#x=\|\|\|Title\|1\|Line1\|Line2` | [DC][MOD], untested here |
| Title bar + big line1 | `\|\|\|Title\|1\|Line1`; append `\|\|0` for small | [DC], untested |
| Value + title | `HWCt#2=1234\|0\|\|Value\|0` | [HW] |
| Clear one display | `HWCt#x=\|\|\|\|\|\|` | [MOD] |

- `isLabel` 0/empty gives a solid title bar ("state"); 1 gives a thin underline ("label").
- Empty value with format 0 hides the value (lib sets format 7).

Display sizes on this panel [HW]: 64×32 on the buttons, 112×32 on the knobs. Captured 2026-10-14: on a 64×32 button display, one line at the default size shows about 11 characters (`ABCDEFGHIJK` of `ABCDEFGHIJKLMNOP`). On a 112×32 knob display, one line at the default size shows 19 characters (`ABCDEFGHIJKLMNOP123`). Monochrome bitmaps exist (`HWCg#id=0/<last>,<w>x<h>:<b64>`, lines under ~250 chars) but are untested here.

### Panel-wide (panel settings)

`Clear`, `ClearLEDs`, `ClearDisplays`, `PanelBrightness=<leds>,<oleds>` (0–8), `DimmedGain=<0..64>`, `encoderPressMode=`, `HeartBeatTimer=`, `SleepMode=`, `SleepScreenSaver=`.

- The plugin sends none of these by default. `PanelBrightness=` is an opt-in option tied to Companion's brightness (`setBrightness` 0–100 mapped to 0–8).
- During testing, ask the user before sending any of them to the real panel.

## Input events (panel → client)

Regex [LIB]: `^HWC#([0-9]+)(|.([0-9]+))=(Down|Up|Press|Abs|Speed|Enc)(|:([-0-9,]+))$`

- **Buttons:** `HWC#63=Down` / `HWC#63=Up`, no auto-repeat [HW]. An `Up` without a `Down` happens after a wake press.
- **Four-way buttons:** `HWC#<id>.<edge>=Down|Up`, edge 1 top, 2 left, 4 bottom, 8 right. No centre event: a centre press reports whichever edge closes first [HW]. Slice 1 treats the HWC as one key: track pressed edges, first edge down = key down, last edge up = key up after the release debounce (a surface setting, default 30 ms, 0 = off; an edge down within it continues the same press, since a centre press can briefly release every edge). Per-edge keys are backlog.
- **Encoders:** `HWC#<id>=Enc:1` / `Enc:-1`, clockwise positive, one line per detent (as close as ~17 ms) [HW].
- **Encoder push:** a single `HWC#<id>=Press`, no Down/Up [HW]. [DC] says `Press` repeats after 1 s hold. With `_bluePillReady=1` pushes become Down/Up [V2]. Handle both forms.
- **Intensity (joystick, rocker):** `HWC#<id>=Speed:<-500..500>` from `iv`/`ih`/`ir`, on change up to ~20 Hz, normally ending `Speed:0` [HW]; the joystick rotate axis can come to rest a few units off 0 (the joystick capture ends on `HWC#62=Speed:-3`), which the plugin reads as 0 (intensity values within its deadband of 0 count as 0; the deadband is a surface setting, default 6). On the PTZ Extreme: HWC 58, 60, 61, 62. Exposed as analog input variables.
- **Absolute (fader, T-bar):** `HWC#<id>=Abs:<0..1000>` from `av`/`ah`/`ar`. The PTZ Extreme has none. Exposed as analog input variables.
- **No way to stop input reporting** [LIB]: the command set (`tools/rwp-converter/main.go`, the `Command` and `HWCState` messages in `ibeam_rawpanel`) has nothing that disables an HWC's input events or analog sampling. `map=<hwc>:<n>` is panel → client only, and `HWCrawADCValues#<id>=0|1` only adds or removes extra `Raw:` events. Every client gets every event anyway, so such a command would also affect other clients (PTZJoystickControl reads the same joystick). A client that doesn't want an axis ignores its events.
- Other unsolicited lines: `_isSleeping=0|1`, `map=`, `BSY`, `RDY`, `ping`.

## Topology (`PanelTopology?`)

Reply is two lines [HW][DC]:

- `_panelTopology_svgbase=<svg…>`
- `_panelTopology_HWC={json}` with `HWc: [{id, x, y, txt, type, typeOverride?}]` and `typeIndex: {"<type>": {w, h, in, out, ext, desc, disp: {w, h, type?, subidx}, sub: […]}}`

Rules:

- Merge `typeOverride` over `typeIndex[type]` per HWC [LIB `GetTypeDefWithOverride`]. ([MOD] ignores it, so its display sizes are wrong.)
- Coordinates are 1/10 mm. `txt` may contain `|` for a two-line label.
- Type 0, or no `map=` for the HWC, means unused.
- Topology can differ between connects or be pushed mid-session [V2]. Cache by serial, not model.

Classifying a control (split `in` on `,`):

| `in` | Kind |
|---|---|
| `b`, `b4`, `b2h`, `b2v` | button (`b4` = four-way) |
| `pb` | encoder with push |
| `p` | encoder, no push |
| `av`, `ah`, `ar` | absolute (fader, T-bar): analog input variable |
| `iv`, `ih`, `ir` | intensity (joystick, rocker): analog input variable |

Classify by `in`, not by id. Analog kinds become `transferVariables`, not layout controls.

`disp` present means a display (`disp.type` `gray`/`color` = more than 1-bit). `out` of `rgb`/`rg`/`mono` means an LED.

### PTZ Extreme HWC list [HW, from topology]

The first test panel. The plugin builds its layout from topology, so this table is a reference, not a hard-coded map.

58 entries: 51 inputs plus 64–70 as layout placeholders (type 250). Ids 25–36 don't exist.

| HWC | What | Type | `in` |
|---|---|---|---|
| 1–12 | Cam1–12, four-way, RGB, 64×32 display | 133 | `b4` |
| 13–24 | X1–12, same | 133 | `b4` |
| 37–45, 54–56 | A1–A12, same | 134 | `b4` |
| 46–53 | Knob A–H, encoder with push, RGB, 112×32 display | 18 | `pb` |
| 57 | Iris encoder | 16 | `pb` |
| 59 | Focus encoder | 16 | `pb` |
| 58 | Zoom rocker | 104 | `iv` |
| 60 | Joystick LR | 96 | `ih` |
| 61 | Joystick UD | 97 | `iv` |
| 62 | Joystick rotate | 98 | `ir` |
| 63 | Joystick top button | 99 | `b` |

Types 16 (Iris, Focus) and 99 (top button) have no `out`: no LED. Types 16 and 96–99 give only `w` (round), no `h`. 60–63 share one position (3280, 526).

Captured 2026-10-14: `Down`/`Up` with edges 1/2/4/8 on the four-way buttons (one edge at a time); plain `HWC#63=Down`/`Up`; `HWC#n=Enc:±1..3` and `HWC#n=Press` on 46, 57 and 59; `HWC#58=Speed:-500..500`; `HWC#60/61/62=Speed:<n>` interleaved. Every input type on the panel was exercised.

## Flow control

- `BSY`: the panel can't keep up. Hold writes until `RDY` or a panel `ping` [DC].
- No safe write rate is documented. The panel has one queue, so flooding slows input and `ack`s for every client [HW].
- Policy: send diffs only, coalesce repeated updates to the same HWC, pace the queue, honour `BSY`, re-push full state on connect and wake.

## Sleep [HW unless tagged]

- `SleepTimer=<ms>` (0 = never) echoes `_sleepTimer=<ms>`. `SleepTimer?` queries.
- The timer is global, survives client disconnect, resets to 14400000 (4 h) on reboot. The plugin sends it only when the sleep-timeout option is set, and then on every connect and wake (with the rest of the full-state push).
- The panel pushes `_isSleeping=1` / `_isSleeping=0` to all clients.
- `ping` does not keep it awake; joystick movement does. While asleep the joystick sends nothing.
- A button press wakes it, but its `Down` may be lost.
- Waking stalls the panel >300 ms: apply grace again.
- Changing `SleepTimer` while asleep wakes it.
- [DC][V2]: the map may be zeroed on sleep (`map=<id>:0`) and restored on wake. Treat as availability hint, not removal. Not observed on this panel.
- On `_isSleeping=0`, re-send every LED and display.
- OLED burn-in isn't covered by warranty: weigh before `SleepTimer=0`.

## What the plugin sends

Implemented in `src/protocol.ts`, `src/connection.ts`, `src/instance.ts` and `src/settings.ts`:

- Connect: `list`, `PanelTopology?`, then every control's LED (where it has an `out`) and display (where it has a `disp`). No topology within the timeout, unparseable topology, or a topology with no button or encoder fails the connection with a logged error and retries with backoff; there is no built-in layout.
- LED: black or no colour → `HWC#n=0`. Otherwise `HWCc#n=<rgb>` then `HWC#n=4`. Pressed: dimmed (`5`) in the button colour, or `HWCc#n=130` (white) + `4` if the button has no colour.
- Text, display controls only (sanitised to ASCII 32–126 without `|`, 24 chars per line, whole command ≤ 63 chars):
  - empty → `HWCt#n=||||||`
  - one line → `HWCt#n=1|10||<line>`
  - two or more lines → `HWCt#n=1|11|||1|<line1>|<line2>` (line 2, then line 1, cut to fit).
  - Companion passes typed escapes literally; like its renderer, `\n` and `\r` break the line and `\t` is a space.
- Liveness: `ping` every second; any inbound line counts as alive; 5 s of silence drops the link. Reconnect backoff 1 s doubling to 30 s, reset by a received topology.
- Writes: per-key (`HWC#n`, `HWCc#n`, `HWCt#n`) diffs and coalescing, up to 8 lines every 20 ms with a leading edge (a write to a queue idle for 20 ms goes out on the next timer turn rather than after a full 20 ms; anything more waits out the interval), held on `BSY` until `RDY`, a panel `ping`, or 1 s without either (the panel sent neither in the 2026-10-14 captures, so the hold must not depend on them). `ping`, `ack`, `list` and `PanelTopology?` bypass the queue.
- Panel settings only when opted in (`src/settings.ts`): `SleepTimer=<ms>` when the sleep timeout is set, `PanelBrightness=<l>,<l>` (`l = round(percent / 100 × 8)`) when the brightness link is on. Both go first in every full-state push (connect, wake) and when the setting or Companion's brightness changes. With defaults, neither is ever sent.

Layout (`src/topology.ts`): buttons and encoders become controls `hwc/<id>`. The rules are generic over the topology; nothing depends on a model or an HWC id. In order:

1. Columns and rows are ranks of x and y: taken in order, a control shares the current column (row) when its centre is within half the larger of its own width (height) and that of the column's first control; `h` falls back to `w`.
2. A control alone in its row joins the nearest row that holds more than one control, by distance from its y to the row's mean y (the upper row on a tie). If no row holds more than one control, nothing moves. Rows are then renumbered without gaps.
3. Each control takes its ranked column; on an occupied cell it moves right to the next free column. Controls that joined another row are placed after the rest, on the nearest free column to their ranked one (right first on a tie).
4. Within a row, taken in column order, a control of the same topology type as its left neighbour takes the column right after it. Runs of one type on a wider pitch than the global columns (knobs among buttons) so lose their gaps, while a control of another type keeps its column and ends the run. This only moves controls left and never past another control, so it cannot collide, and rows whose runs already sit on consecutive columns are unchanged. "Same type" is the topology `type` id; a control with a `typeOverride` is a type of its own. Only layout controls count as neighbours: an analog or placeholder control between two buttons does not split their run.

Style presets: `default` (LED colour), `display` (colour and text), `text` (display, no LED), `none` (neither).

On the PTZ Extreme this gives (HWC ids; `.` is an empty cell):

```
 54 55 56 46 47 48 49 50 51 52 53  .  .  .  .  . 63
  .  .  .  .  . 37 38 39 40 41 42 43 44 45  .  .  .
  .  .  .  . 57 13 14 15 16 17 18 19 20 21 22 23 24
  .  .  . 59  .  1  2  3  4  5  6  7  8  9 10 11 12
```

Iris (57) is alone between the A and X rows and joins the X row (162 from it in y, against 177 from the A row).

## Defects in companion-module-skaarhoj-rawpanel to avoid

1. No line buffering; topology reassembled by an `endsWith('}}}')` hack.
2. Switches on whole chunks, so `ack` is only seen when alone in a chunk.
3. No ping/ack dead-man (ping every 5 s, never times out).
4. Sleep detection compares an array to a string: never fires.
5. Fake pacing: `sendCommand` awaits 50 ms but callers don't await. No `BSY` handling.
6. Re-sends all state every 30 s instead of on connect/wake.
7. Unsanitised text: `|` and non-ASCII corrupt fields.
8. Ignores `typeOverride`.
9. Sends joystick `Speed` to Companion as key presses; loses encoder direction.
10. Sends `encoderPressMode=1` on connect.
