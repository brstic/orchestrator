import * as THREE from 'three';
import { DESK_SIZE } from '@orchestrator/contracts';
import { Build, M, at, cyl, lathe, once, slab, softBox, sphere, tube, warp, type Model } from './kit.ts';

/**
 * Where people work: the task chair, the desk with what stands on it, the divider between facing desks.
 *
 * A chair's seat is at the origin and whoever sits on it faces +Z. A desk is centred on its top; whoever
 * works at it sits on the −Z side and looks toward +Z. The heights the people are posed against — the
 * seat's top at 0.51 m, the desk's top at DESK_TOP — are kept exactly.
 */

/** The upper face of a desk's top. */
export const DESK_TOP = DESK_SIZE.h + 0.0225;

const smoothstep = (a: number, b: number, v: number) => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const chairs = new Map<string, Model>();

/**
 * An office task chair: five-star base on castors, gas lift, a seat with a waterfall front edge and a back
 * that wraps around the sitter. `executive` is the tall one with a headrest and arms.
 */
export function taskChair(color = '#2f3846', kind: 'task' | 'executive' | 'visitor' = 'task'): Model {
  const key = `${color}:${kind}`;
  let m = chairs.get(key);
  if (m) return m;
  const b = new Build();
  const alu = M.metal('#c5cad3', 0.34);
  const shell = M.plastic('#1a1e25', 0.55);
  const cloth = kind === 'executive' ? M.leather(color) : M.fabric(color);
  const rubber = M.rubber();

  // Five-star base: each arm tapers and slopes down from the hub to a twin castor.
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + Math.PI / 5;
    const sin = Math.sin(a);
    const cos = Math.cos(a);
    const arm = warp(softBox(0.052, 0.034, 0.27, 0.012, { round: 1, flat: [1, 1, 3] }), (p) => {
      const t = (p.z + 0.135) / 0.27;
      p.y = p.y * (1 - t * 0.3) - t * 0.036;
      p.x *= 1 - t * 0.38;
    });
    b.add(alu, at(arm, sin * 0.165, 0.108, cos * 0.165, 0, a, 0));
    const cx = sin * 0.297;
    const cz = cos * 0.297;
    b.add(shell, at(cyl(0.011, 0.011, 0.03, 8), cx, 0.066, cz), { cast: false });
    b.add(shell, at(softBox(0.05, 0.026, 0.056, 0.011, { round: 1 }), cx, 0.047, cz, 0, a, 0), { cast: false });
    for (const s of [-1, 1]) b.add(rubber, at(cyl(0.027, 0.027, 0.017, 10), cx + cos * 0.015 * s, 0.027, cz - sin * 0.015 * s, 0, a, Math.PI / 2), { cast: false });
  }
  b.add(alu, lathe([[0, 0.085], [0.046, 0.085], [0.052, 0.092], [0.052, 0.12], [0.044, 0.132], [0.034, 0.136], [0, 0.136]], 20));
  // Gas lift: the outer cylinder, the bright piston, and the collar it disappears into.
  b.add(shell, lathe([[0.03, 0.13], [0.03, 0.27], [0.027, 0.276], [0, 0.276]], 16));
  b.add(M.metal('#dfe3e9', 0.18), at(cyl(0.017, 0.017, 0.13, 14), 0, 0.335, 0), { cast: false });
  b.add(shell, at(softBox(0.21, 0.05, 0.25, 0.016, { round: 1 }), 0, 0.412, -0.015));
  // The height lever under the right side of the seat.
  b.add(shell, tube([[0.09, 0.405, 0.04], [0.19, 0.4, 0.05], [0.245, 0.392, 0.05]], 0.0065, 6), { cast: false });
  b.add(shell, at(softBox(0.04, 0.012, 0.026, 0.005, { round: 1 }), 0.255, 0.391, 0.05), { cast: false });

  // Seat: a firm shell with the cushion on it. The front edge rolls off under the knees.
  b.add(shell, at(softBox(0.47, 0.03, 0.46, 0.014, { round: 1 }), 0, 0.43, 0));
  const seat = warp(softBox(0.5, 0.088, 0.49, 0.04, { round: 2, flat: [3, 1, 3], puff: 0.012 }), (p) => {
    const f = smoothstep(0.08, 0.245, p.z);
    p.y -= f * f * 0.024;
    // Slightly wider at the front than at the back.
    p.x *= 0.97 + 0.03 * smoothstep(-0.245, 0.1, p.z);
  });
  b.add(cloth, at(seat, 0, 0.461, 0.005));

  // Back: curved around the sitter, fuller at the small of the back, leaning away toward the top.
  const tall = kind === 'executive';
  const bh = tall ? 0.72 : 0.54;
  const bend = (h: number) => (p: THREE.Vector3) => {
    const t = (p.y + h / 2) / h;
    p.z += 0.5 * p.x * p.x;
    p.z += 0.02 * Math.exp(-Math.pow((t - 0.22) / 0.22, 2)) - 0.055 * t * t;
    p.x *= 1 - 0.14 * smoothstep(0.45, 1, t) - 0.06 * smoothstep(0.3, 0, t);
  };
  const cushion = warp(softBox(0.45, bh, 0.065, 0.032, { round: 2, flat: [4, tall ? 6 : 4, 1], puffFront: 0.014 }), bend(bh));
  const backY = 0.56 + bh / 2;
  b.add(cloth, at(cushion, 0, backY, -0.286));
  const plate = warp(softBox(0.425, bh - 0.05, 0.022, 0.01, { round: 1, flat: [4, tall ? 6 : 4, 1] }), bend(bh - 0.05));
  b.add(shell, at(plate, 0, backY - 0.005, -0.322));
  // The spine that carries the back, a flat bar bent up from under the seat.
  b.add(alu, at(tube([[0, 0.412, -0.1], [0, 0.415, -0.25], [0, 0.47, -0.335], [0, 0.6, -0.352], [0, 0.74, -0.345]], 0.017, 8, 14), 0, 0, 0, 0, 0, 0, 2.3, 1, 1));
  if (tall) {
    // Headrest on two short stalks.
    const head = warp(softBox(0.3, 0.14, 0.07, 0.035, { round: 3, flat: [3, 1, 1], puffFront: 0.01 }), (p) => {
      p.z += 0.6 * p.x * p.x;
    });
    b.add(cloth, at(head, 0, 1.4, -0.335));
    for (const s of [-1, 1]) b.add(alu, at(cyl(0.007, 0.007, 0.1, 8), s * 0.07, 1.31, -0.35), { cast: false });
  }
  if (kind !== 'task') {
    // Arms: a bent support from under the seat and a padded rest.
    for (const s of [-1, 1]) {
      b.add(alu, at(tube([[s * 0.2, 0.425, 0.02], [s * 0.285, 0.43, 0.02], [s * 0.315, 0.5, 0.0], [s * 0.318, 0.66, -0.03]], 0.013, 8, 12), 0, 0, 0, 0, 0, 0, 1, 1, 1.6));
      b.add(shell, at(softBox(0.062, 0.028, 0.27, 0.013, { round: 2 }), s * 0.318, 0.682, -0.02));
    }
  }
  m = b.done();
  chairs.set(key, m);
  return m;
}

