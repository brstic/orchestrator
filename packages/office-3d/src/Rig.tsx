import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { Appearance } from '@orchestrator/contracts';
import { Character, type Motion } from './Character.tsx';
import type { CameraMode, NearbyTarget, PersonView } from './types.ts';
import { deskSeat, moveWithCollision, type World } from './world.ts';

/** The owner: a navy two-piece suit, burgundy tie, dark brown oxfords. */
const CEO_LOOK: Appearance = { skin: '#e0ac69', hair: '#241c17', hairStyle: 'short', shirt: '#2b3c66', pants: '#2b3c66', accessory: 'none', build: 1.03 };
const CEO_DETAIL = { tie: '#8f2738', shoes: '#4a2c1c' };
/** How long the avatar holds the 'whip' pose after `whipAt` changes. */
const WHIP_MS = 700;
/** Standing at someone's desk, the third-person camera comes in to at most this distance. */
const APPROACH_DIST = 4.2;
/**
 * The owner's pace on foot, units per second: walking forward, backward and sideways, and the same with Shift held.
 * These are speeds the legs can really walk (and run) at: the feet stay where they are put down.
 */
const WALK = { fwd: 2.5, back: 1.7, side: 1.6 };
const RUN = { fwd: 6.4, back: 3.0, side: 3.4 };
/** Turning on the spot and while walking, radians per second. */
const TURN_RATE = 2.4;
/**
 * Nothing starts or stops at once: speed and turning are eased toward what the keys ask for by critically damped
 * springs of these stiffnesses (1/s). Walking pace is reached in about 0.2 s; letting go stops a little quicker.
 */
const ACCEL = 20;
const BRAKE = 25;
const TURN_EASE = 22;
const TURN_STOP = 32;
/** How fast the body comes round to face where the camera looks once it starts moving, and the most it may spin (rad/s). */
const FACE_EASE = 11;
const FACE_MAX = 7.5;
/**
 * The third-person camera follows a point that trails the owner softly, and comes round behind them a moment after
 * they turn (1/s). Mouse look and the zoom wheel settle at the old pace.
 */
const CAM_FOLLOW = 9;
const CAM_SWING = 16;
const CAM_LOOK = 18;

/** One step of a critically damped spring on `o[k]` (its rate of change is kept in `o[kv]`), toward `goal`. */
function ease<K extends string>(o: Record<K, number>, k: K, kv: K, goal: number, stiffness: number, dt: number): void {
  const d = o[k] - goal;
  const j = o[kv] + stiffness * d;
  const e = Math.exp(-stiffness * dt);
  o[k] = goal + (d + j * dt) * e;
  o[kv] = (o[kv] - j * stiffness * dt) * e;
}

/**
 * Follow a moving target with an exponential lag. The target went from `from` to `to` during `dt`; the answer is exact
 * for that, so the distance kept behind a steadily moving target does not depend on the frame time (an uneven frame
 * rate would otherwise show as a shake between the camera and what it follows).
 */
function trail(cur: number, from: number, to: number, rate: number, dt: number): number {
  if (dt <= 1e-5) return cur;
  const lag = (to - from) / dt / rate;
  return to - lag + (cur - from + lag) * Math.exp(-rate * dt);
}

const wrapPi = (a: number) => a - Math.PI * 2 * Math.round(a / (Math.PI * 2));

/**
 * Where the owner's avatar stands, updated every frame. Read by the HUD when something is
 * placed "where I am standing" (the office editor); never written from outside the scene.
 */
export const ownerPosition = { x: 0, z: 0, rot: 0 };

export interface Keymap {
  forward: string;
  back: string;
  /** Turn left / right when walking (CEO and first-person); pan sideways in the overview cameras. */
  left: string;
  right: string;
  /** Sidestep without turning. */
  strafeLeft: string;
  strafeRight: string;
}

function typingInUi(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable || !!el.closest?.('.xterm');
}

/**
 * The owner's avatar and the camera.
 *
 *   ceo          third person, following the avatar
 *   first        first person
 *   management   elevated view panned across the floor
 *   free         free-flying camera
 *   workstation  over an employee's shoulder, looking at their monitor
 *   command      the whole office from above
 *
 * Mode changes blend smoothly but quickly: this is a tool first.
 */
