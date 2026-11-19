import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { DECORATION_KINDS, DESK_SIZE } from '@orchestrator/contracts';
import type { Model } from '../src/models/kit.ts';
import { DESK_TOP, desk, divider, keyboard, monitor, taskChair } from '../src/models/workplace.ts';
import { arcade, bookshelf, coffeeTable, deskPlant, floorLamp, mug, notebook, plant, sofa, trophyCase } from '../src/models/decor.ts';
import { executiveDesk, fridge, hifi, kitchen, mediaConsole, meetingTable, opsConsole, rack, receptionDesk, vault } from '../src/models/rooms.ts';

/**
 * The furniture is sculpted in code, so its sizes can be checked like any other number: every model must stand
 * on the floor, fit the floor area the office reserves for it (people walk around that area, not around the
 * model), keep the heights people are posed against, and stay within a budget of triangles.
 */

function box(m: Model): THREE.Box3 {
  const b = new THREE.Box3();
  for (const p of m.parts) {
    p.geometry.computeBoundingBox();
    b.union(p.geometry.boundingBox!);
  }
  return b;
}

/** A few centimetres of overhang are fine (a table top over its frame, a cushion over an arm). */
const SLACK = 0.06;

function fits(name: string, m: Model, w: number, d: number, maxTriangles: number): void {
  const b = box(m);
  assert.ok(b.min.y > -0.001, `${name} goes ${(-b.min.y).toFixed(3)} m under the floor`);
  assert.ok(b.min.y < 0.03, `${name} floats ${b.min.y.toFixed(3)} m above the floor`);
  assert.ok(b.max.x <= w / 2 + SLACK && b.min.x >= -w / 2 - SLACK, `${name} is ${(b.max.x - b.min.x).toFixed(2)} m wide; its place is ${w} m`);
  assert.ok(b.max.z <= d / 2 + SLACK && b.min.z >= -d / 2 - SLACK, `${name} is ${(b.max.z - b.min.z).toFixed(2)} m deep; its place is ${d} m`);
  assert.ok(m.triangles <= maxTriangles, `${name} has ${m.triangles} triangles; its budget is ${maxTriangles}`);
  for (const p of m.parts) {
    const pos = p.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count * 3; i++) assert.ok(Number.isFinite(pos.array[i]), `${name} has a vertex that is not a number`);
    assert.ok(p.geometry.attributes.normal && p.geometry.attributes.uv, `${name}: every part has normals and texture coordinates`);
  }
}

const kind = (k: string) => DECORATION_KINDS.find((x) => x.kind === k)!;

test('a chair keeps the seat height people are posed on, and fits under a desk', () => {
  for (const which of ['task', 'visitor', 'executive'] as const) {
    const m = taskChair('#2f3846', which);
    fits(`${which} chair`, m, 0.74, 0.78, which === 'task' ? 4500 : which === 'visitor' ? 5500 : 6500);
    // The cushion: the part made of cloth or leather. Its top in the middle is where a person's weight rests.
    const cushion = m.parts.filter((p) => (p.material as THREE.MeshStandardMaterial).roughness > 0.9 || (p.material as THREE.MeshStandardMaterial).bumpMap !== undefined).map((p) => p.geometry);
    let top = 0;
    for (const g of cushion) {
      const pos = g.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) if (Math.abs(pos.getX(i)) < 0.1 && Math.abs(pos.getZ(i)) < 0.1 && pos.getY(i) < 0.6) top = Math.max(top, pos.getY(i));
    }
    assert.ok(top > 0.5 && top < 0.53, `the seat of the ${which} chair is ${top.toFixed(3)} m high; people sit at 0.51`);
    // Nothing of the back comes further forward than the old one did: a sitter's back must not pass through it.
    for (const p of m.parts) {
      const pos = p.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        if (pos.getY(i) > 0.62 && Math.abs(pos.getX(i)) < 0.16) assert.ok(pos.getZ(i) < -0.2, `the ${which} chair's back comes forward to z=${pos.getZ(i).toFixed(3)} at height ${pos.getY(i).toFixed(2)}`);
      }
    }
  }
});

test('a desk is the size the layout says, and its top is where hands and screens expect it', () => {
  const m = desk();
  fits('desk', m, DESK_SIZE.w, DESK_SIZE.d, 5400);
  const b = box(m);
  assert.ok(Math.abs(b.max.x - DESK_SIZE.w / 2) < 0.002 && Math.abs(b.max.z - DESK_SIZE.d / 2) < 0.002, 'the top reaches exactly to the edges of the desk');
  // The top's surface: the highest point along the sitter's edge, where nothing stands.
  let top = 0;
  for (const p of m.parts) {
    const pos = p.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) if (pos.getZ(i) < -0.3) top = Math.max(top, pos.getY(i));
  }
  assert.ok(Math.abs(top - DESK_TOP) < 0.001, `the desk top is at ${top.toFixed(4)}, expected ${DESK_TOP}`);
  // Legroom: nothing between the knees of whoever sits at the middle of the desk.
  for (const p of m.parts) {
    const pos = p.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const [x, y, z] = [pos.getX(i), pos.getY(i), pos.getZ(i)];
      assert.ok(!(Math.abs(x) < 0.3 && y < 0.6 && z < 0.2), `something of the desk is in the sitter's legroom at ${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}`);
    }
  }
  // The glass of the monitor stands just behind where the picture is drawn (0.2 m from the desk's middle, facing the seat).
  const pane = monitor().parts.find((p) => (p.material as THREE.MeshStandardMaterial).roughness === 0.12)!;
  pane.geometry.computeBoundingBox();
  const glass = pane.geometry.boundingBox!.min.z + 0.22;
  assert.ok(glass > 0.2 && glass < 0.206, `the monitor's glass is at z=${glass.toFixed(4)}; the picture is drawn at 0.200`);
  fits('keyboard', keyboard(), 0.46, 0.15, 900);
  fits('divider', divider(DESK_SIZE.w * 2 + 0.2), DESK_SIZE.w * 2 + 0.2, 0.15, 1400);
});

