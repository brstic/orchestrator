import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { body, type Outfit } from '../src/character/body.ts';
import { BROW_COUNT, EYE_AT, FACE_COUNT, IRIS, browsGeo, capGeo, eyesGeo, glassesGeo, hairGeo, headGeo, headphonesGeo, lidGeo, type HairStyle } from '../src/character/head.ts';
import { traitsOf } from '../src/character/look.ts';
import { DESK_TOP as POSED_DESK_TOP, HEAD_SCALE, HEAD_Y, SEAT_TOP, SHOULDER_Y } from '../src/character/motion.ts';
import { DESK_TOP } from '../src/models/workplace.ts';

/**
 * People are sculpted in code like the furniture, so what must stay true of them can be checked without a browser:
 * every part is a sound surface, a whole person stays within a budget of triangles, and the same look always
 * gives the same person.
 */

const STYLES: HairStyle[] = ['short', 'long', 'bun', 'curly', 'bald', 'buzz', 'ponytail', 'afro', 'mohawk'];
const OUTFITS: Outfit[] = ['polo', 'shirt', 'tee', 'sweater', 'suit'];
const tris = (g: THREE.BufferGeometry | null) => (g ? (g.index ? g.index.count : g.getAttribute('position').count) / 3 : 0);

function sound(name: string, g: THREE.BufferGeometry): void {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nor = g.getAttribute('normal') as THREE.BufferAttribute;
  assert.ok(pos && nor, `${name} has positions and normals`);
  for (let i = 0; i < pos.count * 3; i++) assert.ok(Number.isFinite(pos.array[i]) && Number.isFinite(nor.array[i]), `${name} has a vertex that is not a number`);
}

/** The triangles of one person: what the component draws for that hair, outfit and accessory. */
function person(style: HairStyle, outfit: Outfit, accessory: 'none' | 'glasses' | 'headphones' | 'cap'): number {
  const b = body();
  const long = outfit === 'shirt' || outfit === 'sweater' || outfit === 'suit';
  const tucked = outfit === 'polo' || outfit === 'shirt';
  const casual = outfit === 'tee' || outfit === 'sweater';
  let n = tris(headGeo(0)) + tris(eyesGeo(IRIS[0]!)) + 2 * tris(lidGeo()) + tris(browsGeo(0)) + tris(hairGeo(style, accessory === 'cap', false));
  if (accessory === 'glasses') n += tris(glassesGeo());
  if (accessory === 'headphones') n += tris(headphonesGeo(style));
  if (accessory === 'cap') n += tris(capGeo());
  n += tris(outfit === 'suit' ? b.torsoJacket : tucked ? b.torsoTucked : b.torsoLoose) + tris(b.trim[outfit]) + tris(tucked ? b.neckOpen : b.neck) + tris(b.badge);
  if (outfit === 'suit') n += tris(b.tie) + tris(b.suitLapels) + tris(b.suitButtons) + 2 * tris(b.sleeveButtons);
  n += tris(b.pelvis) + (tucked ? tris(b.belt) : 0) + tris(b.legL) + tris(b.legR);
  n += 2 * (tris(casual ? b.trainer : b.shoe) + tris(casual ? b.trainerSole : b.sole));
  n += long ? tris(b.sleeveL) + tris(b.sleeveR) + 2 * tris(outfit === 'sweater' ? b.cuffKnit : b.cuff) : tris(b.armL) + tris(b.armR) + 2 * tris(b.sleeveShort);
  n += tris(b.handL) + tris(b.handR);
  return n;
}

test('every part of a character is a sound surface', () => {
  for (let i = 0; i < FACE_COUNT; i++) sound(`head ${i}`, headGeo(i));
  for (let i = 0; i < BROW_COUNT; i++) sound(`brows ${i}`, browsGeo(i));
  for (const c of IRIS) sound(`eyes ${c}`, eyesGeo(c));
  sound('lid', lidGeo());
  for (const s of STYLES) {
    for (const cap of [false, true]) {
      for (const flip of [false, true]) {
        const g = hairGeo(s, cap, flip);
        if (g) sound(`${s} hair`, g);
        else assert.equal(s, 'bald');
      }
    }
    sound(`headphones over ${s} hair`, headphonesGeo(s));
  }
  sound('glasses', glassesGeo());
  sound('cap', capGeo());
  for (const [name, g] of Object.entries(body())) {
    if (g instanceof THREE.BufferGeometry) sound(name, g);
    else for (const [o, t] of Object.entries(g as Record<string, THREE.BufferGeometry>)) sound(`${name} of a ${o}`, t);
  }
});