export function Rig({
  world,
  mode,
  people,
  workstationId,
  focus,
  keymap,
  player,
  onNearby,
  onLeaveWorkstation,
  whipAt,
  approachZoom = false,
}: {
  world: World;
  mode: CameraMode;
  people: PersonView[];
  workstationId: string | null;
  focus: { employeeId: string; n: number } | null;
  keymap: Keymap;
  player: THREE.Vector3;
  onNearby: (n: NearbyTarget | null) => void;
  onLeaveWorkstation: () => void;
  /** Timestamp (ms) of the owner's latest whip crack; the avatar plays the swing each time it changes. 0/undefined = never. */
  whipAt?: number;
  /** Ease the camera in at a desk (an owner setting; off by default). */
  approachZoom?: boolean;
}) {
  const { camera, gl } = useThree();
  const avatar = useRef<THREE.Group>(null);
  const keys = useRef(new Set<string>());
  const st = useRef({
    yaw: 0.95,
    pitch: 0.5,
    dist: 11,
    playerRot: world.spawn.rot,
    walking: false,
    mgmt: new THREE.Vector3(-4, 0, 3),
    mgmtH: 22,
    free: new THREE.Vector3(0, 6, 20),
    blend: 1,
    lastMode: mode,
    frame: 0,
    dragging: false,
    /** 0..1: how far the camera has eased in on the workstation the owner is standing at. */
    approach: 0,
    /** The desk being approached (kept while easing back out). */
    nearDesk: null as { x: number; z: number } | null,
    atDesk: false,
    focus: new THREE.Vector3(),
    /** Eased motion on foot: speed forward and to the right (camera-relative), turn rate, and how fast each is changing. */
    vf: 0,
    af: 0,
    vs: 0,
    as: 0,
    tv: 0,
    ta: 0,
    /**
     * The third-person camera: the point it follows and its own yaw, pitch and distance (each trailing the owner's), the
     * values those were trailing last frame, and what is left of the view it is coming from (dies away; never a cut).
     */
    cam: { on: false, x: 0, z: 0, yaw: 0, pitch: 0, dist: 0, px: 0, pz: 0, pyaw: 0 },
    /** Set when the owner is put somewhere at once (or the camera mode changes): the camera glides over instead of trailing. */
    jump: true,
    off: new THREE.Vector3(),
    offLook: new THREE.Vector3(),
  });
  const camPos = useMemo(() => new THREE.Vector3(), []);
  const camLook = useMemo(() => new THREE.Vector3(), []);
  const curLook = useRef(new THREE.Vector3(world.spawn.x, 1.4, world.spawn.z));
  // How the avatar's body moved this frame, in its own frame of reference. Read by the character every frame; never React state.
  const motion = useRef<Motion>({ vx: 0, vz: 0, turn: 0, run: false });
  const desks = useMemo(() => new Map(world.layout.desks.map((d) => [d.id, d])), [world]);
  const peopleRef = useRef(people);
  peopleRef.current = people;
  const approachRef = useRef(approachZoom);
  approachRef.current = approachZoom;
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // The interactable spots, for the UI tests; they move when the floor plan is edited.
  useEffect(() => {
    const probe = ((window as any).__orchPlayer ??= { x: 0, z: 0, rot: 0 });
    probe.spots = world.interactables.map((i) => ({ kind: i.kind, x: i.x, z: i.z }));
    probe.seatOf = (deskId: string) => {
      const d = world.layout.desks.find((x) => x.id === deskId);
      return d ? deskSeat(d) : null;
    };
  }, [world]);

  useEffect(() => {
    player.set(world.spawn.x, 0, world.spawn.z);
    st.current.playerRot = world.spawn.rot;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Jump to an employee when asked (map click, "go to Sarah", notification).
  useEffect(() => {
    if (!focus) return;
    const p = peopleRef.current.find((x) => x.id === focus.employeeId);
    const desk = p?.deskId ? desks.get(p.deskId) : undefined;
    if (!desk) return;
    const seat = deskSeat(desk);
    const bx = seat.x - Math.sin(seat.rot) * 1.5;
    const bz = seat.z - Math.cos(seat.rot) * 1.5;
    const [fx, fz] = moveWithCollision(world, bx, bz, 0, 0);
    player.set(fx, 0, fz);
    st.current.playerRot = seat.rot;
    st.current.yaw = seat.rot + Math.PI + 0.4;
    st.current.mgmt.set(seat.x, 0, seat.z);
    st.current.blend = 0;
    st.current.jump = true;
    st.current.vf = st.current.vs = st.current.af = st.current.as = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.n]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (typingInUi() || e.metaKey || e.ctrlKey || e.altKey) return;
      keys.current.add(e.code);
    };
    const up = (e: KeyboardEvent) => keys.current.delete(e.code);
    const blur = () => keys.current.clear();
    const el = gl.domElement;
    let last: [number, number] | null = null;
    const pdown = (e: PointerEvent) => {
      if (modeRef.current === 'first') {
        if (document.pointerLockElement !== el) void el.requestPointerLock?.();
        return;
      }
      if (e.button === 0 || e.button === 2) {
        last = [e.clientX, e.clientY];
        st.current.dragging = false;
      }
    };
    const pmove = (e: PointerEvent) => {
      const s = st.current;
      if (document.pointerLockElement === el) {
        s.yaw -= e.movementX * 0.0025;
        s.pitch = THREE.MathUtils.clamp(s.pitch + e.movementY * 0.0025, -1.2, 1.2);
        return;
      }
      if (!last) return;
      const dx = e.clientX - last[0];
      const dy = e.clientY - last[1];
      if (Math.abs(dx) + Math.abs(dy) > 3) s.dragging = true;
      last = [e.clientX, e.clientY];
      if (modeRef.current === 'workstation' || modeRef.current === 'command') return;
      s.yaw -= dx * 0.005;
      s.pitch = THREE.MathUtils.clamp(s.pitch + dy * 0.004, modeRef.current === 'free' ? -1.3 : 0.12, 1.35);
    };
    const pup = () => (last = null);
    const wheel = (e: WheelEvent) => {
      const s = st.current;
      const f = Math.exp(e.deltaY * 0.0012);
      if (modeRef.current === 'management') s.mgmtH = THREE.MathUtils.clamp(s.mgmtH * f, 7, 48);
      else if (modeRef.current === 'ceo') s.dist = THREE.MathUtils.clamp(s.dist * f, 2.6, 22);
    };
    const ctx = (e: Event) => e.preventDefault();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    el.addEventListener('pointerdown', pdown);
    window.addEventListener('pointermove', pmove);
    window.addEventListener('pointerup', pup);
    el.addEventListener('wheel', wheel, { passive: true });
    el.addEventListener('contextmenu', ctx);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      el.removeEventListener('pointerdown', pdown);
      window.removeEventListener('pointermove', pmove);
      window.removeEventListener('pointerup', pup);
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('contextmenu', ctx);
    };
  }, [gl]);

  useEffect(() => {
    if (mode !== 'first' && document.pointerLockElement) document.exitPointerLock();
  }, [mode]);

  useFrame((_state, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const s = st.current;
    if (s.lastMode !== mode) {
      s.lastMode = mode;
      s.blend = 0;
      s.jump = true;
      if (mode === 'free') s.free.copy(camera.position);
      if (mode === 'management') s.mgmt.set(player.x, 0, player.z);
      if (mode === 'first') s.pitch = 0;
      else if (s.pitch < 0.12) s.pitch = 0.5;
    }
    s.blend = Math.min(1, s.blend + dt * 1.6);

    const x0 = player.x;
    const z0 = player.z;
    const rot0 = s.playerRot;

    // ── input → movement ──
    const k = keys.current;
    const fwd = (k.has(keymap.forward) || k.has('ArrowUp') ? 1 : 0) - (k.has(keymap.back) || k.has('ArrowDown') ? 1 : 0);
    const turnKeys = (k.has(keymap.right) || k.has('ArrowRight') ? 1 : 0) - (k.has(keymap.left) || k.has('ArrowLeft') ? 1 : 0);
    const sideKeys = (k.has(keymap.strafeRight) ? 1 : 0) - (k.has(keymap.strafeLeft) ? 1 : 0);
    const walking = mode === 'ceo' || mode === 'first';
    // On foot, left/right turn the body (and the camera with it) and the strafe keys sidestep.
    // In the overview and free cameras there is no body to turn, so both pairs move sideways.
    const turn = walking ? turnKeys : 0;
    const strafe = walking ? sideKeys : mode === 'free' ? turnKeys : Math.sign(turnKeys + sideKeys);
    const run = k.has('ShiftLeft') || k.has('ShiftRight');
    // Turning eases in and out. Body and camera aim turn together, so the turn itself never lags behind the key.
    ease(s, 'tv', 'ta', turn * TURN_RATE, turn ? TURN_EASE : TURN_STOP, dt);
    if (!turn && Math.abs(s.tv) < 0.004 && Math.abs(s.ta) < 0.05) s.tv = s.ta = 0;
    if (s.tv) {
      s.yaw -= s.tv * dt;
      if (mode === 'ceo') s.playerRot -= s.tv * dt;
    }
    // Camera-relative directions on the floor plane.
    const fx = -Math.sin(s.yaw);
    const fz = -Math.cos(s.yaw);
    const rx = Math.cos(s.yaw);
    const rz = -Math.sin(s.yaw);
    let moved = false;
    if (walking) {
      // On foot the keys set a pace, and the body eases to it: a real first step, and a settle when the keys are let go.
      const pace = run ? RUN : WALK;
      const len = Math.hypot(fwd, strafe) || 1;
      const wantF = (fwd / len) * (fwd > 0 ? pace.fwd : pace.back);
      const wantS = (strafe / len) * pace.side;
      ease(s, 'vf', 'af', wantF, Math.abs(wantF) >= Math.abs(s.vf) ? ACCEL : BRAKE, dt);
      ease(s, 'vs', 'as', wantS, Math.abs(wantS) >= Math.abs(s.vs) ? ACCEL : BRAKE, dt);
      if (!fwd && !strafe && Math.abs(s.vf) + Math.abs(s.vs) < 0.006) s.vf = s.vs = s.af = s.as = 0;
      if (s.vf || s.vs) {
        const dx = (fx * s.vf + rx * s.vs) * dt;
        const dz = (fz * s.vf + rz * s.vs) * dt;
        const [nx, nz] = moveWithCollision(world, player.x, player.z, dx, dz);
        moved = nx !== player.x || nz !== player.z;
        if (nx !== player.x + dx || nz !== player.z + dz) {
          // Something is in the way: the pace is what the body actually managed (it slides along a wall, and stops at one).
          const ax = (nx - player.x) / dt;
          const az = (nz - player.z) / dt;
          s.vf = ax * fx + az * fz;
          s.vs = ax * rx + az * rz;
          s.af = s.as = 0;
        }
        player.set(nx, 0, nz);
      }
    } else s.vf = s.vs = s.af = s.as = 0;
    if (fwd || strafe) {
      const len = Math.hypot(fwd, strafe);
      const dx = ((fx * fwd + rx * strafe) / len) * dt;
      const dz = ((fz * fwd + rz * strafe) / len) * dt;
      if (mode === 'management') {
        const speed = s.mgmtH * (run ? 1.6 : 0.9);
        s.mgmt.x = THREE.MathUtils.clamp(s.mgmt.x + dx * speed, world.bounds.minX, world.bounds.maxX);
        s.mgmt.z = THREE.MathUtils.clamp(s.mgmt.z + dz * speed, world.bounds.minZ, world.bounds.maxZ);
      } else if (mode === 'free') {
        const speed = run ? 22 : 10;
        const cp = Math.cos(s.pitch);
        s.free.x += (fx * cp * fwd + rx * strafe) * dt * speed;
        s.free.z += (fz * cp * fwd + rz * strafe) * dt * speed;
        s.free.y += -Math.sin(s.pitch) * fwd * dt * speed;
      } else if (mode === 'workstation') {
        // Walking away from the desk leaves the workstation.
        onLeaveWorkstation();
      }
    }
    if (mode === 'free') {
      if (k.has('KeyE') || k.has('Space')) s.free.y += dt * 8;
      if (k.has('KeyQ')) s.free.y -= dt * 8;
      s.free.y = THREE.MathUtils.clamp(s.free.y, 0.6, 60);
    }
    if (mode === 'first') s.playerRot = s.yaw + Math.PI;
    else if (mode === 'ceo' && (fwd || strafe || turn || moved || s.tv)) {
      // The body faces where the camera looks: turning turns it in place, sidestepping keeps it facing forward.
      // After looking around with the mouse it comes round briskly, but it does not spin like a top.
      const diff = wrapPi(s.yaw + Math.PI - s.playerRot);
      s.playerRot += THREE.MathUtils.clamp(diff * (1 - Math.exp(-dt * FACE_EASE)), -FACE_MAX * dt, FACE_MAX * dt);
    }
    // What the body actually did (after collisions), for the avatar's gait.
    const m = motion.current;
    const perSec = dt > 1e-4 ? 1 / dt : 0;
    const wx = (player.x - x0) * perSec;
    const wz = (player.z - z0) * perSec;
    const sr = Math.sin(s.playerRot);
    const cr = Math.cos(s.playerRot);
    m.vx = wx * cr - wz * sr;
    m.vz = wx * sr + wz * cr;
    m.turn = (s.playerRot - rot0) * perSec;
    m.run = run && moved && !!(fwd || strafe);
    // Where the owner's character is and which way it faces — read by the UI tests, like `window.__office`.
    const probe = ((window as any).__orchPlayer ??= { x: 0, z: 0, rot: 0 });
    // Tests may also place the character somewhere (`goto`), instead of steering there key by key.
    if (probe.goto) {
      const [gx, gz] = moveWithCollision(world, probe.goto.x, probe.goto.z, 0, 0);
      player.set(gx, 0, gz);
      if (typeof probe.goto.rot === 'number') {
        s.playerRot = probe.goto.rot;
        s.yaw = probe.goto.rot + Math.PI;
      }
      probe.goto = null;
      s.jump = true;
      s.vf = s.vs = s.af = s.as = 0;
    }
    probe.x = ownerPosition.x = player.x;
    probe.z = ownerPosition.z = player.z;
    probe.rot = ownerPosition.rot = s.playerRot;

    // ── desired camera ──
    let fov = 50;
    // Approaching a workstation: the camera eases in (and back out on leaving). Only the orbit
    // distance and the point it orbits change — yaw and pitch stay the owner's, so mouse look and
    // the turn keys behave exactly as they do anywhere else.
    // Only when the owner asked for it (Settings): otherwise the camera keeps its distance, as it always did.
    s.approach += ((mode === 'ceo' && s.atDesk && approachRef.current ? 1 : 0) - s.approach) * (1 - Math.exp(-dt * 3.2));
    if (s.approach < 0.002 && !s.atDesk) s.approach = 0;
    probe.approach = s.approach;
    const cam = s.cam;
    if (mode === 'ceo') {
      const k = s.approach;
      const dist = s.dist + (Math.min(s.dist, APPROACH_DIST) - s.dist) * k;
      // Orbit a point part of the way from the owner to the desk, a little lower, so the monitor is in the middle of the view.
      if (s.nearDesk) s.focus.set(player.x + (s.nearDesk.x - player.x) * 0.5, 1.35 - 0.22, player.z + (s.nearDesk.z - player.z) * 0.5);
      else s.focus.set(player.x, 1.35, player.z);
      // The camera is rigid in what it shows and soft in how it gets there: it orbits a point that trails the owner,
      // and its own angle and distance trail the owner's. Walking, turning and stopping all reach the picture eased.
      const fresh = s.jump || !cam.on;
      if (fresh) {
        cam.x = player.x;
        cam.z = player.z;
        cam.yaw = s.yaw;
        cam.pitch = s.pitch;
        cam.dist = dist;
      } else {
        cam.x = trail(cam.x, cam.px, player.x, CAM_FOLLOW, dt);
        cam.z = trail(cam.z, cam.pz, player.z, CAM_FOLLOW, dt);
        // Turning with the keys, the camera swings round behind the owner a moment later; the mouse is followed the same way.
        cam.yaw = trail(cam.yaw, cam.pyaw, s.yaw, CAM_SWING, dt);
        cam.pitch += (s.pitch - cam.pitch) * (1 - Math.exp(-dt * CAM_LOOK));
        cam.dist += (dist - cam.dist) * (1 - Math.exp(-dt * CAM_LOOK));
      }
      cam.on = true;
      cam.px = player.x;
      cam.pz = player.z;
      cam.pyaw = s.yaw;
      camLook.set(cam.x + (s.focus.x - player.x) * k, 1.35 + (s.focus.y - 1.35) * k, cam.z + (s.focus.z - player.z) * k);
      const cp = Math.cos(cam.pitch);
      camPos.set(camLook.x + Math.sin(cam.yaw) * cp * cam.dist, camLook.y + Math.sin(cam.pitch) * cam.dist, camLook.z + Math.cos(cam.yaw) * cp * cam.dist);
      if (fresh) {
        // Coming from somewhere else (another camera, or the owner was put somewhere): keep the view and let the difference die away.
        s.off.subVectors(camera.position, camPos);
        s.offLook.subVectors(curLook.current, camLook);
      }
      probe.camDist = dist;
    } else if (mode === 'first') {
      camPos.set(player.x, 1.62, player.z);
      const cp = Math.cos(s.pitch);
      camLook.set(player.x + fx * cp, 1.62 - Math.sin(s.pitch), player.z + fz * cp);
      fov = 68;
    } else if (mode === 'management') {
      camLook.copy(s.mgmt);
      camPos.set(s.mgmt.x + Math.sin(s.yaw) * s.mgmtH * 0.62, s.mgmtH, s.mgmt.z + Math.cos(s.yaw) * s.mgmtH * 0.62);
      fov = 42;
    } else if (mode === 'free') {
      camPos.copy(s.free);
      const cp = Math.cos(s.pitch);
      camLook.set(s.free.x + fx * cp, s.free.y - Math.sin(s.pitch), s.free.z + fz * cp);
    } else if (mode === 'workstation') {
      const p = peopleRef.current.find((x) => x.id === workstationId);
      const desk = p?.deskId ? desks.get(p.deskId) : undefined;
      if (desk) {
        const seat = deskSeat(desk);
        const sx = Math.sin(seat.rot);
        const sz = Math.cos(seat.rot);
        // Behind and slightly beside the employee, looking over their shoulder at the monitor.
        camPos.set(seat.x - sx * 1.25 + sz * 0.42, 1.52, seat.z - sz * 1.25 - sx * 0.42);
        camLook.set(desk.x - sz * 0.08 + sx * 0.2, 1.1, desk.z + sx * 0.08 + sz * 0.2);
        fov = 42;
      }
    } else {
      camLook.set(-1, 0, -1);
      camPos.set(-1, 44, 19);
      fov = 44;
    }

    s.jump = false;
    if (mode !== 'ceo') cam.on = false;

    // ── blend ──
    const follow = mode === 'ceo' || mode === 'first' || mode === 'free' || mode === 'management';
    const rate = s.blend < 1 ? 4.5 : follow ? 18 : 6;
    const a = 1 - Math.exp(-dt * rate);
    if (mode === 'ceo') {
      // Already eased where it matters; only what is left of the previous view is blended out.
      const keep = 1 - a;
      if (s.off.lengthSq() < 1e-8) s.off.set(0, 0, 0);
      else s.off.multiplyScalar(keep);
      if (s.offLook.lengthSq() < 1e-8) s.offLook.set(0, 0, 0);
      else s.offLook.multiplyScalar(keep);
      camera.position.addVectors(camPos, s.off);
      curLook.current.addVectors(camLook, s.offLook);
    } else {
      camera.position.lerp(camPos, a);
      curLook.current.lerp(camLook, a);
    }
    camera.lookAt(curLook.current);
    // Everything drawn this frame (name tags included) is placed with the camera as it is now, not as it was a frame ago.
    camera.updateMatrixWorld();
    const pc = camera as THREE.PerspectiveCamera;
    if (Math.abs(pc.fov - fov) > 0.05) {
      pc.fov += (fov - pc.fov) * a;
      pc.updateProjectionMatrix();
    }

    if (avatar.current) {
      avatar.current.position.set(player.x, 0, player.z);
      avatar.current.rotation.y = s.playerRot;
      avatar.current.visible = mode !== 'first' && mode !== 'workstation';
    }

    // ── what is the owner standing next to? ──
    if (++s.frame % 8 === 0) {
      if (mode !== 'ceo' && mode !== 'first') {
        s.atDesk = false;
        return onNearby(null);
      }
      let best: NearbyTarget | null = null;
      let bestD = 2.3 * 2.3;
      let bestDesk: { x: number; z: number } | null = null;
      for (const p of peopleRef.current) {
        const desk = p.deskId ? desks.get(p.deskId) : undefined;
        if (!desk) continue;
        const seat = deskSeat(desk);
        const d = (seat.x - player.x) ** 2 + (seat.z - player.z) ** 2;
        if (d < bestD) {
          bestD = d;
          best = { kind: 'employee', id: p.id, label: p.name };
          bestDesk = desk;
        }
      }
      // The camera's approach follows the same "standing at a workstation" test as the prompt does.
      s.atDesk = !!bestDesk;
      if (bestDesk) s.nearDesk = { x: bestDesk.x, z: bestDesk.z };
      else if (s.approach === 0) s.nearDesk = null;
      // An empty desk: a place to seat someone. With nobody's desk in range, coming within 1.5 m is enough;
      // next to an occupied desk the owner must stand right at the empty chair (within 1 m, and clearly
      // closer to it than to the neighbour's), so walking up to a person always means that person.
      {
        const taken = new Set(peopleRef.current.map((p) => p.deskId));
        const empDist = best ? Math.sqrt(bestD) : Infinity;
        let nearest = best ? Math.min(1.0, empDist - 0.4) : 1.5;
        for (const desk of desks.values()) {
          if (taken.has(desk.id) || desk.kind === 'executive') continue;
          const seat = deskSeat(desk);
          const d = Math.hypot(seat.x - player.x, seat.z - player.z);
          if (d < nearest) {
            nearest = d;
            best = { kind: 'desk', id: desk.id, label: 'EMPTY DESK' };
          }
        }
      }
      if (!best) {
        for (const it of world.interactables) {
          const d = Math.hypot(it.x - player.x, it.z - player.z);
          if (d < it.radius) {
            best = { kind: it.kind, id: it.id, label: it.label };
            break;
          }
        }
      }
      onNearby(best);
    }
    // Before everything else in the frame: the avatar's gait and the name tags then work from this frame's position and camera.
  }, -1);

  return (
    <group ref={avatar}>
      <PlayerBody motion={motion} whipAt={whipAt} />
    </group>
  );
}

function PlayerBody({ motion, whipAt }: { motion: { current: Motion }; whipAt?: number }) {
  // The gait reads `motion` every frame, so walking never re-renders; only a whip crack does (twice: start and end).
  const [swing, setSwing] = useState(0);
  const seen = useRef(whipAt);
  useEffect(() => {
    if (!whipAt || whipAt === seen.current) return;
    seen.current = whipAt;
    setSwing(whipAt);
    const id = setTimeout(() => setSwing(0), WHIP_MS);
    return () => clearTimeout(id);
  }, [whipAt]);
  return (
    <>
      <Character appearance={CEO_LOOK} detail={CEO_DETAIL} pose={swing ? 'whip' : 'stand'} cue={swing} level={10} motion={motion} whip />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <ringGeometry args={[0.34, 0.4, 32]} />
        <meshBasicMaterial color="#ffd166" transparent opacity={0.85} toneMapped={false} />
      </mesh>
    </>
  );
}
