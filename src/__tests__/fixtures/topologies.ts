/**
 * Topology fixtures. The PTZ Extreme topology is a real capture (ptz-extreme-topology.ts); the
 * small topologies are SYNTHESISED for exact grid assertions. The JSON shape follows
 * SKAARHOJ/rawpanel-lib `topology/topology.go`.
 */

export { ptzExtremeTopology } from './ptz-extreme-topology.js'

/** All PTZ Extreme HWCs that should become Companion controls (everything except analog and placeholders). */
export const ptzExtremeLayoutHwcs = [
	...Array.from({ length: 24 }, (_, i) => i + 1),
	37,
	38,
	39,
	40,
	41,
	42,
	43,
	44,
	45,
	54,
	55,
	56,
	46,
	47,
	48,
	49,
	50,
	51,
	52,
	53,
	57,
	59,
	63,
]

/**
 * SYNTHESISED small panel for exact grid assertions: a 3x2 block of buttons with jitter, an
 * encoder to the right, a fader (analog), a four-way button, one control with an unknown `in`
 * code and one placeholder. Controls are 200 wide (1/10 mm), so coordinates within half of that
 * merge into one column or row.
 *
 *          x=1000  x=1200  x=1400   x=1800
 *  y=500   b1      b2      b3       enc 10 (pb, display)
 *  y=700   b4      b5      fw 6     fader 11 (av)  unknown 12 (zz)
 */
export const smallTopology = {
	HWc: [
		{ id: 1, x: 1000, y: 500, txt: 'B1', type: 1 },
		{ id: 2, x: 1210, y: 495, txt: 'B2', type: 1 },
		{ id: 3, x: 1395, y: 505, txt: 'B3', type: 1 },
		{ id: 4, x: 1005, y: 700, txt: 'B4', type: 1 },
		{ id: 5, x: 1190, y: 710, txt: 'B5', type: 1 },
		{ id: 6, x: 1400, y: 690, txt: 'FW', type: 2 },
		{ id: 10, x: 1800, y: 500, txt: 'Enc', type: 3 },
		{ id: 11, x: 1800, y: 700, txt: 'Fader', type: 4 },
		{ id: 12, x: 2000, y: 700, txt: 'Mystery', type: 5 },
		{ id: 20, x: 100, y: 100, txt: 'Title', type: 6 },
		{ id: 21, x: 1600, y: 600, txt: 'Disabled', type: 0 },
	],
	typeIndex: {
		'1': { w: 200, h: 200, in: 'b', out: 'rgb', desc: 'Button' },
		'2': { w: 200, h: 200, in: 'b4', out: 'rgb', desc: 'Four-way', disp: { w: 64, h: 32, subidx: 0 } },
		'3': { w: 200, in: 'pb', out: 'rgb', desc: 'Encoder', disp: { w: 112, h: 32, subidx: 0 } },
		'4': { w: 100, h: 600, in: 'av', desc: 'Fader' },
		'5': { w: 200, h: 200, in: 'zz', desc: 'Something new' },
		'6': { w: 400, h: 60, desc: 'Label' },
	},
}