test('the parts that are painted carry paint, and cloth carries its weave coordinates', () => {
  const b = body();
  for (const g of [headGeo(0), eyesGeo(IRIS[0]!), lidGeo(), b.belt, b.cuff, b.cuffKnit, ...OUTFITS.map((o) => b.trim[o])]) assert.ok(g.getAttribute('color'), 'a painted part has a colour for every vertex');
  for (const g of [b.torsoTucked, b.torsoLoose, b.torsoJacket, b.pelvis, b.sleeveL, b.sleeveR, b.legL, b.legR, b.sleeveShort]) assert.ok(g.getAttribute('uv1'), 'cloth has weave coordinates');
  // A suit's stripes use the first set on the same parts.
  for (const g of [b.torsoJacket, b.pelvis, b.sleeveL, b.legL, b.suitLapels]) assert.ok(g.getAttribute('uv'), 'striped cloth has stripe coordinates');
  for (const g of [b.sleeveL, b.sleeveR, b.legL, b.legR, b.armL, b.armR]) assert.ok(g.getAttribute('skinIndex') && g.getAttribute('skinWeight'), 'a limb is bound to its two bones');
});

test('lids lie outside the eye and face outward', () => {
  const g = lidGeo();
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nor = g.getAttribute('normal') as THREE.BufferAttribute;
  const col = g.getAttribute('color') as THREE.BufferAttribute;
  // (The skin of the lid; the dark bead of lashes along its edge is round, and faces every way.)
  let skin = 0;
  let out = 0;
  for (let i = 0; i < pos.count; i++) {
    if (col.getX(i) < 0.5) continue;
    skin++;
    if (pos.getX(i) * nor.getX(i) * 0.4 + pos.getY(i) * nor.getY(i) + pos.getZ(i) * nor.getZ(i) > 0) out++;
  }
  assert.ok(skin > 0 && out === skin, `${out} of ${skin} lid normals point away from the eye`);
  // The eyes are in the front of the head, level, and a natural distance apart.
  assert.ok(EYE_AT.z > 0.06 && EYE_AT.z < 0.1 && EYE_AT.x > 0.03 && EYE_AT.x < 0.05 && Math.abs(EYE_AT.y) < 0.02);
});

test('a person stays within the budget of triangles', () => {
  // Before the remodelling a person was 16–28 thousand triangles (short hair and a polo: 21 thousand).
  let worst = 0;
  let sum = 0;
  let count = 0;
  for (const s of STYLES) {
    for (const o of OUTFITS) {
      for (const a of ['none', 'glasses', 'headphones', 'cap'] as const) {
        const n = person(s, o, a);
        worst = Math.max(worst, n);
        sum += n;
        count++;
      }
    }
  }
  const usual = person('short', 'polo', 'none');
  assert.ok(usual < 25000, `short hair and a polo: ${usual} triangles (budget 25000)`);
  assert.ok(worst < 30000, `the heaviest person has ${worst} triangles (budget 30000)`);
  assert.ok(sum / count < 25000, `a person has ${Math.round(sum / count)} triangles on average (budget 25000)`);
});

test('the same look is always the same person, and different looks differ', () => {
  const a = { skin: '#e0ac69', hair: '#2c1b10', hairStyle: 'short', shirt: '#4f8cff', pants: '#27364a', accessory: 'none', build: 1 } as const;
  assert.deepEqual(traitsOf(a, 1), traitsOf({ ...a }, 1));
  assert.equal(traitsOf(a, 9).outfit, 'suit');
  // Nothing but the outfit depends on the level.
  assert.deepEqual({ ...traitsOf(a, 9), outfit: null }, { ...traitsOf(a, 1), outfit: null });
  const seen = new Set<string>();
  const shirts = ['#4f8cff', '#ff8c5a', '#5ad67d', '#f5c542', '#8f7bff', '#e6d3a3', '#ff5d73', '#3fd0c9'];
  for (const shirt of shirts) for (const skin of ['#ffdbac', '#c68642', '#8d5524']) {
    const t = traitsOf({ ...a, shirt, skin }, 1);
    seen.add(`${t.face}|${t.brow}|${t.iris}|${t.flip}`);
    assert.ok(t.headW > 0.96 && t.headW < 1.05 && t.headD > 0.97 && t.headD < 1.03 && t.girth > 0.96 && t.girth < 1.07);
  }
  assert.ok(seen.size >= 10, `24 looks give ${seen.size} different faces`);
});

