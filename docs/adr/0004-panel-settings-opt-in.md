# Panel settings are opt-in

This is a general-purpose plugin that assumes nothing about other clients of the panel, so it leaves the panel's stored settings alone by default. It sends `SleepTimer=` or `PanelBrightness=` only when the user has set the matching surface setting, and nothing else to the panel's settings. This replaced an earlier rule to always send `SleepTimer=1800000`. Switching an option back to its default stops sending it but does not undo what was sent, because the plugin does not know the panel's previous value.
