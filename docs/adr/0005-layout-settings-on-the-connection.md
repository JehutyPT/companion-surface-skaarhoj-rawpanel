# Layout-affecting settings are connection settings

Companion fixes a surface's layout when it opens the surface, and surface settings arrive only after that. So anything that changes the layout (address, port, control positions) is a remote connection setting: it arrives before `openSurface`, and saving it reconnects and rebuilds the surface. Settings that can apply live (analog tuning, panel settings) are surface settings and never reconnect.
