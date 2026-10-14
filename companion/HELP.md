## SKAARHOJ Raw Panel

Use a SKAARHOJ panel (first target: the PTZ Extreme V2) as a Companion surface. The panel's buttons, encoders, LEDs and displays are driven over the Raw Panel TCP protocol.

This plugin is in development and does not yet control the panel.

### Setup

1. Make sure the panel is reachable on your network and its Raw Panel server is enabled (TCP port 9923).
2. In Companion, go to **Surfaces** → **Remote Surfaces** and add a connection for SKAARHOJ Raw Panel.
3. Enter the panel's IP address and port `9923`.

### The joystick

The joystick and zoom controls are not exposed to Companion. They belong to PTZJoystickControl, which connects to the same panel as a second Raw Panel client and drives the cameras directly. Both can run at the same time.
