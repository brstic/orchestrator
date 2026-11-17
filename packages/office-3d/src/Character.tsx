import { lookKey } from './looks.ts';
import { useFrame } from '@react-three/fiber';
import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Appearance } from '@orchestrator/contracts';
import { BADGE_Z, PIN_Z, body } from './character/body.ts';
import { EYE_AT, EYE_YAW, LID_CLOSE, browsGeo, capGeo, eyesGeo, glassesGeo, hairGeo, headGeo, headphonesGeo, lidGeo } from './character/head.ts';
import { SHOES, SKINNED_DEPTH, TIES, badgeMat, eyeMat, mat, skinned, sparkMat, traitsOf, zTexture, type MatOptions } from './character/look.ts';
import {
  HEAD_SCALE,
  HEAD_Y,
  HIP_X,
  LASH_TIP,
  NKEYS,
  POSE_KEYS,
  SEAT_TOP,
  SHIN,
  SHOULDER_X,
  SHOULDER_Y,
  SLEEP_BREATH,
  THIGH,
  UPPER_ARM,
  WHIP_CRACK,
  WHIP_END,
  clamp,
  clamp01,
  doze,
  handTurn,
  lashGeometry,
  lerp,
  newLoco,
  newPose,
  emote,
  isEmotePose,
  ouch,
  poseAt,
  shapeLash,
  smooth,
  stepLoco,
  upright,
  whipArm,
  wrapPi,
  type Loco,
  type Motion,
  type Pose,
  type PoseName,
} from './character/motion.ts';

/**
 * A stylised, fully procedural office worker: no asset files, a small jointed
 * rig, and motion generated at runtime. The pose is chosen by the caller from
 * the employee's real state; this component only knows how to move a body.
 *
 * The rest of the code is under `character/`:
 *   - `motion.ts` — how a body moves: seated poses as functions of time, a gait generator with leg IK for anyone
 *     on their feet, the one-shot reactions, and inertial blending between poses (below, in this file);
 *   - `shape.ts`  — the tools the body is sculpted with (lofts, rings, limbs skinned to two bones, paint, cloth);
 *   - `head.ts`   — the head and face, eyes and lids, brows, hair per style, glasses, headphones, cap;
 *   - `body.ts`   — trunk and garments, collars and cuffs, arms, legs, hands, shoes;
 *   - `look.ts`   — materials, and what tells one person from the next.
 * Every geometry is built once and shared by all characters; materials are cached by colour.
 */
export type { Motion, PoseName } from './character/motion.ts';

interface CharacterProps {
  appearance: Appearance;
  pose: PoseName;
  /** Greyed out: no live session behind this employee. */
  offline?: boolean;
  /** Extra head yaw toward a point of interest (e.g. the boss when asking a question). Read every frame. */
  look?: { current: number };
  level?: number;
  phase?: number;
  /** Skip per-frame animation for characters far from the camera. */
  frozen?: () => boolean;
  /**
   * How the character is moving while on its feet, read every frame. Without it the character measures its own
   * movement through the world, so anything that moves a standing character makes it walk. (Best moved from a
   * `useFrame` that runs before this one — priority −1 — so the feet are placed for where the body is drawn.)
   */
  motion?: { current: Motion };
  /** Seconds since this character's jump began, read every frame (below 0: not jumping). Only someone on their feet jumps. */
  jump?: { current: number };
  /** Change this to restart a one-shot pose ('ouch', 'whip') while the pose name stays the same. */
  cue?: number;
  /** Carries a whip: coiled at the right hip, in the right hand during the 'whip' pose. */
  whip?: boolean;
  /** Overrides for details the appearance does not cover. */
  detail?: { tie?: string; shoes?: string };
}

