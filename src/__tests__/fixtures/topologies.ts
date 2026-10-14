/**
 * Topology fixtures.
 *
 * SYNTHESISED, not captured. No `_panelTopology_HWC` dump from a real panel exists in this repo,
 * in PTZJoystickControl or in SKAARHOJ's public repos. The PTZ Extreme fixture follows the HWC
 * table measured on the SK_PTZEXTREMEV2 (docs/raw-panel-protocol.md, "PTZ Extreme HWC list"):
 * ids, type numbers, `in` codes, LED outputs and display sizes are real; the coordinates, control
 * sizes and descriptions are invented. The JSON shape follows SKAARHOJ/rawpanel-lib
 * `topology/topology.go`. Replace with a real capture once one is taken.
 */

interface Hwc {
	id: number
	x: number
	y: number
	txt: string
	type: number
	typeOverride?: Record<string, unknown>
}

/** Small deterministic jitter (±6, in 1/10 mm), so coordinates in one row or column are not identical. */
const jitter = (n: number): number => ((n * 7) % 13) - 6

function ptzExtremeHwcs(): Hwc[] {
	const hwcs: Hwc[] = []
	// Cam1-12 and X1-12: four-way buttons with displays, two rows of twelve.
	for (let i = 0; i < 12; i++) {
		hwcs.push({ id: 1 + i, x: 300 + i * 200 + jitter(i), y: 400 + jitter(i + 1), txt: `Cam${i + 1}`, type: 133 })
	}
	for (let i = 0; i < 12; i++) {
		hwcs.push({ id: 13 + i, x: 300 + i * 200 + jitter(i + 2), y: 620 + jitter(i + 3), txt: `X${i + 1}`, type: 133 })
	}
	// A1-A12: ids 37-45 then 54-56, a third row.
	const aIds = [37, 38, 39, 40, 41, 42, 43, 44, 45, 54, 55, 56]
	aIds.forEach((id, i) => {
		hwcs.push({ id, x: 300 + i * 200 + jitter(i + 4), y: 840 + jitter(i + 5), txt: `A ${i + 1}`, type: 134 })
	})
	// Knob A-H: encoders with push and displays, a row below, on a different pitch.
	for (let i = 0; i < 8; i++) {
		hwcs.push({
			id: 46 + i,
			x: 400 + i * 300 + jitter(i + 6),
			y: 1150 + jitter(i + 7),
			txt: `Knob ${String.fromCharCode(65 + i)}`,
			type: 18,
		})
	}
	// Iris and Focus encoders, zoom rocker, joystick axes and top button.
	hwcs.push({ id: 57, x: 2900, y: 400, txt: 'Iris', type: 16 })
	hwcs.push({ id: 59, x: 2900, y: 700, txt: 'Focus', type: 16 })
	hwcs.push({ id: 58, x: 3300, y: 400, txt: 'Zoom', type: 104 })
	hwcs.push({ id: 60, x: 3300, y: 1000, txt: 'LR', type: 96 })
	hwcs.push({ id: 61, x: 3300, y: 1000, txt: 'UD', type: 97 })
	hwcs.push({ id: 62, x: 3300, y: 1000, txt: 'Rotate', type: 98 })
	hwcs.push({ id: 63, x: 3300, y: 1000, txt: 'Top button', type: 99 })
	// Layout placeholders: no input.
	for (let i = 0; i < 7; i++) {
		hwcs.push({ id: 64 + i, x: 100 + i * 500, y: 100, txt: i === 0 ? 'Controller' : `Section ${i}`, type: 250 })
	}
	return hwcs
}

const fourWayWithDisplay = {
	w: 180,
	h: 180,
	in: 'b4',
	out: 'rgb',
	desc: 'Four-way button with display',
	disp: { w: 64, h: 32, subidx: 0 },
	sub: [{ _: 'd', _x: -32, _y: -16, _w: 64, _h: 32 }],
}

/** SYNTHESISED SK_PTZEXTREMEV2 topology (see the file comment). */
export const ptzExtremeTopology = {
	HWc: ptzExtremeHwcs(),
	typeIndex: {
		'133': fourWayWithDisplay,
		'134': { ...fourWayWithDisplay },
		'18': { w: 260, in: 'pb', out: 'rgb', desc: 'Encoder with push and display', disp: { w: 112, h: 32, subidx: 0 } },
		'16': { w: 300, in: 'pb', desc: 'Encoder with push' },
		'104': { w: 200, h: 400, in: 'iv', desc: 'Zoom rocker' },
		'96': { w: 500, in: 'ih', desc: 'Joystick left/right' },
		'97': { w: 500, in: 'iv', desc: 'Joystick up/down' },
		'98': { w: 500, in: 'ir', desc: 'Joystick rotate' },
		'99': { w: 120, in: 'b', desc: 'Joystick top button' },
		'250': { w: 400, h: 60, desc: 'Placeholder' },
	},
}

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
