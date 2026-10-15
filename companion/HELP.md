## SKAARHOJ Raw Panel

Use a SKAARHOJ Raw Panel as a Companion surface. Needs Companion 5.1 or later.

Built and tested on the SK_PTZEXTREMEV2. Other Raw Panels may work, since the layout comes from the panel, but they are untested.

This plugin is in development. This page grows as features ship.

### Setup

1. Make sure the panel is reachable on your network and its Raw Panel server is enabled (TCP port 9923).
2. In Companion, go to **Surfaces** → **Remote Surfaces** and add a connection for SKAARHOJ Raw Panel.
3. Enter the panel's IP address and port `9923`.

The panel appears as a surface named after its model. Its button grid follows the panel's physical layout, read from the panel when it connects. A control alone in its row joins the nearest row, and a run of controls of the same kind (such as a row of knobs) takes neighbouring columns with no gaps.

### Moving controls on the grid

If you want some controls somewhere else on Companion's grid, list them in the connection's **Control positions** field (in **Surfaces** → **Remote Surfaces**). Each entry is `<HWC>=<row>/<column>`, separated by commas (semicolons work too), for example:

`37=1/5, 38=1/6, 57=4/0`

- HWC is the panel's number for the control. On the PTZ Extreme: Cam1-12 are 1-12, X1-12 are 13-24, A1-A9 are 37-45, A10-A12 are 54-56, Knob A-H are 46-53, Iris is 57, Focus is 59 and the joystick button is 63.
- Rows and columns start at 0: row 0 is the top row and column 0 the left column of the panel's grid.
- Controls you don't list keep their automatic position. Leave the field empty for the automatic layout.
- If a listed control lands on a cell another control had, that control moves one column right, pushing the controls after it in its row along until there is a free cell.
- If two entries name the same cell, the first one wins and the later control is placed as if it were not listed.
- Entries that don't parse, controls not on the panel, and joystick, rocker or fader axes (they are variables, not buttons) are skipped, with a warning in Companion's log.
- Saving a change to this field reconnects the panel and rebuilds the surface. Your Companion buttons stay where they are on the page: a moved control uses the button at its new position.

### Controls

- Buttons are keys. Four-way buttons act as a single key: pressing any edge presses the key.
- Encoders rotate left and right. Pushing an encoder presses its key.
- Button LEDs show the button colour. The panel has 64 colours, so colours are approximated. Black turns the LED off.
- While a button is pressed in Companion, its LED dims, or lights white if the button has no colour.
- Controls without an LED or display (on the PTZ Extreme: Iris, Focus and the joystick button) work as inputs and show no feedback.
- Controls with a display show the button text: one line large, or the first two lines small (type `\n` for a line break). Displays show plain ASCII only. At the default size one line fits about 11 characters on the 64×32 button displays and about 19 on the 112×32 knob displays; long text is cut.
- Joysticks, rockers and faders are input variables, not buttons. See below.

### Joystick, zoom rocker and faders

Each analog axis sends its value to a Companion custom variable: -500 to 500 for joysticks and rockers (0 at rest), 0 to 1000 for faders and T-bars. By default values are sent at most 20 times a second per axis and ignore tiny jitter (a joystick resting a few steps off centre reads 0); both are adjustable, and an axis that stops a few steps short of its end can be set to still reach full travel (see Analog tuning below). Values always end on the final value, including the return to 0. If the connection drops, joysticks and rockers are set back to 0.

The plugin can't create these variables or preselect them in the surface settings, so set them up once:

1. In **Variables** → **Custom Variables**, create one variable per axis. Suggested names on the PTZ Extreme: `skaarhoj_zoom` (zoom rocker), `skaarhoj_lr` (joystick left-right), `skaarhoj_ud` (joystick up-down), `skaarhoj_rotate` (joystick rotate). Turn **persist value** off: the values change many times a second.
2. In **Surfaces**, open the panel's settings. Each axis is listed by name (for example "4-Axis Joystick, Left-Right (HWC 60)"); pick the custom variable for it.
3. Use the variables in triggers, expressions or actions, for example to drive a PTZ camera.

While the surface is locked, axis moves are ignored, but the return to 0 still gets through.

#### Analog tuning