/**
 * A desk: an oak top on a white steel frame, a drawer pedestal on the right, and on it a monitor, keyboard and
 * mouse. The screen's picture is not part of the model: it is drawn in front of the panel by `MonitorScreen`.
 */
export const desk = once((): Model => {
  const b = new Build();
  const top = M.wood('#d9b98e');
  const frame = M.paint('#f2f4f7', 0.45);
  const body = M.paint('#e4e7ec', 0.6);
  const front = M.paint('#f6f7f9', 0.5);
  const alu = M.metal('#c5cad3', 0.36);
  const { w, d } = DESK_SIZE;

  b.add(top, at(slab(w, 0.034, d, 0.028, 0.006), 0, DESK_TOP - 0.017, 0));
  // Two leg frames: a foot on the floor, two posts, a rail under the top.
  const under = DESK_TOP - 0.034;
  for (const s of [-1, 1]) {
    const x = s * (w / 2 - 0.09);
    b.add(frame, at(softBox(0.06, 0.028, d - 0.1, 0.01, { round: 1 }), x, 0.014, 0));
    b.add(frame, at(softBox(0.05, 0.03, d - 0.16, 0.008, { round: 1 }), x, under - 0.015, 0));
    for (const z of [-1, 1]) b.add(frame, at(softBox(0.05, under - 0.04, 0.03, 0.008, { round: 1 }), x, (under - 0.012) / 2 + 0.006, z * (d / 2 - 0.13)));
  }
  // The beam that ties the frames, with the cable tray hung under the back edge.
  b.add(frame, at(softBox(w - 0.2, 0.06, 0.024, 0.006, { round: 1 }), 0, under - 0.03, d / 2 - 0.13));
  b.add(body, at(softBox(w - 0.5, 0.012, 0.12, 0.004, { round: 1 }), 0, under - 0.12, d / 2 - 0.17), { cast: false });
  for (const s of [-1, 1]) b.add(body, at(softBox(0.012, 0.11, 0.12, 0.004, { round: 1 }), s * (w / 2 - 0.26), under - 0.066, d / 2 - 0.17), { cast: false });

  // Drawer pedestal: a body with three fronts and bar handles, standing on a recessed plinth.
  const px = w / 2 - 0.33;
  b.add(M.steel('#2a2f38'), at(softBox(0.36, 0.03, 0.5, 0.004, { round: 1 }), px, 0.015, 0.02), { cast: false });
  b.add(body, at(softBox(0.4, 0.55, 0.56, 0.012, { round: 2 }), px, 0.305, 0.02));
  let y = 0.585;
  for (const h of [0.125, 0.125, 0.27]) {
    y -= h / 2 + 0.006;
    b.add(front, at(softBox(0.386, h, 0.016, 0.006, { round: 1 }), px, y, -0.266), { cast: false });
    b.add(alu, at(softBox(0.13, 0.011, 0.016, 0.005, { round: 1 }), px, y + h / 2 - 0.03, -0.28), { cast: false });
    y -= h / 2;
  }
  // The cable grommet in the top.
  b.add(M.plastic('#1a1e25'), at(cyl(0.03, 0.03, 0.004, 18), 0.42, DESK_TOP + 0.001, d / 2 - 0.09), { cast: false });

  b.put(monitor(), -0.08, DESK_TOP, 0.22);
  b.put(keyboard(), -0.08, DESK_TOP, -0.16);
  // Mouse.
  const mouse = warp(sphere(1, 14, 10), (p) => {
    const front = p.z > 0 ? 1 : 0.9;
    p.set(p.x * 0.03 * front, Math.max(0, p.y) * 0.034 * (1 - 0.25 * Math.max(0, p.z)), p.z * 0.052);
  });
  b.add(M.paint('#f4f5f7', 0.4), at(mouse, 0.28, DESK_TOP, -0.15), { cast: false });
  // The foot of the status lamp (the lamp itself is lit per desk, see DeskLight).
  b.add(M.steel('#2a2f38', 0.4), at(lathe([[0, 0], [0.043, 0], [0.046, 0.004], [0.046, 0.012], [0.038, 0.018], [0, 0.018]], 20), w / 2 - 0.14, DESK_TOP, 0.3), { cast: false });
  return b.done();
});

