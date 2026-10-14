## SKAARHOJ Raw Panel

Use a SKAARHOJ Raw Panel as a Companion surface. Needs Companion 5.1 or later.

Built and tested on the SK_PTZEXTREMEV2. Other Raw Panels may work, since the layout comes from the panel, but they are untested.

This plugin is in development. This page grows as features ship.

### Setup

1. Make sure the panel is reachable on your network and its Raw Panel server is enabled (TCP port 9923).
2. In Companion, go to **Surfaces** → **Remote Surfaces** and add a connection for SKAARHOJ Raw Panel.
3. Enter the panel's IP address and port `9923`.

The panel appears as a surface named after its model. Its button grid follows the panel's physical layout, read from the panel when it connects.

### Controls

- Buttons are keys. Four-way buttons act as a single key: pressing any edge presses the key.
- Encoders rotate left and right. Pushing an encoder presses its key.
- Button LEDs show the button colour. The panel has 64 colours, so colours are approximated. Black turns the LED off.
- While a button is pressed in Companion, its LED dims, or lights white if the button has no colour.
- Controls without an LED or display (on the PTZ Extreme: Iris, Focus and the joystick button) work as inputs and show no feedback.
- Controls with a display show the button text: one line large, or the first two lines small. Displays show plain ASCII only, up to 24 characters per line, and long text is cut.
- Joysticks, rockers and faders are not used yet.

### Connection

- If the connection drops, the plugin reconnects on its own and restores every LED and display. It does the same when the panel wakes from sleep.
- The plugin does not change the panel's own settings (sleep timer, brightness).
