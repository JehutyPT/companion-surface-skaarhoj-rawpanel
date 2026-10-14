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

Display sizes on this panel [HW]: 64×32 on the buttons, 112×32 on the knobs. Monochrome bitmaps exist (`HWCg#id=0/<last>,<w>x<h>:<b64>`, lines under ~250 chars) but are untested here.

### Panel-wide (panel settings)

`Clear`, `ClearLEDs`, `ClearDisplays`, `PanelBrightness=<leds>,<oleds>` (0–8), `DimmedGain=<0..64>`, `encoderPressMode=`, `HeartBeatTimer=`, `SleepMode=`, `SleepScreenSaver=`.

- The plugin sends none of these by default. `PanelBrightness=` is an opt-in option tied to Companion's brightness (`setBrightness` 0–100 mapped to 0–8).
- During testing, ask the user before sending any of them to the real panel.

## Input events (panel → client)

Regex [LIB]: `^HWC#([0-9]+)(|.([0-9]+))=(Down|Up|Press|Abs|Speed|Enc)(|:([-0-9,]+))$`

- **Buttons:** `HWC#63=Down` / `HWC#63=Up`, no auto-repeat [HW]. An `Up` without a `Down` happens after a wake press.
- **Four-way buttons:** `HWC#<id>.<edge>=Down|Up`, edge 1 top, 2 left, 4 bottom, 8 right. No centre event: a centre press reports whichever edge closes first [HW]. Slice 1 treats the HWC as one key: track pressed edges, first edge down = key down, last edge up = key up. Per-edge keys are backlog.
- **Encoders:** `HWC#<id>=Enc:1` / `Enc:-1`, clockwise positive, one line per detent (as close as ~17 ms) [HW].
- **Encoder push:** a single `HWC#<id>=Press`, no Down/Up [HW]. [DC] says `Press` repeats after 1 s hold. With `_bluePillReady=1` pushes become Down/Up [V2]. Handle both forms.
- **Intensity (joystick, rocker):** `HWC#<id>=Speed:<-500..500>` from `iv`/`ih`/`ir`, on change up to ~20 Hz, always ending `Speed:0` [HW]. On the PTZ Extreme: HWC 58, 60, 61, 62. Exposed as analog input variables.
- **Absolute (fader, T-bar):** `HWC#<id>=Abs:<0..1000>` from `av`/`ah`/`ar`. The PTZ Extreme has none. Exposed as analog input variables.
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

Only 1, 46 and 57–63 were physically tested.

## Flow control

- `BSY`: the panel can't keep up. Hold writes until `RDY` or a panel `ping` [DC].
- No safe write rate is documented. The panel has one queue, so flooding slows input and `ack`s for every client [HW].
- Policy: send diffs only, coalesce repeated updates to the same HWC, pace the queue, honour `BSY`, re-push full state on connect and wake.

## Sleep [HW unless tagged]

- `SleepTimer=<ms>` (0 = never) echoes `_sleepTimer=<ms>`. `SleepTimer?` queries.
- The timer is global, survives client disconnect, resets to 14400000 (4 h) on reboot. The plugin sends it only when the sleep-timeout option is set, and then on every connect.
- The panel pushes `_isSleeping=1` / `_isSleeping=0` to all clients.
- `ping` does not keep it awake; joystick movement does. While asleep the joystick sends nothing.
- A button press wakes it, but its `Down` may be lost.
- Waking stalls the panel >300 ms: apply grace again.
- Changing `SleepTimer` while asleep wakes it.
- [DC][V2]: the map may be zeroed on sleep (`map=<id>:0`) and restored on wake. Treat as availability hint, not removal. Not observed on this panel.
- On `_isSleeping=0`, re-send every LED and display.
- OLED burn-in isn't covered by warranty: weigh before `SleepTimer=0`.

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