/** Bones of a character's skeleton, in order: left hip, left knee, right hip, right knee, left shoulder, left elbow, right shoulder, right elbow. */
const BONE_INVERSES = [0, THIGH, 0, THIGH, 0, UPPER_ARM, 0, UPPER_ARM].map((up) => new THREE.Matrix4().makeTranslation(0, up, 0));
const IDENTITY = new THREE.Matrix4();
/** Generous bounds for a skinned limb in any pose (its own are only ever computed for one pose). */
const LIMB_BOUNDS = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1);
const TARGET = newPose();
/** Half-life of the offset left over from a change of pose, seconds. */
const BLEND_HALF = 0.12;
/** Falling asleep and waking up take about a second: the part of the body that leads, and the part that follows. */
const SLEEP_LEAD = 0.17;
const SLEEP_FOLLOW = 0.3;
/** Pose values that belong to the arms (the rest is the trunk, the head and the legs). */
const ARM_KEY = POSE_KEYS.map((k) => k === 'sLx' || k === 'sLz' || k === 'tL' || k === 'eL' || k === 'sRx' || k === 'sRz' || k === 'tR' || k === 'eR' || k === 'wrL' || k === 'wfL' || k === 'wrR' || k === 'wfR');
const sleeping = (p: PoseName | null) => p === 'offline' || p === 'doze';
const NO_RAYCAST = () => null;
/** How many letters are in the air over a sleeper at once, how long each one lives (seconds) and how far it rises (metres). */
const Z_COUNT = 3;
const Z_LIFE = 3.6;
const Z_RISE = 0.5;
const Z_LETTERS = Array.from({ length: Z_COUNT }, (_v, i) => i);
const TMP_M = new THREE.Matrix4();
const TMP_A = new THREE.Vector3();
const TMP_B = new THREE.Vector3();
const TMP_Q = new THREE.Quaternion();
const TMP_R = new THREE.Quaternion();
const TMP_E = new THREE.Euler();
const X_AXIS = new THREE.Vector3(1, 0, 0);

/**
 * The foot at the end of a leg: whichever way the hip is flexed, spread and turned and the knee bent, the sole ends up
 * pointing where the leg was turned to and tipped only heel-to-toe — flat on the floor, never rolled onto its edge.
 */
function levelFoot(foot: THREE.Group | null, flex: number, abd: number, yaw: number, knee: number, ankle: number): void {
  if (!foot) return;
  TMP_Q.setFromEuler(TMP_E.set(flex, yaw, abd, 'ZXY')).multiply(TMP_R.setFromAxisAngle(X_AXIS, knee)).invert();
  foot.quaternion.copy(TMP_Q.multiply(TMP_R.setFromEuler(TMP_E.set(ankle + flex + knee, yaw, 0, 'YXZ'))));
}

interface Anim {
  cur: Pose;
  off: Float32Array;
  offV: Float32Array;
  vel: Float32Array;
  loco: Loco;
  applied: PoseName | null;
  /** The pose a one-shot reaction is layered over. */
  base: PoseName;
  prevBase: PoseName | null;
  cue: number | undefined;
  /** Seconds since the pose (or the cue) last changed. */
  since: number;
  /** How fast what is left of the previous pose dies away, per pose value (1/s). */
  rate: Float32Array;
  /** 0 awake … 1 asleep, eased: drives the breathing and the letters. */
  sleep: number;
  /** The jump's clock as last seen: one that went back is a new jump begun before the last was over. */
  air: number;
}

