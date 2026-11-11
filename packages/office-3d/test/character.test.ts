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

const STYLES: HairStyle[] = ['short', 'long', 'bun', 'curly', 'bald'];
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