In **Surfaces**, the panel's settings have a send interval for all analog axes, and an enabled switch, a dead zone and a saturation for each axis, listed by the axis's name (for example "4-Axis Joystick, Left-Right (HWC 60): dead zone"). Changes apply at once, without reconnecting.

Dead zone and saturation are in panel steps, measured from 0. A value within the dead zone reads 0; a value at or past the saturation reads full travel (±500, or 1000 on a fader); in between, the value is scaled in a straight line from 0 to full travel. So the variable always covers the full range, and the joystick still moves smoothly out of the dead zone.

- **enabled** (default on): turn an axis off to stop it sending anything to Companion. A joystick or rocker that is off the centre is set back to 0 once when you turn it off; a fader keeps its last value. Turned back on, an axis sends again from its next move. The panel still reports the axis and the plugin ignores it: Raw Panel has no command to stop the panel sending it.
- **dead zone** (default 6, 0 to 100): a joystick or rocker this close to centre reads 0, and a change in the scaled value smaller than this is not sent. Full travel and the return to 0 always get through. 0 turns the dead zone off and sends every change. Raise it if an axis at rest keeps sending values; lower it for finer control. On a fader it works the same way from its 0 end.
- **saturation** (default 500 for joysticks and rockers, 1000 for faders, which is off; 100 up to that): if an axis only reaches, say, -496 one way, set its saturation to 495 and both ends reach ±500.
- **Analog send interval (ms)** (default 50, 10 to 1000): the shortest time between two values sent for one axis. Faster moves are combined, always ending on the latest value. 50 ms is about 20 times a second, which matches how often Companion reacts to variable changes; 10 is the fastest.

### PTZ Extreme preset page

A ready-made page for the SK_PTZEXTREMEV2, to check that every control works. Each button and knob is labelled with its name and HWC number, presses and knob turns count into custom variables, and S5-S8 show the zoom rocker and joystick values. It uses only Companion's internal actions, so it needs no connections.

Download [ptz-extreme.companionconfig](https://github.com/JehutyPT/companion-surface-skaarhoj-rawpanel/blob/main/presets/ptz-extreme.companionconfig) (use **Download raw file** on GitHub). The surface settings link to it too.

1. Create the custom variables first (**Variables** → **Custom Variables**). A page export doesn't include custom variables, and without them the buttons show nothing useful. Turn **persist value** off on all of them. Start each at `0`, except `sk_last`, which starts empty.
   - `sk_presses`: counts button presses.
   - `sk_last`: the last control pressed.
   - `sk_enc1`, `sk_enc2`, `sk_enc3`, `sk_enc4`, `sk_enc5`, `sk_enc6`, `sk_enc7`, `sk_enc8`: Knob A-H (E1-E8), turned left and right. Pushing a knob resets it to 0.
   - `sk_iris`, `sk_focus`: the Iris and Focus encoders.
   - `skaarhoj_zoom`, `skaarhoj_lr`, `skaarhoj_ud`, `skaarhoj_rotate`: the zoom rocker and joystick (see above).
2. In **Import / Export**, import the file. Choose the page to import it into, then import. The page uses rows 0-3 and columns 0-16; if your button grid is smaller, Companion grows it.
3. In **Surfaces**, put the panel on that page, and in the panel's settings pick `skaarhoj_zoom`, `skaarhoj_lr`, `skaarhoj_ud` and `skaarhoj_rotate` for the four analog axes.

The page assumes the automatic layout. If you moved controls with **Control positions**, the labels follow the grid, not the controls.

### Connection

- If the connection drops, the plugin reconnects on its own and restores every LED and display. It does the same when the panel wakes from sleep.

### Panel settings

By default the plugin leaves the panel's own settings alone. In **Surfaces**, the panel's settings offer two options:

- **Panel sleep timeout**: "Leave the panel's setting" (default), or a timeout from 1 minute to 4 hours, or Never. The plugin sends it on every connect, because the panel resets it to 4 hours when it restarts. Never sleeping risks burn-in on the displays.
- **Set panel brightness from Companion** (off by default): when on, the surface's Brightness slider sets the panel's LED and display brightness (the panel has 9 levels, 0 to 8). When off, the slider does nothing.

Switching an option back to its default stops the plugin sending it, but does not undo what it already set on the panel; change it back on the panel or pick the value you want.
