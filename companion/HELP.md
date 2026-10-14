## SKAARHOJ Raw Panel

Use a SKAARHOJ Raw Panel as a Companion surface. Needs Companion 5.1 or later.

Built and tested on the SK_PTZEXTREMEV2. Other Raw Panels may work, since the layout comes from the panel, but they are untested.

This plugin is in development. This page grows as features ship.

### Setup

1. Make sure the panel is reachable on your network and its Raw Panel server is enabled (TCP port 9923).
2. In Companion, go to **Surfaces** → **Remote Surfaces** and add a connection for SKAARHOJ Raw Panel.
3. Enter the panel's IP address and port `9923`.

The panel appears as a surface named after its model. Its button grid follows the panel's physical layout, read from the panel when it connects. A control alone in its row joins the nearest row, and a run of controls of the same kind (such as a row of knobs) takes neighbouring columns with no gaps.

### Controls

- Buttons are keys. Four-way buttons act as a single key: pressing any edge presses the key.
- Encoders rotate left and right. Pushing an encoder presses its key.
- Button LEDs show the button colour. The panel has 64 colours, so colours are approximated. Black turns the LED off.
- While a button is pressed in Companion, its LED dims, or lights white if the button has no colour.
- Controls without an LED or display (on the PTZ Extreme: Iris, Focus and the joystick button) work as inputs and show no feedback.
- Controls with a display show the button text: one line large, or the first two lines small (type `\n` for a line break). Displays show plain ASCII only. At the default size one line fits about 11 characters on the 64×32 button displays and about 19 on the 112×32 knob displays; long text is cut.
- Joysticks, rockers and faders are input variables, not buttons. See below.

### Joystick, zoom rocker and faders

Each analog axis sends the panel's raw value to a Companion custom variable: -500 to 500 for joysticks and rockers (0 at rest), 0 to 1000 for faders and T-bars. By default values are sent at most 20 times a second per axis and ignore tiny jitter (a joystick resting a few steps off centre reads 0); both are adjustable (see Analog tuning below). Values always end on the final value, including the return to 0. If the connection drops, joysticks and rockers are set back to 0.

The plugin can't create these variables or preselect them in the surface settings, so set them up once:

1. In **Variables** → **Custom Variables**, create one variable per axis. Suggested names on the PTZ Extreme: `skaarhoj_zoom` (zoom rocker), `skaarhoj_lr` (joystick left-right), `skaarhoj_ud` (joystick up-down), `skaarhoj_rotate` (joystick rotate). Turn **persist value** off: the values change many times a second.
2. In **Surfaces**, open the panel's settings. Each axis is listed by name (for example "4-Axis Joystick, Left-Right (HWC 60)"); pick the custom variable for it.
3. Use the variables in triggers, expressions or actions, for example to drive a PTZ camera.

While the surface is locked, axis moves are ignored, but the return to 0 still gets through.

#### Analog tuning

In **Surfaces**, the panel's settings have two fields for the analog axes. Changes apply at once, without reconnecting:

- **Analog dead zone** (default 6, 0 to 100): in panel steps. A change smaller than this is not sent, and a joystick or rocker this close to centre reads 0. Full travel (±500, or 0 and 1000 on a fader) and the return to centre always get through. 0 turns the dead zone off and sends every change. Raise it if a joystick at rest keeps sending values; lower it for finer control.
- **Analog send interval (ms)** (default 50, 10 to 1000): the shortest time between two values sent for one axis. Faster moves are combined, always ending on the latest value. 50 ms is about 20 times a second, which matches how often Companion reacts to variable changes; 10 is the fastest.

### Connection

- If the connection drops, the plugin reconnects on its own and restores every LED and display. It does the same when the panel wakes from sleep.

### Panel settings

By default the plugin leaves the panel's own settings alone. In **Surfaces**, the panel's settings offer two options:

- **Panel sleep timeout**: "Leave the panel's setting" (default), or a timeout from 1 minute to 4 hours, or Never. The plugin sends it on every connect, because the panel resets it to 4 hours when it restarts. Never sleeping risks burn-in on the displays.
- **Set panel brightness from Companion** (off by default): when on, the surface's Brightness slider sets the panel's LED and display brightness (the panel has 9 levels, 0 to 8). When off, the slider does nothing.

Switching an option back to its default stops the plugin sending it, but does not undo what it already set on the panel; change it back on the panel or pick the value you want.