/** A 27-inch monitor on a stand: its foot at the origin, the glass facing −Z. The lit picture is 0.6 × 0.36 m, centred 0.3575 m up. */
export const monitor = once((): Model => {
  const b = new Build();
  const shell = M.plastic('#15181e', 0.5);
  const alu = M.metal('#b9bfc9', 0.36);
  const cy = 0.3575;
  // The glass: its face stands where the picture is drawn 2.5 mm in front of.
  b.add(M.gloss('#090b0f'), at(softBox(0.626, 0.386, 0.01, 0.0045, { round: 1 }), 0, cy, -0.0125));
  b.add(shell, at(softBox(0.618, 0.378, 0.014, 0.006, { round: 1 }), 0, cy, -0.001));
  const bulge = warp(softBox(0.4, 0.24, 0.03, 0.014, { round: 2, flat: [3, 3, 1] }), (p) => {
    if (p.z > 0) p.z *= 1 - 0.5 * Math.pow(Math.max(Math.abs(p.x) / 0.2, Math.abs(p.y) / 0.12), 2);
  });
  b.add(shell, at(bulge, 0, cy - 0.02, 0.016));
  // Stand: a neck leaning back from the foot to the hinge behind the panel.
  b.add(alu, at(softBox(0.056, 0.3, 0.016, 0.006, { round: 1 }), 0, 0.17, 0.042, -0.07, 0, 0));
  b.add(alu, at(softBox(0.09, 0.05, 0.02, 0.008, { round: 1 }), 0, cy - 0.05, 0.034), { cast: false });
  b.add(alu, at(slab(0.25, 0.012, 0.19, 0.035, 0.004, 2), 0, 0.006, 0.03));
  return b.done();
});

