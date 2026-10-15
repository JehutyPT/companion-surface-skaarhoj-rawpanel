# A four-way button is one key

A multi-edge button (`b2h`, `b2v`, `b4`) is one layout control: any edge down is key down, all edges up is key up once they have stayed up for the release debounce (a surface setting, default 30 ms, 0 = off), since a press near the centre can briefly release every edge and would otherwise run the button's actions twice. Companion has no four-way control type and its layout schema has no control types, so per-edge keys would need several grid cells for one physical control. Per-edge keys and four-way modes stay in the backlog.