export function Character({ appearance, pose, offline = false, look, level = 1, phase = 0, frozen, motion, jump, cue, whip = false, detail }: CharacterProps) {
  const outer = useRef<THREE.Group>(null);
  const root = useRef<THREE.Group>(null);
  const hips = useRef<THREE.Group>(null);
  const pelvis = useRef<THREE.Group>(null);
  const spine = useRef<THREE.Group>(null);
  const chest = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const lidL = useRef<THREE.Mesh>(null);
  const lidR = useRef<THREE.Mesh>(null);
  const pelvisBody = useRef<THREE.Group>(null);
  const armL = useRef<THREE.Group>(null);
  const armR = useRef<THREE.Group>(null);
  const sL = useRef<THREE.Group>(null);
  const sR = useRef<THREE.Group>(null);
  const eL = useRef<THREE.Group>(null);
  const eR = useRef<THREE.Group>(null);
  const handL = useRef<THREE.Group>(null);
  const handR = useRef<THREE.Group>(null);
  const hL = useRef<THREE.Group>(null);
  const hR = useRef<THREE.Group>(null);
  const kL = useRef<THREE.Group>(null);
  const kR = useRef<THREE.Group>(null);
  const fL = useRef<THREE.Group>(null);
  const fR = useRef<THREE.Group>(null);
  const legLm = useRef<THREE.SkinnedMesh>(null);
  const legRm = useRef<THREE.SkinnedMesh>(null);
  const armLm = useRef<THREE.SkinnedMesh>(null);
  const armRm = useRef<THREE.SkinnedMesh>(null);
  const coil = useRef<THREE.Mesh>(null);
  const lash = useRef<THREE.Mesh>(null);
  const spark = useRef<THREE.Mesh>(null);
  const zzz = useRef<THREE.Group>(null);
  const anim = useRef<Anim | null>(null);
  const poseRef = useRef(pose);
  poseRef.current = pose;
  const cueRef = useRef(cue);
  cueRef.current = cue;
  const build = appearance.build || 1;

  const look3d = useMemo(() => {
    const g = body();
    const who = traitsOf(appearance, level);
    const { seed, outfit } = who;
    const longSleeves = outfit === 'shirt' || outfit === 'sweater' || outfit === 'suit';
    const tucked = outfit === 'polo' || outfit === 'shirt';
    const casual = outfit === 'tee' || outfit === 'sweater';
    const cap = appearance.accessory === 'cap';
    const shoeHex = detail?.shoes ?? appearance.shoes ?? (outfit === 'suit' ? SHOES[0]! : SHOES[(seed >>> 3) % (casual ? 4 : 3)]!);
    const lightShoe = new THREE.Color(shoeHex).getHSL({ h: 0, s: 0, l: 0 }).l > 0.6;
    // Each garment is its own cloth: piqué, jersey, crisp poplin, knitted wool, striped worsted.
    const cloth: MatOptions = outfit === 'polo' ? { grain: 'weave', depth: 0.9 } : outfit === 'tee' ? { grain: 'weave', depth: 0.3 } : outfit === 'sweater' ? { grain: 'knit', depth: 1.5 } : outfit === 'suit' ? { stripe: true, grain: 'weave', depth: 0.35 } : {};
    const rough = outfit === 'shirt' ? 0.68 : outfit === 'suit' ? 0.72 : outfit === 'sweater' ? 0.96 : 0.88;
    const trim: MatOptions =
      outfit === 'suit' ? {} : outfit === 'polo' ? { shade: 0.05, grain: 'weave', depth: 0.9 } : outfit === 'shirt' ? { shade: 0.06 } : outfit === 'tee' ? { shade: -0.14, grain: 'knit', depth: 0.8 } : { shade: -0.1, grain: 'knit', depth: 1.8 };
    const hair = hairGeo(appearance.hairStyle, cap, who.flip);
    return {
      g,
      who,
      outfit,
      longSleeves,
      tucked,
      casual,
      torso: outfit === 'suit' ? g.torsoJacket : tucked ? g.torsoTucked : g.torsoLoose,
      // (With facial hair, the head carries it as a second group of its own triangles: drawn with `[face, beard]`.)
      head: headGeo(who.face, appearance.facialHair && appearance.facialHair !== 'none' ? appearance.facialHair : null),
      bearded: !!appearance.facialHair && appearance.facialHair !== 'none',
      eyes: eyesGeo(who.iris),
      brows: browsGeo(who.brow),
      hair,
      phones: appearance.accessory === 'headphones' ? headphonesGeo(appearance.hairStyle) : null,
      // Skin is matt; the face (and the lids) carry paint: lips, the line of the mouth, lashes.
      skin: mat(appearance.skin, 0.74, offline, { sheen: 0.5 }),
      face: mat(appearance.skin, 0.74, offline, { sheen: 0.5, painted: true }),
      eye: eyeMat(offline),
      hairMat: appearance.hairStyle === 'curly' || appearance.hairStyle === 'afro' ? mat(appearance.hair, 0.78, offline, { grain: 'curl', depth: 0.55, sheen: 0.6 }) : mat(appearance.hair, 0.56, offline),
      // Hair on the face, in the colour of the hair; stubble is so short that the skin shows through it.
      beard: appearance.facialHair === 'stubble' ? mat('#' + new THREE.Color(appearance.hair).lerp(new THREE.Color(appearance.skin), 0.45).getHexString(), 0.9, offline) : mat(appearance.hair, 0.82, offline, { sheen: 0.5 }),
      glasses: appearance.accessory === 'glasses' || appearance.glasses === true,
      brow: mat(appearance.hair, 0.8, offline, { shade: -0.25 }),
      shirt: mat(appearance.shirt, rough, offline, cloth),
      trim: mat(outfit === 'suit' ? '#f1f1ee' : appearance.shirt, outfit === 'suit' ? 0.7 : rough, offline, { ...trim, decal: true, painted: true }),
      // The jacket's own cloth (the same weave and stripe, a shade lighter): smoother and lighter, its collar and pocket
      // flaps read as grey patches stuck on.
      lapel: mat(appearance.shirt, 0.7, offline, { shade: 0.012, decal: true, stripe: true, grain: 'weave', depth: 0.35 }),
      tie: mat(detail?.tie ?? appearance.tie ?? TIES[seed % TIES.length]!, 0.5, offline, { decal: true }),
      pants: outfit === 'suit' ? mat(appearance.pants, 0.74, offline, { stripe: true, grain: 'weave', depth: 0.35 }) : mat(appearance.pants, 0.86, offline, { grain: 'weave', depth: 0.7 }),
      belt: mat('#ffffff', 0.45, offline, { painted: true }),
      shoe: mat(shoeHex, casual ? 0.8 : 0.36, offline),
      sole: mat(lightShoe ? '#b9b3a6' : casual ? '#e9e6df' : '#0f1013', 0.75, offline),
      dark: mat('#181b22', 0.35, offline),
      capMat: mat(appearance.shirt, 0.8, offline, { shade: -0.12 }),
      leather: mat('#5a3519', 0.55, offline),
      badge: badgeMat(level, offline),
    };
  // (By every field of the look — `lookKey` — so that each choice of the character creator shows at once.)
  }, [lookKey(appearance), offline, level, detail?.tie, detail?.shoes]); // eslint-disable-line react-hooks/exhaustive-deps

  // Arms and legs are each one skinned surface; the joints of this rig are their bones.
  useLayoutEffect(() => {
    const bones = [hL, kL, hR, kR, sL, eL, sR, eR].map((r) => r.current) as unknown as THREE.Bone[];
    const skeleton = new THREE.Skeleton(bones, BONE_INVERSES);
    for (const r of [legLm, legRm, armLm, armRm]) {
      const mesh = r.current;
      if (!mesh) continue;
      mesh.bind(skeleton, IDENTITY);
      mesh.boundingSphere = LIMB_BOUNDS;
    }
    return () => skeleton.dispose();
  }, []);

  // The lash is the one geometry that is not shared: its shape changes every frame of a swing.
  const lashGeo = useMemo(() => (whip ? lashGeometry() : null), [whip]);

  useFrame((state, rawDt) => {
    const name = poseRef.current;
    const isFrozen = frozen?.() ?? false;
    let A = anim.current;
    // Far away: hold the last pose, but still snap once if the pose itself changed.
    if (isFrozen && A && A.applied === name && A.cue === cueRef.current) {
      // Nothing hangs in the air over someone who is not being animated.
      if (zzz.current) zzz.current.visible = false;
      return;
    }
    if (!A) A = anim.current = { cur: newPose(), off: new Float32Array(NKEYS), offV: new Float32Array(NKEYS), vel: new Float32Array(NKEYS), loco: newLoco(), applied: null, base: 'still', prevBase: null, cue: undefined, since: 0, rate: new Float32Array(NKEYS).fill(1.386 / BLEND_HALF), sleep: sleeping(name) ? 1 : 0, air: -1 };
    const dt = Math.min(rawDt, 0.05);
    const t = state.clock.elapsedTime;
    const first = A.applied === null;
    const changed = first || A.applied !== name || A.cue !== cueRef.current;
    A.since = changed ? 0 : A.since + dt;
    const gesture = isEmotePose(name);
    const reaction = name === 'ouch' || name === 'whip' || gesture;
    if (!reaction) A.base = name;
    else if (first) A.base = name === 'whip' || gesture ? 'stand' : 'still';
    const base = A.base;
    const L = A.loco;
    let pumping = 0;
    // A jump begun while the last one was still landing starts from that landing, not from standing.
    const air = jump ? jump.current : -1;
    const again = air >= 0 && A.air > air + 1e-4;
    A.air = air;
    L.air = air;

    // ── the pose this frame ──
    if (base === 'walk' || base === 'stand' || base === 'doze') {
      let vx = 0;
      let vz = 0;
      let turn = 0;
      let run: boolean | null = null;
      let took = dt;
      if (motion) {
        const m = motion.current;
        vx = m.vx;
        vz = m.vz;
        turn = m.turn;
        run = m.run;
      } else if (outer.current && dt > 1e-4) {
        // Nobody told us how we are moving: read it off our own transform. Whoever moves us has either done so already
        // this frame (then the move is this frame's), or will only do so after us (then what we see is the move of the
        // frame before, which took as long as that frame did). Mixing the two up would make the feet slide whenever
        // the frame rate is uneven.
        const e = outer.current.matrixWorld.elements;
        const ox = e[12]!;
        const oz = e[14]!;
        const or = e[8]!;
        outer.current.updateWorldMatrix(true, false);
        const wx = e[12]!;
        const wz = e[14]!;
        const yaw = Math.atan2(e[8]!, e[10]!);
        if (L.has) {
          const dx = wx - L.px;
          const dz = wz - L.pz;
          const dyaw = wrapPi(yaw - L.yaw);
          // A jump is a teleport, not a sprint.
          if (dx * dx + dz * dz < 0.3 && Math.abs(dyaw) < 0.3) {
            took = wx !== ox || wz !== oz || e[8] !== or || L.pdt <= 1e-4 ? dt : L.pdt;
            const sy = Math.sin(yaw);
            const cy = Math.cos(yaw);
            vx = (dx * cy - dz * sy) / took;
            vz = (dx * sy + dz * cy) / took;
            turn = dyaw / took;
          }
        }
        L.px = wx;
        L.pz = wz;
        L.yaw = yaw;
        L.pdt = dt;
        L.has = true;
      }
      if (isFrozen) {
        L.has = false;
        L.fresh = true;
      }
      stepLoco(L, dt, vx / build, vz / build, turn, run, took);
      upright(TARGET, t, phase, L);
      pumping = L.run * L.arms;
      if (base === 'doze') doze(TARGET, t, phase);
    } else {
      if (L.amp !== 0 || L.has) {
        L.has = false;
        L.fresh = true;
        L.amp = L.run = L.vx = L.vz = L.sx = L.sz = L.turn = L.face = L.speed = L.raw = L.arms = 0;
      }
      poseAt(base, t, phase, TARGET, build);
    }
    if (name === 'ouch') ouch(TARGET, A.since);
    else if (name === 'whip') whipArm(TARGET, A.since);
    else if (gesture) emote(TARGET, name, A.since);
    if (look) TARGET.headYaw += look.current;

    // ── blend: what is left of the previous pose rides on top of the new one and dies away ──
    const c = A.cur;
    if (first || isFrozen) {
      for (let i = 0; i < NKEYS; i++) {
        c[POSE_KEYS[i]!] = TARGET[POSE_KEYS[i]!];
        A.off[i] = A.offV[i] = A.vel[i] = 0;
      }
    } else {
      if (changed || again) {
        // A reaction starts from, and returns to, the pose under it: only a real change of pose carries momentum.
        const carry = base !== A.prevBase || again;
        // Falling asleep, the arms go down on the desk first and the head follows; waking, the back straightens first
        // and the arms come after. Either way it takes about a second, and nothing passes through the desk.
        const toSleep = sleeping(base) && !sleeping(A.prevBase);
        const toWake = !sleeping(base) && sleeping(A.prevBase);
        for (let i = 0; i < NKEYS; i++) {
          const key = POSE_KEYS[i]!;
          A.off[i] = c[key] - TARGET[key];
          if (carry) {
            A.offV[i] = clamp(A.vel[i]!, -4, 4);
            A.rate[i] = 1.386 / (toSleep ? (ARM_KEY[i] ? SLEEP_LEAD : SLEEP_FOLLOW) : toWake ? (ARM_KEY[i] ? SLEEP_FOLLOW : SLEEP_LEAD) : BLEND_HALF);
          }
        }
      }
      for (let i = 0; i < NKEYS; i++) {
        const key = POSE_KEYS[i]!;
        let x = A.off[i]!;
        let v = A.offV[i]!;
        const y = A.rate[i]!;
        const decay = Math.exp(-y * dt);
        const j1 = v + x * y;
        x = decay * (x + j1 * dt);
        v = decay * (v - j1 * y * dt);
        A.off[i] = x;
        A.offV[i] = v;
        const next = TARGET[key] + x;
        if (dt > 1e-4) A.vel[i] = (next - c[key]) / dt;
        c[key] = next;
      }
    }
    A.applied = name;
    A.prevBase = base;
    A.cue = cueRef.current;

    // ── pose → rig ──
    if (root.current) {
      // Legs scale with the build, the chair does not: keep the seat contact fixed.
      const seated = smooth(0.78, 0.62, c.hipY);
      root.current.position.set(c.hipX, c.hipY + seated * SEAT_TOP * (1 / build - 1), c.hipZ);
    }
    if (hips.current) hips.current.rotation.y = c.pelYaw;
    // The seat of the trousers turns with the jacket rather than with the legs, so the two never cut through each other.
    pelvis.current?.rotation.set(c.lean * 0.85, c.twist - c.pelYaw, c.pelRoll, 'YXZ');
    spine.current?.rotation.set(c.lean, c.twist, c.side, 'YXZ');
    if (head.current) head.current.rotation.set(c.headPitch, clamp(c.headYaw, -1.2, 1.2), c.headRoll);
    if (armL.current) armL.current.position.y = SHOULDER_Y + c.shrug;
    if (armR.current) armR.current.position.y = SHOULDER_Y + c.shrug;
    sL.current?.rotation.set(c.sLx, -c.tL, c.sLz, 'XZY');
    sR.current?.rotation.set(c.sRx, c.tR, c.sRz, 'XZY');
    if (eL.current) eL.current.rotation.x = c.eL;
    if (eR.current) eR.current.rotation.x = c.eR;
    // Palms turn down as the elbow bends (keyboard, desk) and forward when the arm is raised.
    // A runner's bent arms keep the thumbs up.
    const desk = 1 - 0.75 * pumping;
    // (On top of that, what a pose asks of the hands: a roll, and a bend at the wrist toward the palm.)
    if (handL.current) handTurn(handL.current.rotation, c, true, desk);
    if (handR.current) handTurn(handR.current.rotation, c, false, desk);
    hL.current?.rotation.set(c.hL, c.yL, c.aL, 'ZXY');
    hR.current?.rotation.set(c.hR, c.yR, c.aR, 'ZXY');
    if (kL.current) kL.current.rotation.x = c.kL;
    if (kR.current) kR.current.rotation.x = c.kR;
    levelFoot(fL.current, c.hL, c.aL, c.yL, c.kL, c.fL);
    levelFoot(fR.current, c.hR, c.aR, c.yR, c.kR, c.fR);
    // Asleep: eyes shut, slow deep breaths, and a few letters drifting up. (Someone offline who is walking somewhere is awake.)
    const asleep = sleeping(name);
    A.sleep += ((asleep ? 1 : 0) - A.sleep) * (first || isFrozen ? 1 : 1 - Math.exp(-dt / 0.35));
    if (lidL.current && lidR.current) {
      const blink = (t + phase * 1.7) % 4.6;
      // The eyes close as the head goes down, and open only once it is up again.
      const lids = clamp01((A.sleep - 0.25) / 0.5);
      const open = name === 'ouch' && A.since < 0.45 ? 0.16 : blink < 0.16 ? 1 - 0.9 * Math.sin((blink / 0.16) * Math.PI) : 1;
      lidL.current.rotation.x = lidR.current.rotation.x = lerp(1 - open, 1, lids) * LID_CLOSE;
    }
    if (chest.current) {
      // A hem over the hips follows the thighs (`addSeatedMorph`): each half of the front its own thigh as it rises
      // (a stride, a run, sitting), the back the seat.
      const lapL = smooth(0.2, 1.35, -c.hL);
      const lapR = smooth(0.2, 1.35, -c.hR);
      const onSeat = smooth(0.45, 1.35, -(c.hL + c.hR) / 2);
      for (const m of chest.current.children) {
        const mesh = m as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry.morphAttributes.position) continue;
        if (!mesh.morphTargetInfluences || mesh.morphTargetInfluences.length !== 3) mesh.updateMorphTargets();
        const k = mesh.morphTargetInfluences;
        if (k && k.length === 3) {
          k[0] = lapL;
          k[1] = lapR;
          k[2] = onSeat;
        }
      }
      const awake = 0.5 + 0.5 * Math.sin(t * 1.3 + phase * 1.9);
      const deep = 0.5 + 0.5 * Math.sin(t * SLEEP_BREATH + phase * 1.9);
      const girth = look3d.who.girth;
      chest.current.scale.set(girth * (1 + lerp(awake * 0.004, deep * 0.012, A.sleep)), 1, girth * (1 + lerp(awake * (0.016 + 0.012 * L.run), deep * 0.05, A.sleep)));
    }
    if (zzz.current && outer.current && head.current) {
      const show = A.sleep > 0.02 && !isFrozen;
      zzz.current.visible = show;
      if (show) {
        // The letters start beside the head, wherever the pose has put it, and float up and away from the name tag.
        head.current.updateWorldMatrix(true, false);
        TMP_M.copy(outer.current.matrixWorld).invert();
        TMP_A.set(0, 0.1, 0).applyMatrix4(head.current.matrixWorld).applyMatrix4(TMP_M);
        const drift = Math.sin(phase * 12.9898 + 1.3) >= 0 ? -1 : 1;
        const kids = zzz.current.children;
        for (let i = 0; i < kids.length; i++) {
          const sp = kids[i] as THREE.Sprite;
          const u = (((t + phase) / Z_LIFE + i / kids.length) % 1 + 1) % 1;
          const e = 1 - (1 - u) * (1 - u);
          const size = (0.065 + 0.1 * u) / build;
          sp.position.set(TMP_A.x + drift * (0.09 + 0.2 * u + 0.03 * Math.sin(u * 9 + i * 2.1)), TMP_A.y + 0.1 + (Z_RISE * e) / build, TMP_A.z);
          sp.scale.set(size, size, 1);
          sp.material.rotation = drift * -0.25 + 0.2 * Math.sin(u * 5 + i);
          sp.material.opacity = A.sleep * 0.92 * smooth(0, 0.14, u) * (1 - smooth(0.62, 1, u));
        }
      }
    }

    // ── the whip ──
    if (lashGeo && lash.current && coil.current && outer.current && handR.current && eR.current) {
      const swinging = name === 'whip' && A.since < WHIP_END + 0.02;
      lash.current.visible = swinging;
      coil.current.visible = !swinging;
      let crack = false;
      if (swinging) {
        // Hand and forearm in the character's own frame, with this frame's pose.
        handR.current.updateWorldMatrix(true, false);
        TMP_M.copy(outer.current.matrixWorld).invert();
        TMP_A.setFromMatrixPosition(handR.current.matrixWorld).applyMatrix4(TMP_M);
        TMP_B.setFromMatrixPosition(eR.current.matrixWorld).applyMatrix4(TMP_M);
        TMP_B.subVectors(TMP_A, TMP_B).normalize();
        shapeLash(lashGeo, A.since, TMP_A.x, TMP_A.y, TMP_A.z, TMP_B.x, TMP_B.y, TMP_B.z, 0.02);
        const k = (A.since - (WHIP_CRACK - 0.025)) / 0.12;
        if (spark.current && k > 0 && k < 1) {
          crack = true;
          spark.current.position.copy(LASH_TIP);
          spark.current.scale.setScalar(0.06 + 0.26 * Math.sin(k * Math.PI));
          spark.current.rotation.set(k * 2, k * 3, k * 5);
        }
      }
      if (spark.current) spark.current.visible = crack;
    }
  });

  const { g, who } = look3d;
  const LIDS = lidGeo();
  const suit = look3d.outfit === 'suit';
  const sweater = look3d.outfit === 'sweater';
  // The letters exist only for someone who is asleep (or was, a moment ago: they fade with the pose).
  const sleepy = sleeping(pose) || offline;

  const arm = (anchor: React.RefObject<THREE.Group | null>, ref: React.RefObject<THREE.Group | null>, elbow: React.RefObject<THREE.Group | null>, hand: React.RefObject<THREE.Group | null>, skin: React.RefObject<THREE.SkinnedMesh | null>, side: 1 | -1) => (
    <group ref={anchor} position={[SHOULDER_X * side, SHOULDER_Y, 0]}>
      <group ref={ref}>
        <skinnedMesh
          ref={skin}
          geometry={look3d.longSleeves ? (side > 0 ? g.sleeveL : g.sleeveR) : side > 0 ? g.armL : g.armR}
          material={skinned(look3d.longSleeves ? look3d.shirt : look3d.skin)}
          customDepthMaterial={SKINNED_DEPTH}
          castShadow
        />
        {!look3d.longSleeves && <mesh geometry={g.sleeveShort} material={look3d.shirt} />}
        <group ref={elbow} position={[0, -UPPER_ARM, 0]}>
          {look3d.longSleeves && <mesh geometry={sweater ? g.cuffKnit : g.cuff} material={look3d.trim} />}
          {suit && <mesh geometry={g.sleeveButtons} material={look3d.dark} />}
          <group ref={hand} position={[0, -0.225, 0]}>
            <mesh geometry={side > 0 ? g.handL : g.handR} material={look3d.skin} castShadow />
          </group>
        </group>
      </group>
    </group>
  );

  const leg = (ref: React.RefObject<THREE.Group | null>, knee: React.RefObject<THREE.Group | null>, ankle: React.RefObject<THREE.Group | null>, skin: React.RefObject<THREE.SkinnedMesh | null>, side: 1 | -1) => (
    <group position={[HIP_X * side, 0, 0]}>
      <group ref={ref}>
        <skinnedMesh ref={skin} geometry={side > 0 ? g.legL : g.legR} material={skinned(look3d.pants)} customDepthMaterial={SKINNED_DEPTH} castShadow />
        <group ref={knee} position={[0, -THIGH, 0]}>
          <group ref={ankle} name={side > 0 ? 'foot-l' : 'foot-r'} position={[0, -SHIN, 0]}>
            <group rotation={[0, 0.08 * side, 0]}>
              <mesh geometry={look3d.casual ? g.trainer : g.shoe} material={look3d.shoe} castShadow />
              <mesh geometry={look3d.casual ? g.trainerSole : g.sole} material={look3d.sole} />
            </group>
          </group>
        </group>
      </group>
    </group>
  );

  return (
    <group ref={outer} scale={build}>
      <group ref={root}>
        <group ref={hips}>
          <group ref={pelvis}>
            <group ref={pelvisBody} scale={[who.girth, 1, who.girth]}>
              <mesh geometry={g.pelvis} material={look3d.pants} castShadow />
              {look3d.tucked && <mesh geometry={g.belt} material={look3d.belt} />}
            </group>
          </group>
          {leg(hL, kL, fL, legLm, 1)}
          {leg(hR, kR, fR, legRm, -1)}
        </group>
        <group ref={spine}>
          <group ref={chest}>
            <mesh geometry={look3d.torso} material={look3d.shirt} castShadow />
            <mesh geometry={g.trim[look3d.outfit]} material={look3d.trim} />
            <mesh geometry={look3d.tucked ? g.neckOpen : g.neck} material={look3d.skin} />
            {suit && <mesh geometry={g.tie} material={look3d.tie} />}
            {suit && <mesh geometry={g.suitLapels} material={look3d.lapel} />}
            {suit && <mesh geometry={g.suitButtons} material={look3d.dark} />}
            {suit ? (
              <mesh geometry={g.badge} material={look3d.badge} position={[0.079, 0.412, PIN_Z]} rotation={[-0.08, 0.3, 0.5]} scale={0.5} />
            ) : (
              <mesh geometry={g.badge} material={look3d.badge} position={[0.088, 0.36, BADGE_Z]} rotation={[-0.05, 0.38, 0]} />
            )}
          </group>
          {whip && <mesh ref={coil} geometry={g.coil} material={look3d.leather} position={[-0.145, -0.015, -0.112]} rotation={[0, -0.93, 0]} castShadow />}
          <group ref={head} position={[0, HEAD_Y, -0.002]}>
            <group position={[0, 0.103 * HEAD_SCALE, 0.014 * HEAD_SCALE]} scale={[HEAD_SCALE * who.headW, HEAD_SCALE, HEAD_SCALE * who.headD]}>
              <mesh geometry={look3d.head} material={look3d.bearded ? [look3d.face, look3d.beard] : look3d.face} castShadow />
              <mesh geometry={look3d.eyes} material={look3d.eye} />
              <mesh ref={lidL} geometry={LIDS} material={look3d.face} position={[EYE_AT.x, EYE_AT.y, EYE_AT.z]} rotation={[0, EYE_YAW, 0, 'YXZ']} />
              <mesh ref={lidR} geometry={LIDS} material={look3d.face} position={[-EYE_AT.x, EYE_AT.y, EYE_AT.z]} rotation={[0, -EYE_YAW, 0, 'YXZ']} />
              <mesh geometry={look3d.brows} material={look3d.brow} />
              {look3d.hair && <mesh geometry={look3d.hair} material={look3d.hairMat} castShadow />}
              {look3d.glasses && <mesh geometry={glassesGeo()} material={look3d.dark} />}
              {look3d.phones && <mesh geometry={look3d.phones} material={look3d.dark} />}
              {appearance.accessory === 'cap' && <mesh geometry={capGeo()} material={look3d.capMat} castShadow />}
            </group>
          </group>
          {arm(armL, sL, eL, handL, armLm, 1)}
          {arm(armR, sR, eR, handR, armRm, -1)}
        </group>
      </group>
      <group ref={zzz} visible={false}>
        {sleepy &&
          Z_LETTERS.map((i) => (
            <sprite key={i} raycast={NO_RAYCAST} renderOrder={5}>
              <spriteMaterial map={zTexture()} transparent opacity={0} depthWrite={false} toneMapped={false} />
            </sprite>
          ))}
      </group>
      {lashGeo && <mesh ref={lash} geometry={lashGeo} material={look3d.leather} visible={false} frustumCulled={false} />}
      {lashGeo && <mesh ref={spark} geometry={g.spark} material={sparkMat()} visible={false} />}
    </group>
  );
}