test('decorations fit the footprint the layout editor gives them', () => {
  fits('sofa', sofa(2.0), kind('sofa').w, kind('sofa').d, 4800);
  fits('bookshelf', bookshelf(), kind('bookshelf').w, kind('bookshelf').d, 4000);
  fits('floor lamp', floorLamp(), kind('floor_lamp').w, kind('floor_lamp').d, 1400);
  fits('arcade cabinet', arcade(), kind('arcade').w, kind('arcade').d, 1500);
  fits('trophy case', trophyCase(), kind('trophy_case').w, kind('trophy_case').d, 7200);
  // A plant's leaves may reach over its place; its pot may not.
  for (let n = 0; n < 3; n++) {
    const m = plant(n);
    assert.ok(m.triangles <= 2800, `plant ${n} has ${m.triangles} triangles`);
    const b = box(m);
    assert.ok(b.min.y > -0.001 && b.max.y > 1.0 && b.max.y < 2.0, `plant ${n} stands from ${b.min.y.toFixed(3)} to ${b.max.y.toFixed(2)} m`);
    for (const p of m.parts) {
      const pos = p.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) if (pos.getY(i) < 0.35) assert.ok(Math.hypot(pos.getX(i), pos.getZ(i)) < kind('plant').w / 2, `plant ${n}: its pot is wider than its place`);
    }
  }
  assert.notEqual(plant(0), plant(1));
  assert.equal(plant(3), plant(0), 'the same plant every time it is asked for');
  for (const [name, m, tris] of [['mug', mug(), 500], ['notebook', notebook(), 600], ['desk plant', deskPlant(), 600]] as Array<[string, Model, number]>) assert.ok(m.triangles <= tris, `${name} has ${m.triangles} triangles; it is drawn on many desks`);
});

test('room furniture fits the floor the office keeps free for it', () => {
  // The same sizes as the obstacles in world.ts.
  fits('reception desk', receptionDesk(), 3.4, 0.9, 7000);
  fits('meeting table', meetingTable(6.2, 1.7), 6.2, 1.7, 2800);
  fits('executive desk', executiveDesk(), 2.4, 1.1, 6500);
  fits('kitchen', kitchen(4.6), 4.6, 0.8, 9500);
  fits('fridge', fridge(), 0.8, 0.8, 1200);
  fits('rack', rack(), 0.8, 1.05, 1600);
  fits('operators console', opsConsole(), 5.2, 1.0, 6000);
  fits('media console', mediaConsole(), 2.6, 0.5, 2000);
  fits('hi-fi', hifi(), 3.0, 0.7, 6800);
  fits('vault', vault(), 1.2, 0.9, 7200);
  // A safe a person looks up at a little, not a cupboard and not a wardrobe; and its wheel stays inside its place.
  const safe = box(vault());
  assert.ok(safe.max.y >= 1.6 && safe.max.y <= 1.85, `the vault is ${safe.max.y.toFixed(2)} m high`);
  assert.ok(safe.max.z <= 0.45 + SLACK, `the vault's wheel reaches ${safe.max.z.toFixed(3)} m forward of its middle; its place ends at 0.45`);
  fits('waiting sofa', sofa(3.0), 3.0, 0.9, 6500);
  fits('break-room sofa', sofa(2.6, '#c96f4a', { seat: 0.5 }), 2.6, 0.95, 5500);
  fits('coffee table', coffeeTable(1.3, 0.7), 1.3, 0.7, 1500);
  fits('armchair', sofa(1.0, '#8a5230', { leather: true }), 1.1, 0.9, 3400);
});

test('a model asked for again with the same measures is the same model — a scene that renders again makes nothing new (the break room leaked three shapes a second)', async () => {
  const { coffeeTable, rug } = await import('../src/models/decor.ts');
  const { kitchen } = await import('../src/models/rooms.ts');
  assert.equal(coffeeTable(1.3, 0.7), coffeeTable(1.3, 0.7));
  assert.equal(coffeeTable(), coffeeTable());
  assert.notEqual(coffeeTable(0.9, 0.55), coffeeTable(1.3, 0.7));
  assert.equal(kitchen(4.6), kitchen(4.6));
  assert.equal(rug(4.6, 3.4, '#3b4a63', '#27324a'), rug(4.6, 3.4, '#3b4a63', '#27324a'));
});
