# SKAARHOJ Raw Panel surface

A Bitfocus Companion surface plugin that drives a SKAARHOJ Raw Panel over Raw Panel ASCII v1 (TCP 9923): keys, encoders, LEDs, display text and analog axes.

## Panel

**Raw Panel**:
A SKAARHOJ panel speaking the Raw Panel ASCII v1 protocol on TCP 9923. The SK_PTZEXTREMEV2 is the only tested one.
_Avoid_: device, controller, the PTZ Extreme (when any Raw Panel is meant)

**HWC**:
A hardware component: one physical control on the panel, identified by its HWC number (e.g. `HWC#37`).
_Avoid_: button id, control index

**Topology**:
The panel's own report of its HWCs (`_panelTopology_HWC`, the answer to `PanelTopology?`): each control's position, size, type, input (`in`) and output (`out`). The only source of what a panel has.
_Avoid_: model table, panel definition

**Control kind**:
How the plugin treats an HWC, classified from its topology `in` type: button, encoder, encoder with push, analog, none or unknown. Never from the HWC number or panel model.
_Avoid_: control type (that is the topology's `type`)

**Four-way button**:
A multi-edge button (`b2h`, `b2v`, `b4`) that acts as one key: any edge down is key down, all edges up is key up.

**BSY / RDY**:
The panel's flow-control replies: `BSY` asks the client to stop writing, `RDY` says it may resume. The panel has one command queue shared by all clients.

**Sleep / wake**:
The panel blanking itself after its sleep timer (`_isSleeping=1`) and coming back (`_isSleeping=0`). On wake, as on connect, every LED and display is blank.

## Companion side

**Surface**:
The Companion surface for one panel: a grid of layout controls plus analog axes, fixed when Companion opens it.
_Avoid_: device, instance (except for the `SurfaceInstance` class)

**Layout**:
The surface's grid of Companion controls (row and column per HWC), built from the topology's physical positions and the control positions. Analog axes are not part of it.
_Avoid_: button map

**Control positions**:
The user's optional `<hwc>=<row>/<column>` overrides of the layout, a connection setting. Parsed in code as the control map (`ControlMap`).
_Avoid_: custom layout

**Link**:
One panel at one `address:port` (`PanelLink`): it drives its connection and decides when Companion is told about the surface, absorbing reconnects to the same panel and layout.
_Avoid_: session

**Connection**:
The TCP connection to the panel (`PanelConnection`): framing, connect sequence, liveness and reconnect. It sends commands through its write queue. Not the Companion "remote connection" entry, which is a connection settings record.

**Write queue**:
The connection's queue of commands to the panel (`WriteQueue`): one pending line per key, the latest wins; a line equal to the last one sent for its key is dropped; at most one burst per write interval; held on `BSY` until `RDY`, a panel `ping` or a timeout. Emptied and forgotten on every connect and reconnect.
_Avoid_: send buffer, outbox

**Resync**:
Pushing the full desired state of every LED and display after the panel has blanked (connect, reconnect, wake).
_Avoid_: refresh, redraw

**Transfer variable**:
A Companion surface variable the plugin declares; each analog axis is one input transfer variable that the user binds to a custom variable.
_Avoid_: output variable, module variable

## Analog

**Axis**:
One analog dimension of a control (`iv`/`ih`/`ir`/`av`/`ah`/`ar`): a joystick direction, a rocker, a fader or a T-bar. Sent as a transfer variable, never a key.
_Avoid_: analog control (when one direction of a joystick is meant)

**Speed / Abs**:
An axis's mode, from the panel's input event. `Speed` axes (joysticks, rockers) run -500..500 with 0 at rest; `Abs` axes (faders, T-bars) run 0..1000. The plugin sends the panel's scale, not a normalised one.

**Full travel**:
An axis's end value: ±500 for `Speed`, 1000 for `Abs`.

**Dead zone**:
Per-axis setting, in panel steps from 0: a value this close to 0 reads 0, and a smaller change is not sent. Stored in the `analogDeadband_<hwc>` field and `deadband` in code; the stored id is kept.
_Avoid_: deadband (in prose)

**Saturation**:
Per-axis setting, in panel steps from 0: a value at or past it reads full travel. Between dead zone and saturation the value is rescaled linearly.

**Send interval**:
The shortest time between two sends for one axis (`analogInterval`); faster moves are coalesced, always ending on the latest value.
_Avoid_: throttle, rate

## Settings

**Surface settings**:
Per-surface Companion `configFields` (panel settings and analog tuning). Applied live, without reconnecting.

**Connection settings**:
Remote connection `configFields` (address, port, control positions). They arrive before Companion opens the surface, so saving one reconnects and rebuilds the layout.

**Panel settings**:
Settings stored in the panel itself (`SleepTimer=`, `PanelBrightness=`). Opt-in: the plugin sends one only when the user has set the matching surface setting.