/** A low-profile keyboard: an aluminium tray of white keys, the space bar toward −Z. */
export const keyboard = once((): Model => {
  const b = new Build();
  b.add(M.metal('#c5cad3', 0.4), at(softBox(0.44, 0.012, 0.135, 0.005, { round: 1 }), 0, 0.007, 0), { cast: false });
  const key = M.paint('#f4f5f7', 0.55);
  const cap = (kw: number) => {
    const g = new THREE.BoxGeometry(kw, 0.005, 0.0205);
    // The sides lean in a little, as key caps do.
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) if (pos.getY(i) > 0) pos.setXYZ(i, pos.getX(i) * (1 - 0.003 / kw), pos.getY(i), pos.getZ(i) * 0.88);
    g.computeVertexNormals();
    return g;
  };
  const pitch = 0.0272;
  const rows: number[][] = [
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.6],
    [1.6, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    [1.9, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.75],
    [2.4, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2.3],
    [1.3, 1.3, 1.3, 6.2, 1.3, 1.3, 1.3],
  ];
  rows.forEach((row, r) => {
    const total = row.reduce((a, k) => a + k, 0) * pitch;
    let x = -total / 2;
    for (const k of row) {
      const kw = k * pitch - 0.005;
      b.add(key, at(cap(kw), x + (k * pitch) / 2, 0.0155, 0.052 - r * 0.026), { cast: false });
      x += k * pitch;
    }
  });
  return b.done();
});

/** The cloth screen between desks that face each other; `length` along X. */
const dividers = new Map<number, Model>();
export function divider(length: number): Model {
  const had = dividers.get(length);
  if (had) return had;
  const b = new Build();
  const alu = M.metal('#c5cad3', 0.36);
  b.add(M.fabric('#8592a8'), at(softBox(length, 0.4, 0.028, 0.012, { round: 2 }), 0, DESK_TOP + 0.235, 0));
  // An aluminium foot rail and the brackets that hold the panel.
  b.add(alu, at(softBox(length - 0.04, 0.02, 0.04, 0.006, { round: 1 }), 0, DESK_TOP + 0.022, 0), { cast: false });
  const n = Math.max(2, Math.round(length / 0.9));
  for (let i = 0; i < n; i++) {
    const x = -length / 2 + 0.2 + (i * (length - 0.4)) / (n - 1);
    b.add(alu, at(softBox(0.06, 0.034, 0.044, 0.006, { round: 1 }), x, DESK_TOP + 0.03, 0), { cast: false });
    b.add(alu, at(softBox(0.03, DESK_TOP + 0.01, 0.03, 0.006, { round: 1 }), x, (DESK_TOP + 0.01) / 2, 0));
  }
  const m = b.done();
  dividers.set(length, m);
  return m;
}

/** The dome of a desk's status lamp, standing on its foot (which is part of the desk). */
export const lampDome = once(() => lathe([[0, 0.016], [0.034, 0.016], [0.034, 0.06], [0.03, 0.074], [0.02, 0.083], [0.008, 0.087], [0, 0.088]], 20));