test('the body is the size the furniture and the poses expect', () => {
  assert.equal(POSED_DESK_TOP, DESK_TOP, 'the pose that rests on the desk uses the desk\'s real height');
  assert.equal(SEAT_TOP, 0.51);
  // The neck reaches from under the collar to inside the head.
  const neck = body().neck;
  neck.computeBoundingBox();
  assert.ok(neck.boundingBox!.min.y < SHOULDER_Y + 0.06 && neck.boundingBox!.max.y > HEAD_Y + 0.03);
  // The head at its drawn size still clears the shoulders.
  const head = headGeo(0);
  head.computeBoundingBox();
  assert.ok(HEAD_Y + (0.103 + head.boundingBox!.min.y) * HEAD_SCALE > SHOULDER_Y + 0.08, 'the chin is above the shoulders');
});

test('seated, a garment over the hips lies on the thighs, not through them; the jacket\'s back lies on the seat', () => {
  // The owner: "clothes sometimes flicker from some angles" (2026-11-17) — the thighs and the seat cut through the hem.
  const g = body();
  const R = 0.092; // the trouser leg where it leaves the seat
  const HIP = 0.078;
  for (const [name, geo] of [['loose', g.torsoLoose], ['jacket', g.torsoJacket], ['sweater hem', g.trim.sweater]] as const) {
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const m = geo.morphAttributes.position;
    assert.equal(m?.length, 3, `${name}: three morph targets (left lap, right lap, seat)`);
    let under = 0;
    let checked = 0;
    for (let i = 0; i < pos.count; i++) {
      // Both thighs up and on the seat: every target at 1.
      let x = pos.getX(i);
      let y = pos.getY(i);
      let z = pos.getZ(i);
      for (const t of m!) {
        x += t.getX(i);
        y += t.getY(i);
        z += t.getZ(i);
      }
      const dx = Math.max(0, Math.abs(x) - HIP);
      // Over a thigh, in front of the hip joint: the cloth must be above the top of the thigh.
      if (z > 0.05 && dx < R * 0.9) {
        checked++;
        if (y < Math.sqrt(R * R - dx * dx) - 0.002) under++;
      }
      // Behind: never below the seat.
      if (z < -0.06) assert.ok(y > -0.05, `${name}: a point of the back is below the seat (${y.toFixed(3)})`);
    }
    assert.ok(checked > 10, `${name}: points over the thighs were looked at`);
    assert.equal(under, 0, `${name}: ${under} points of the hem are inside a thigh when seated`);
  }
  // Standing nothing moves: the targets are offsets, at 0 the garment is as it was.
  assert.equal(g.torsoTucked.morphAttributes.position, undefined, 'a tucked-in shirt is inside the trousers and needs none');
});

test("facial hair is the head's own triangles in a group of their own — nothing lies on the face", () => {
  for (let face = 0; face < FACE_COUNT; face++) {
    const plain = headGeo(face);
    for (const kind of ['stubble', 'mustache', 'goatee', 'beard'] as const) {
      const g = headGeo(face, kind);
      sound(`head ${face} with ${kind}`, g);
      // The same surface: as many vertices and triangles as the head without it, split into skin and hair.
      assert.equal(g.getAttribute('position').count, plain.getAttribute('position').count, `${kind}: no new surface`);
      assert.equal(g.index!.count, plain.index!.count);
      assert.equal(g.groups.length, 2);
      const [skin, hair] = g.groups;
      assert.ok(hair!.count > 0 && skin!.count > hair!.count, `${kind}: some of the face, not all of it`);
    }
    // More hair for a beard than for a goatee, and for a goatee than for a mustache.
    const n = (k: 'mustache' | 'goatee' | 'beard') => headGeo(face, k).groups[1]!.count;
    assert.ok(n('beard') > n('goatee') && n('goatee') > n('mustache'), `face ${face}: beard > goatee > mustache`);
  }
});

test('a look chooses for itself: outfit, face, brows, eyes, build — and a look that chooses nothing is drawn as before', () => {
  const plain = { skin: '#e0ac69', hair: '#241c17', hairStyle: 'short', shirt: '#2b3c66', pants: '#2b3c66', accessory: 'none', build: 1 } as const;
  const before = traitsOf(plain, 1);
  assert.ok(before.brow < 3, 'a made-up look keeps to the first three brows (as every look made before did)');
  const chosen = traitsOf({ ...plain, outfit: 'sweater', face: 2, brows: 4, eyes: '#3f78ad', girth: 1.05 }, 9);
  assert.deepEqual([chosen.outfit, chosen.face, chosen.brow, chosen.iris, chosen.girth], ['sweater', 2, 4, '#3f78ad', 1.05], 'even at a level that would put them in a suit');
  assert.deepEqual(traitsOf(plain, 1), before, 'the same look is the same person');
});
