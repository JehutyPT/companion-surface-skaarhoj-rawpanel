## SKAARHOJ Raw Panel

Use any SKAARHOJ Raw Panel as a Companion surface (first tested on the PTZ Extreme V2). Buttons, encoders, LEDs and displays are driven over the Raw Panel TCP protocol; the layout comes from what the panel reports. Analog controls (joysticks, rockers, faders) are exposed as variables. Needs Companion 5.1 or later.

This plugin is in development and does not yet control the panel.

### Setup

1. Make sure the panel is reachable on your network and its Raw Panel server is enabled (TCP port 9923).
2. In Companion, go to **Surfaces** → **Remote Surfaces** and add a connection for SKAARHOJ Raw Panel.
3. Enter the panel's IP address and port `9923`.

### Controls

- Buttons and encoder pushes are keys. Encoders rotate left and right.
- Four-way buttons act as a single key for now: pressing any edge presses the key.
- LEDs show the button colour (the panel has 64 colours, so colours are approximated). Displays show the button text.

### Analog controls

Companion has no analog button type, so each analog axis (zoom rocker, joystick X/Y/rotate, fader) sends its value to a custom variable you choose. The value is a number, sent when it changes.

1. Create one custom variable per axis under **Variables** → **Custom Variables**, for example `skaarhoj_zoom`, `skaarhoj_joy_x`, `skaarhoj_joy_y`, `skaarhoj_joy_rot`. Leave **Persist value** off, or every movement is written to disk.
2. In the panel's surface settings, pick the variable for each axis.
3. Use the variables in triggers or actions.

The plugin cannot create these variables for you, and page exports do not include custom variables.

### Panel settings

The plugin leaves the panel's own settings alone unless you set them:

- **Sleep timeout**: off by default (the panel keeps its own setting). Set a timeout to have the plugin send it on every connect, since the panel resets it to 4 hours on reboot.
- **Brightness**: optionally follow Companion's surface brightness.

### PTZ Extreme preset page

A ready-made page for the PTZ Extreme V2 is planned to ship with the plugin, linked from the surface settings. Import it as a single page. It does not include custom variables, so create those first. Importing grows the page grid if needed.
