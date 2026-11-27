import { CEO_LOOK } from './looks.ts';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { Appearance } from '@orchestrator/contracts';
import { Character, type Motion } from './Character.tsx';
import { useActs } from './character/acts.ts';
import { JUMP_HEIGHT, JUMP_SECONDS, JUMP_TOUCH, jumpSink, jumpY } from './character/motion.ts';
import { sceneProbe } from './Environment.tsx';
import type { CameraMode, NearbyTarget, PersonView } from './types.ts';
import { deskSeat, moveWithCollision, type Box, type Seat, type World } from './world.ts';
import { JUMP_AIR, JUMP_OFF } from './character/motion.ts';
import { STREET_Y, blocked, solidsNear, type Solid } from './city/blocks.ts';
import { alight, board, leap, step as cityStep, type Explorer, type Keys as CityKeys } from './city/explorer.ts';
import { CityGear, type CarAt, type Gear } from './city/gear.tsx';
import { besideOf, othersOutside, ownerOutside, passengerSeat, rideNear } from './city/together.ts';
import { CITY_GRID, cityLive, cityTraffic } from './surroundings/skyline.ts';
import { vehicleAt } from './surroundings/traffic.ts';
import { plateOf } from './surroundings/windows.ts';

/** The owner: a navy two-piece suit, burgundy tie, dark brown oxfords. */

/** Standing at someone's desk, the third-person camera comes in to at most this distance. */
const APPROACH_DIST = 4.2;
/**
 * The owner's pace on foot, units per second: forward, backward and sideways, and the same with Shift held.
 * The everyday pace is an easy jog and Shift is a run: the avatar's legs take whatever stride the speed needs
 * (see `stepLoco` in Character.tsx), so the feet stay where they are put down at any of these.
 */
const WALK = { fwd: 3.8, back: 2.4, side: 2.6 };
const RUN = { fwd: 7.4, back: 3.6, side: 4.4 };
/** Turning on the spot and while moving, radians per second. */
const TURN_RATE = 2.9;
/**
 * Nothing starts or stops at once, but nearly: speed and turning are eased toward what the keys ask for by critically
 * damped springs of these stiffnesses (1/s). The everyday pace is reached in about 0.13 s; letting go stops quicker still.
 */
const ACCEL = 30;
const BRAKE = 36;
const TURN_EASE = 30;
const TURN_STOP = 40;
/** How fast the body comes round to face where the camera looks once it starts moving, and the most it may spin (rad/s). */
const FACE_EASE = 11;
const FACE_MAX = 7.5;
/**
 * The third-person camera follows a point that trails the owner softly, and comes round behind them a moment after
 * they turn (1/s). Mouse look and the zoom wheel settle at the old pace.
 */
const CAM_FOLLOW = 12;
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
/** The spots that mean a whole room: standing right at a seat inside one means the seat. */
const ROOM_SPOTS = new Set(['board', 'meeting', 'server', 'ops', 'ceo', 'break', 'reception']);

export const ownerPosition = { x: 0, z: 0, rot: 0, sit: false };

/** Once the feet are back on the floor for this long (s), the next jump may begin: it grows out of the landing. */
const JUMP_AGAIN = 0.06;
/** Through the owner's own eyes, this share of the crouch and of the landing is felt. */
const EYE_SINK = 0.6;
/** A seat is sat on from this close (m): right at it when a room's own spot is around it, a step away otherwise. */
const SEAT_AT = 0.85;
const SEAT_NEAR = 1.15;
/** A sitter's eyes are this much lower than a stander's. */
const SIT_DROP = 0.42;

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
/** Within this of their own chair, somebody counts as at their desk (the camera's approach is for a workstation). */
const AT_OWN_DESK = 0.9;
/** How near one has to come to somebody who is not at their desk. */
const AWAY_REACH = 1.7;

export function Rig({
  world,
  mode,
  people,
  workstationId,
  focus,
  keymap,
  player,
  onNearby,
  positions,
  walkers,
  moving = false,
  onLeaveWorkstation,
  whipAt,
  ouchAt,
  emote,
  approachZoom = false,
  seatAsk,
  jumpAsk = 0,
  onSeated,
  onJumped,
  city = false,
  outside,
  onOutside,
  onOutsideHint,
  cityJoin,
  look,
}: {
  /** The owner's own character (`docs/CHARACTER.md`); absent: the office's boss in a suit. */
  look?: Appearance;
  world: World;
  mode: CameraMode;
  people: PersonView[];
  workstationId: string | null;
  focus: { employeeId: string; n: number } | null;
  keymap: Keymap;
  player: THREE.Vector3;
  onNearby: (n: NearbyTarget | null) => void;
  /** Where every character really is right now (kept by whoever draws them): somebody who got up is met where they went. */
  positions?: Map<string, THREE.Vector3>;
  /** Those who have no desk and walk the floor — members' team leads: met where they stand. */
  walkers?: Array<{ id: string; name: string }>;
  /** Somebody is being moved to another desk: then a desk stands for whoever sits at it, also while they are away from it. */
  moving?: boolean;
  onLeaveWorkstation: () => void;
  /** Timestamp (ms) of the owner's latest whip crack; the avatar plays the swing each time it changes. 0/undefined = never. */
  whipAt?: number;
  /** When someone else's whip lands on this person (ms): the avatar flinches. */
  ouchAt?: number;
  /** The gesture this person last asked for (the wheel), and when. */
  emote?: { name: string; at: number } | null;
  /** Ease the camera in at a desk (an owner setting; off by default). */
  approachZoom?: boolean;
  /** Sit down on a seat of the world (`id`), or get up (`id: null`); acted on each time `n` changes. */
  seatAsk?: { id: string | null; n: number } | null;
  /** Jump, each time this changes (where the owner is on foot and not sitting). */
  jumpAsk?: number;
  /** The owner sat down (on which seat) or got up. */
  onSeated?: (seatId: string | null) => void;
  /** A jump really began (so the others can be told). */
  onJumped?: () => void;
  /** The office stands over the city (the Skyline): one can jump out of a window into it. */
  city?: boolean;
  /** Out in the city (`on`), or back in the office; acted on each time `n` changes. */
  outside?: { on: boolean; n: number } | null;
  /** The owner came back by themselves (landed on the office's own terrace). */
  onOutside?: (on: boolean) => void;
  /** What the keys do out there just now, for the HUD ("F — drive this car"), or null. */
  onOutsideHint?: (hint: string | null) => void;
  /** Out in the city: go to somebody else out there (their window), each time `n` changes. */
  cityJoin?: { id: string; n: number } | null;
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
    /** The seat the owner is sitting on, and how long (s) the jump they are in has lasted (-1: not jumping) — from the key, through the crouch, the air and the landing. */
    seat: null as Seat | null,
    air: -1,
    off: new THREE.Vector3(),
    offLook: new THREE.Vector3(),
    /** When the mouse last turned the view (ms): out in the city the camera comes round behind only after a moment. */
    lookAt: 0,
  });
  const camPos = useMemo(() => new THREE.Vector3(), []);
  const camLook = useMemo(() => new THREE.Vector3(), []);
  const curLook = useRef(new THREE.Vector3(world.spawn.x, 1.4, world.spawn.z));
  // How the avatar's body moved this frame, in its own frame of reference. Read by the character every frame; never React state.
  const motion = useRef<Motion>({ vx: 0, vz: 0, turn: 0, run: false });
  const desks = useMemo(() => new Map(world.layout.desks.map((d) => [d.id, d])), [world]);
  const peopleRef = useRef(people);
  peopleRef.current = people;
  const positionsRef = useRef(positions);
  positionsRef.current = positions;
  const walkersRef = useRef(walkers);
  walkersRef.current = walkers;
  const movingRef = useRef(moving);
  movingRef.current = moving;
  const approachRef = useRef(approachZoom);
  approachRef.current = approachZoom;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const [seated, setSeated] = useState(false);
  const seatedRef = useRef(onSeated);
  seatedRef.current = onSeated;
  const jumpedRef = useRef(onJumped);
  jumpedRef.current = onJumped;
  // The jump's clock, for the character (read every frame, like `motion`), and the ring under it.
  const air = useRef(-1);
  const ring = useRef<THREE.Mesh>(null);
  const ankle = useRef<THREE.Object3D | null>(null);
  /** Sit down there: the body is put on the seat, facing the way it faces. */
  const sitDown = (seat: Seat) => {
    const s = st.current;
    s.seat = seat;
    s.air = -1;
    s.vf = s.vs = s.af = s.as = s.tv = s.ta = 0;
    player.set(seat.x, 0, seat.z);
    s.playerRot = seat.rot;
    setSeated(true);
    seatedRef.current?.(seat.id);
  };
  /** Get up: onto the floor at the seat (a chair), or the nearest floor in front of it (a sofa is something to walk around). */
  const standUp = () => {
    const s = st.current;
    const seat = s.seat;
    if (!seat) return;
    s.seat = null;
    const [x, z] = world.nav.walkable(seat.x, seat.z) ? [seat.x, seat.z] : (world.nav.nearestWalkable(seat.x + Math.sin(seat.rot) * 0.7, seat.z + Math.cos(seat.rot) * 0.7) ?? [seat.x, seat.z]);
    player.set(x, 0, z);
    setSeated(false);
    seatedRef.current?.(null);
  };
  useEffect(() => {
    if (!seatAsk) return;
    const seat = seatAsk.id ? world.seats.find((x) => x.id === seatAsk.id) : null;
    if (seat && (modeRef.current === 'ceo' || modeRef.current === 'first')) sitDown(seat);
    else standUp();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seatAsk?.n]);
  // The seat went away under them (the floor plan was edited): on their feet again.
  useEffect(() => {
    const seat = st.current.seat;
    if (seat && !world.seats.some((x) => x.id === seat.id && x.x === seat.x && x.z === seat.z)) standUp();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world]);
  const firstJump = useRef(true);
  useEffect(() => {
    if (firstJump.current) return void (firstJump.current = false);
    const s = st.current;
    // (Not in the middle of one: only once the feet are down again.)
    if (s.seat || (s.air >= 0 && s.air < JUMP_TOUCH + JUMP_AGAIN) || (modeRef.current !== 'ceo' && modeRef.current !== 'first')) return;
    s.air = 0;
    jumpedRef.current?.();
  }, [jumpAsk]);

  // ── out in the city ──
  const out = useRef({
    on: false,
    e: null as Explorer | null,
    /** Where the owner stood in the office when they jumped: where they come back to. */
    home: { x: 0, z: 0, rot: 0 },
    prevF: false,
    prevJump: false,
    /** The car they left standing, and which vehicle of the traffic it was. */
    parked: null as { x: number; z: number; rot: number; paint: [number, number, number]; index: number } | null,
    hint: null as string | null,
    zoom: 1,
    /** Riding in somebody else's car: whose (their window). */
    ride: null as string | null,
  });
  const gear = useRef<Gear>({ chute: null, car: null, parked: null });
  const outsideRef = useRef(onOutside);
  outsideRef.current = onOutside;
  const hintRef = useRef(onOutsideHint);
  hintRef.current = onOutsideHint;
  /** Over the city the terrace round the office is walked on, up to its balustrade (only where the office stands over the city). */
  const terrace = useMemo<Box | null>(() => {
    if (!city) return null;
    const p = plateOf(world);
    return { minX: p.minX + 0.25, maxX: p.maxX - 0.25, minZ: p.minZ + 0.25, maxZ: p.maxZ - 0.25 };
  }, [city, world]);
  const terraceRef = useRef(terrace);
  terraceRef.current = terrace;
  /** The office's own tower, as something solid: its floor is at 0, its terrace all round. */
  const tower = useMemo<Solid>(() => {
    const p = plateOf(world);
    return { minX: p.minX, maxX: p.maxX, minZ: p.minZ, maxZ: p.maxZ, top: 0 };
  }, [world]);
  const towerRef = useRef(tower);
  towerRef.current = tower;
  const comeBack = () => {
    const o = out.current;
    if (!o.on) return;
    o.on = false;
    o.e = null;
    o.parked = null;
    o.ride = null;
    ownerOutside.at = null;
    cityLive.taken = -1;
    gear.current = { chute: null, car: null, parked: null };
    player.set(o.home.x, 0, o.home.z);
    const s = st.current;
    // Back in, turned away from the window: facing into the office.
    s.playerRot = wrapPi(o.home.rot + Math.PI);
    s.yaw = s.playerRot + Math.PI;
    s.pitch = 0.5;
    s.jump = true;
    s.vf = s.vs = s.af = s.as = 0;
    air.current = -1;
    o.hint = null;
    hintRef.current?.(null);
  };
  useEffect(() => {
    if (!outside) return;
    const o = out.current;
    if (outside.on && !o.on) {
      // Over the balustrade at the nearest edge of the terrace, facing away from the building.
      const plate = plateOf(world);
      const edges: Array<[number, 'w' | 'e' | 'n' | 's']> = [
        [player.x - plate.minX, 'w'],
        [plate.maxX - player.x, 'e'],
        [player.z - plate.minZ, 'n'],
        [plate.maxZ - player.z, 's'],
      ];
      const side = edges.sort((a, b) => a[0] - b[0])[0]![1];
      const x = side === 'w' ? plate.minX - 0.6 : side === 'e' ? plate.maxX + 0.6 : player.x;
      const z = side === 'n' ? plate.minZ - 0.6 : side === 's' ? plate.maxZ + 0.6 : player.z;
      const rot = side === 'w' ? -Math.PI / 2 : side === 'e' ? Math.PI / 2 : side === 'n' ? Math.PI : 0;
      o.home = { x: player.x, z: player.z, rot: st.current.playerRot };
      if (st.current.seat) standUp();
      o.e = leap(x, z, rot);
      o.on = true;
      o.zoom = 1;
      const s = st.current;
      s.yaw = rot + Math.PI;
      s.pitch = 0.32;
      s.lookAt = 0;
      onNearby(null);
    } else if (!outside.on && o.on) comeBack();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outside?.n]);
  useEffect(
    () => () => {
      cityLive.taken = -1;
      ownerOutside.at = null;
    },
    [],
  );
  // Go to somebody out in the city: beside them, on foot, or in the air under a parachute of one's own.
  useEffect(() => {
    const o = out.current;
    const t = cityJoin ? othersOutside.get(cityJoin.id) : undefined;
    if (!o.on || !o.e || !t) return;
    const e = o.e;
    if (e.phase === 'car' && !o.ride) o.parked = { ...alight(e, solidsNear(e.x, e.z, [towerRef.current])), paint: e.paint, index: e.vehicle };
    o.ride = null;
    const at = besideOf(t, solidsNear(t.x, t.z, [towerRef.current]));
    Object.assign(e, { ...at, vx: 0, vy: at.phase === 'chute' ? -3 : 0, vz: 0, vf: 0, vs: 0, time: 0, chute: at.phase === 'chute' ? 1 : 0 });
    const s = st.current;
    s.yaw = at.rot + Math.PI;
    s.jump = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cityJoin?.n]);
  // For the UI tests: the terrace one may walk round the office (null where there is none).
  useEffect(() => {
    const probe = ((window as any).__orchPlayer ??= { x: 0, z: 0, rot: 0 });
    probe.terrace = terrace;
  }, [terrace]);

  /** One frame out in the city: the step, getting in and out of a car, the camera behind, the body, the gear. */
  const cityFrame = (dt: number, time: number) => {
    const o = out.current;
    const e = o.e!;
    const s = st.current;
    const k = keys.current;
    const f = k.has('KeyF');
    const fNow = f && !o.prevF;
    o.prevF = f;
    const space = k.has('Space');
    const jumpNow = space && !o.prevJump;
    o.prevJump = space;
    const keysNow: CityKeys = {
      fwd: (k.has(keymap.forward) || k.has('ArrowUp') ? 1 : 0) - (k.has(keymap.back) || k.has('ArrowDown') ? 1 : 0),
      turn: (k.has(keymap.right) || k.has('ArrowRight') ? 1 : 0) - (k.has(keymap.left) || k.has('ArrowLeft') ? 1 : 0),
      strafe: (k.has(keymap.strafeRight) ? 1 : 0) - (k.has(keymap.strafeLeft) ? 1 : 0),
      run: k.has('ShiftLeft') || k.has('ShiftRight'),
      jump: jumpNow,
    };
    const solids = solidsNear(e.x, e.z, [towerRef.current]);
    const x0 = e.x;
    const z0 = e.z;
    const rot0 = e.rot;
    // Riding with somebody: in the seat beside them, wherever they drive; out when F is pressed, when they get out or go home.
    let pressed = fNow;
    if (o.ride) {
      const driver = othersOutside.get(o.ride);
      if (driver && driver.phase === 'car' && !fNow) {
        Object.assign(e, passengerSeat(driver), { phase: 'car', vf: driver.speed, vs: 0 });
      } else {
        if (driver) Object.assign(e, passengerSeat(driver));
        e.phase = 'car';
        alight(e, solids);
        e.y = Math.max(STREET_Y, Math.min(e.y, STREET_Y + 0.01));
        o.ride = null;
        pressed = false;
      }
    } else cityStep(e, keysNow, dt, solids);
    // Into a car (the one they left, somebody's who drives, or one of the traffic standing near), and out again.
    let nearCar: { x: number; z: number; heading: number; paint: [number, number, number]; index: number } | null = null;
    const nearDriver = e.phase === 'foot' && e.y < STREET_Y + 0.5 ? rideNear(othersOutside, e.x, e.z) : null;
    if (e.phase === 'foot' && !nearDriver) {
      if (o.parked && Math.hypot(o.parked.x - e.x, o.parked.z - e.z) < 4) nearCar = { x: o.parked.x, z: o.parked.z, heading: o.parked.rot, paint: o.parked.paint, index: o.parked.index };
      else if (e.y < STREET_Y + 0.5) {
        const list = cityTraffic(cityLive.quality);
        let bestD = 4.5;
        for (let i = 0; i < list.length; i++) {
          const v = list[i]!;
          if (v.kind === 'bus' || i === cityLive.taken) continue;
          const at = vehicleAt(v, time, CITY_GRID, { x: camera.position.x, z: camera.position.z });
          const d = Math.hypot(at.x - e.x, at.z - e.z);
          if (d < bestD) {
            bestD = d;
            nearCar = { x: at.x, z: at.z, heading: at.heading, paint: v.paint, index: i };
          }
        }
      }
    }
    if (pressed) {
      if (o.ride) {
        // (Handled above.)
      } else if (e.phase === 'car') o.parked = { ...alight(e, solids), paint: e.paint, index: e.vehicle };
      else if (nearDriver) {
        o.ride = nearDriver.id;
        const driver = othersOutside.get(nearDriver.id)!;
        Object.assign(e, passengerSeat(driver), { phase: 'car', vf: 0, vs: 0, time: 0 });
      } else if (nearCar) {
        if (o.parked && o.parked.index !== nearCar.index) o.parked = null;
        if (o.parked) o.parked = null;
        board(e, nearCar);
        cityLive.taken = nearCar.index;
      }
    }
    // Back on the office's own terrace: home.
    if (e.phase === 'foot' && e.y > STREET_Y + DROP_HOME) {
      comeBack();
      outsideRef.current?.(false);
      return;
    }
    // What the keys do now.
    const hint =
      e.phase === 'fall'
        ? 'SPACE — OPEN THE PARACHUTE'
        : e.phase === 'chute'
          ? 'W / S — FASTER, SLOWER · A / D — STEER'
          : o.ride
            ? `RIDING WITH ${(othersOutside.get(o.ride)?.name ?? '').toUpperCase()} · F — GET OUT`
            : e.phase === 'car'
              ? 'F — GET OUT · SHIFT — FASTER'
              : nearDriver
                ? `F — RIDE WITH ${nearDriver.name.toUpperCase()}`
                : nearCar
                  ? 'F — DRIVE THIS CAR'
                  : 'WALK WITH W A S D · SHIFT TO RUN · SPACE TO JUMP';
    if (hint !== o.hint) {
      o.hint = hint;
      hintRef.current?.(hint);
    }

    // ── the camera, behind ──
    const moved = Math.hypot(e.x - x0, e.z - z0) / Math.max(dt, 1e-4);
    if ((moved > 0.6 || e.phase !== 'foot') && Date.now() - s.lookAt > 1500) s.yaw += wrapPi(e.rot + Math.PI - s.yaw) * (1 - Math.exp(-dt * (e.phase === 'car' ? 4 : 2.2)));
    else if (e.rot !== rot0) s.yaw -= rot0 - e.rot;
    const dist = (e.phase === 'car' ? 10 + Math.abs(e.vf) * 0.08 : e.phase === 'foot' ? 6 : e.phase === 'chute' ? 12 : 9) * o.zoom;
    // On the street the camera keeps under the trees' crowns (unless the mouse put it higher).
    if (e.phase === 'foot' && e.y < STREET_Y + 0.5 && Date.now() - s.lookAt > 1500) s.pitch += (0.16 - s.pitch) * (1 - Math.exp(-dt * 2));
    camLook.set(e.x, e.y + (e.phase === 'car' ? 1.3 : e.phase === 'chute' ? 2.2 : 1.5), e.z);
    const cp = Math.cos(s.pitch);
    camPos.set(camLook.x + Math.sin(s.yaw) * cp * dist, camLook.y + Math.sin(s.pitch) * dist, camLook.z + Math.cos(s.yaw) * cp * dist);
    // Never inside a building: the camera comes in front of what is between it and the body.
    for (let i = 1; i <= 12; i++) {
      const t = i / 12;
      const px = camLook.x + (camPos.x - camLook.x) * t;
      const py = camLook.y + (camPos.y - camLook.y) * t;
      const pz = camLook.z + (camPos.z - camLook.z) * t;
      if (blocked(solids, px, pz, py, 0.4, 0) || py < STREET_Y + 0.4) {
        const keep = Math.max(0.12, (i - 1) / 12);
        camPos.set(camLook.x + (camPos.x - camLook.x) * keep, Math.max(STREET_Y + 0.5, camLook.y + (camPos.y - camLook.y) * keep), camLook.z + (camPos.z - camLook.z) * keep);
        break;
      }
    }
    const a = s.jump ? 1 : 1 - Math.exp(-dt * 9);
    s.jump = false;
    camera.position.lerp(camPos, a);
    curLook.current.lerp(camLook, a);
    camera.lookAt(curLook.current);
    // (For captures, as in the office: `window.__orchScene.cam = { pos, look, fov? }` holds the camera there.)
    const held = sceneProbe().cam as { pos: [number, number, number]; look: [number, number, number]; fov?: number } | undefined;
    if (held) {
      camera.position.set(...held.pos);
      camera.lookAt(...held.look);
    }
    camera.updateMatrixWorld();
    const pc = camera as THREE.PerspectiveCamera;
    const fov = held?.fov ? held.fov : e.phase === 'car' ? 58 + Math.min(14, Math.abs(e.vf) * 0.35) : e.phase === 'fall' ? 64 : 55;
    if (Math.abs(pc.fov - fov) > 0.05) {
      pc.fov += (fov - pc.fov) * (1 - Math.exp(-dt * 4));
      pc.updateProjectionMatrix();
    }

    // ── the body, and what it has with it ──
    const m = motion.current;
    const per = dt > 1e-4 ? 1 / dt : 0;
    const wx = (e.x - x0) * per;
    const wz = (e.z - z0) * per;
    const sr = Math.sin(e.rot);
    const cr = Math.cos(e.rot);
    const onFoot = e.phase === 'foot';
    m.vx = onFoot ? wx * cr - wz * sr : 0;
    m.vz = onFoot ? wx * sr + wz * cr : 0;
    m.turn = onFoot ? (e.rot - rot0) * per : 0;
    m.run = onFoot && (Math.abs(m.vz) > 0.3 || Math.abs(m.vx) > 0.3);
    air.current = e.phase === 'fall' ? JUMP_OFF + JUMP_AIR * 0.5 : -1;
    if (avatar.current) {
      avatar.current.position.set(e.x, e.y, e.z);
      avatar.current.rotation.y = e.rot;
      avatar.current.visible = e.phase !== 'car';
    }
    if (ring.current) ring.current.visible = false;
    const bodyOf = (index: number): CarAt['kind'] => {
      const k = cityTraffic(cityLive.quality)[index]?.kind;
      return k === 'suv' ? 'suv' : k === 'taxi' ? 'taxi' : 'sedan';
    };
    gear.current = {
      chute: e.phase === 'chute' ? { x: e.x, y: e.y, z: e.z, rot: e.rot, open: e.chute, bank: THREE.MathUtils.clamp((rot0 - e.rot) / Math.max(dt, 1e-4), -1.5, 1.5) } : null,
      // (Riding, the car is the driver's: drawn with them.)
      car: e.phase === 'car' && !o.ride ? { x: e.x, y: e.y, z: e.z, rot: e.rot, paint: e.paint, speed: e.vf, steer: keysNow.turn, kind: bodyOf(e.vehicle) } : null,
      parked: o.parked ? { x: o.parked.x, y: STREET_Y, z: o.parked.z, rot: o.parked.rot, paint: o.parked.paint, speed: 0, steer: 0, kind: bodyOf(o.parked.index) } : null,
    };
    const probe = ((window as any).__orchPlayer ??= { x: 0, z: 0, rot: 0 });
    // What the others are told (with the presence): where this one is out here, and with what.
    const parkedAt = o.parked;
    ownerOutside.at = {
      phase: o.ride ? 'ride' : e.phase,
      x: e.x,
      y: e.y,
      z: e.z,
      rot: e.rot,
      ...(e.phase === 'chute' ? { chute: e.chute } : {}),
      ...(e.phase === 'car' && !o.ride ? { car: { kind: bodyOf(e.vehicle), paint: e.paint, speed: e.vf, steer: keysNow.turn } } : {}),
      ...(parkedAt ? { parked: { x: parkedAt.x, z: parkedAt.z, rot: parkedAt.rot, kind: bodyOf(parkedAt.index), paint: parkedAt.paint } } : {}),
      ...(o.ride ? { with: o.ride } : {}),
    };
    probe.city = { phase: e.phase, x: e.x, y: e.y, z: e.z, rot: e.rot, chute: e.chute, speed: e.vf, near: nearCar ? nearCar.index : null, taken: cityLive.taken, ride: o.ride, nearDriver: nearDriver?.id ?? null };
    // (Tests may put the body somewhere out there: `__orchPlayer.cityGoto = { x, y, z, rot }`.)
    if (probe.cityGoto) {
      Object.assign(e, { vx: 0, vy: 0, vz: 0, vf: 0, vs: 0 }, probe.cityGoto);
      if (probe.cityGoto.phase === undefined && e.phase !== 'car') e.phase = e.y <= STREET_Y + 0.01 ? 'foot' : 'fall';
      probe.cityGoto = null;
    }
  };

  // The interactable spots, for the UI tests; they move when the floor plan is edited.
  useEffect(() => {
    const probe = ((window as any).__orchPlayer ??= { x: 0, z: 0, rot: 0 });
    probe.spots = world.interactables.map((i) => ({ kind: i.kind, x: i.x, z: i.z }));
    probe.seats = world.seats.map((x) => ({ ...x }));
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

  // A member's room is locked when they leave the office (and gone if their computer is removed). Whoever was standing in it is put back inside the building,
  // by the wall the room was attached to, instead of being left where there is no floor any more.
  useEffect(() => {
    const c = world.base.bounds;
    if (player.x > c.minX && player.x < c.maxX && player.z > c.minZ && player.z < c.maxZ + 6) return;
    if (world.memberRooms.some((r) => !r.locked && !r.closed && player.x > r.reach.minX && player.x < r.reach.maxX && player.z > r.reach.minZ && player.z < r.reach.maxZ)) return;
    const t = terraceRef.current;
    if (t && player.x > t.minX && player.x < t.maxX && player.z > t.minZ && player.z < t.maxZ) return;
    const back = world.nav.nearestWalkable(THREE.MathUtils.clamp(player.x, c.minX + 0.8, c.maxX - 0.8), THREE.MathUtils.clamp(player.z, c.minZ + 0.8, c.maxZ - 0.8));
    if (!back) return;
    player.set(back[0], 0, back[1]);
    st.current.jump = true;
    st.current.vf = st.current.vs = st.current.af = st.current.as = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world]);

  // Jump to an employee when asked (map click, "go to Sarah", notification).
  useEffect(() => {
    if (!focus) return;
    const p = peopleRef.current.find((x) => x.id === focus.employeeId);
    const desk = p?.deskId ? desks.get(p.deskId) : undefined;
    if (!desk) return;
    const seat = deskSeat(desk);
    const bx = seat.x - Math.sin(seat.rot) * 1.5;
    const bz = seat.z - Math.cos(seat.rot) * 1.5;
    // Where there is no room to stand a step and a half behind the chair (a wall is close), the nearest free spot.
    const [fx, fz] = world.nav.walkable(bx, bz) ? [bx, bz] : (world.nav.nearestWalkable(bx, bz) ?? [bx, bz]);
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
      s.pitch = THREE.MathUtils.clamp(s.pitch + dy * 0.004, modeRef.current === 'free' ? -1.3 : out.current.on ? -0.25 : 0.12, 1.35);
      if (s.dragging) s.lookAt = Date.now();
    };
    const pup = () => (last = null);
    const wheel = (e: WheelEvent) => {
      const s = st.current;
      const f = Math.exp(e.deltaY * 0.0012);
      if (out.current.on) out.current.zoom = THREE.MathUtils.clamp(out.current.zoom * f, 0.4, 3);
      else if (modeRef.current === 'management') s.mgmtH = THREE.MathUtils.clamp(s.mgmtH * f, 7, 48);
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

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const s = st.current;
    if (out.current.on && out.current.e) {
      s.lastMode = mode;
      cityFrame(dt, state.clock.elapsedTime);
      return;
    }
    if (ring.current) ring.current.visible = true;
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
    // Sitting: any step gets them up first; until then the body stays where the seat is.
    if (s.seat && (mode === 'workstation' || ((mode === 'ceo' || mode === 'first') && (fwd || k.has(keymap.strafeLeft) || k.has(keymap.strafeRight))))) standUp();
    const walking = (mode === 'ceo' || mode === 'first') && !s.seat;
    if (s.air >= 0) {
      s.air += dt;
      if (s.air >= JUMP_SECONDS) s.air = -1;
    }
    // For looking at a jump in captures: `window.__orchPlayer.hold = seconds` keeps the body at that moment of one.
    const hold = (window as any).__orchPlayer?.hold;
    if (typeof hold === 'number') s.air = hold >= 0 && hold < JUMP_SECONDS ? hold : -1;
    const lift = s.air >= 0 ? jumpY(s.air) : 0;
    air.current = s.air;
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
        const [nx, nz] = moveWithCollision(world, player.x, player.z, dx, dz, 0.3, terraceRef.current);
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
    if (s.seat) {
      // Seated, the body faces the way the seat does; the head (the camera) still looks around.
      player.set(s.seat.x, 0, s.seat.z);
      s.playerRot += wrapPi(s.seat.rot - s.playerRot) * (1 - Math.exp(-dt * 12));
    } else if (mode === 'first') s.playerRot = s.yaw + Math.PI;
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
    // Every pace the keys ask for is a running one: the first step is already a running step, and the last ones (keys let go) are walked.
    m.run = moved && !!(fwd || strafe);
    // Where the owner's character is and which way it faces — read by the UI tests, like `window.__office`.
    const probe = ((window as any).__orchPlayer ??= { x: 0, z: 0, rot: 0 });
    // Tests may also place the character somewhere (`goto`), instead of steering there key by key.
    if (probe.goto) {
      const [gx, gz] = moveWithCollision(world, probe.goto.x, probe.goto.z, 0, 0, 0.3, terraceRef.current);
      player.set(gx, 0, gz);
      if (typeof probe.goto.rot === 'number') {
        s.playerRot = probe.goto.rot;
        s.yaw = probe.goto.rot + Math.PI;
      }
      // (And the camera's angle, when a test puts back a view it took earlier.)
      if (typeof probe.goto.yaw === 'number') s.yaw = probe.goto.yaw;
      if (typeof probe.goto.pitch === 'number') s.pitch = probe.goto.pitch;
      probe.goto = null;
      s.jump = true;
      s.vf = s.vs = s.af = s.as = 0;
    }
    probe.x = ownerPosition.x = player.x;
    probe.z = ownerPosition.z = player.z;
    probe.rot = ownerPosition.rot = s.playerRot;
    probe.yaw = s.yaw;
    probe.pitch = s.pitch;
    probe.sit = s.seat?.id ?? null;
    ownerPosition.sit = !!s.seat;
    probe.y = lift;
    // For the UI tests: the jump's clock, and where the body was really drawn a frame ago — the height of the hip joint and of the left ankle.
    probe.air = s.air;
    const foot = (ankle.current ??= avatar.current?.getObjectByName('foot-l') ?? null);
    if (foot?.parent?.parent) {
      probe.ankleY = foot.matrixWorld.elements[13];
      probe.hipY = foot.parent.parent.matrixWorld.elements[13];
    }

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
      // Through their own eyes: lower when they sit; a jump dips for the push, goes up, and gives on landing.
      const eye = 1.62 - (s.seat ? SIT_DROP : 0) + lift + (s.air >= 0 ? EYE_SINK * jumpSink(s.air) : 0);
      camPos.set(player.x, eye, player.z);
      const cp = Math.cos(s.pitch);
      camLook.set(player.x + fx * cp, eye - Math.sin(s.pitch), player.z + fz * cp);
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
    // For looking at a model up close in tests and captures: `window.__orchScene.cam = { pos, look, fov? }` holds the camera there.
    const held = sceneProbe().cam as { pos: [number, number, number]; look: [number, number, number]; fov?: number } | undefined;
    if (held) {
      camera.position.set(...held.pos);
      camera.lookAt(...held.look);
      if (held.fov) fov = held.fov;
    }
    // Everything drawn this frame (name tags included) is placed with the camera as it is now, not as it was a frame ago.
    camera.updateMatrixWorld();
    const pc = camera as THREE.PerspectiveCamera;
    if (Math.abs(pc.fov - fov) > 0.05) {
      pc.fov += (fov - pc.fov) * a;
      pc.updateProjectionMatrix();
    }

    if (avatar.current) {
      avatar.current.position.set(player.x, lift, player.z);
      avatar.current.rotation.y = s.playerRot;
      avatar.current.visible = mode !== 'first' && mode !== 'workstation';
    }
    // The ring stays on the floor under a jump, and draws in a little the higher the body is.
    if (ring.current) {
      ring.current.position.y = 0.02 - lift;
      ring.current.scale.setScalar(1 - 0.22 * (lift / JUMP_HEIGHT));
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
        const seat = desk ? deskSeat(desk) : null;
        // Where they are: at the board, in the meeting room, at a colleague's desk — or at their own, which is also
        // where somebody is taken to be before they have been drawn once.
        const at = positionsRef.current?.get(p.id) ?? seat;
        if (!at) continue;
        const away = !seat || Math.hypot(seat.x - at.x, seat.z - at.z) > AT_OWN_DESK;
        const d = (at.x - player.x) ** 2 + (at.z - player.z) ** 2;
        // Somebody on their feet is met from a little closer than a desk is: the places people go to (the meeting
        // room, the board) are things one walks up to themselves.
        if (d < (away ? Math.min(bestD, AWAY_REACH * AWAY_REACH) : bestD)) {
          bestD = d;
          best = { kind: 'employee', id: p.id, label: p.name };
          bestDesk = away ? null : desk!;
        }
        // While somebody is being moved, a desk means "swap with whoever sits here" — and that is so whether or not
        // they are in their chair this minute (they may be at the board, in a meeting, at a colleague's desk).
        if (movingRef.current && away && seat) {
          const atDesk = (seat.x - player.x) ** 2 + (seat.z - player.z) ** 2;
          if (atDesk < bestD) {
            bestD = atDesk;
            best = { kind: 'employee', id: p.id, label: p.name };
            bestDesk = desk!;
          }
        }
      }
      for (const w of walkersRef.current ?? []) {
        const at = positionsRef.current?.get(w.id);
        if (!at) continue;
        const d = (at.x - player.x) ** 2 + (at.z - player.z) ** 2;
        if (d < Math.min(bestD, AWAY_REACH * AWAY_REACH)) {
          bestD = d;
          best = { kind: 'employee', id: w.id, label: w.name };
          bestDesk = null;
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
      // A place to sit. Standing right at a seat means the seat even inside a room's own wide circle (the meeting
      // room's chairs are all inside its circle); a thing one walks up to on purpose — the TV, the hi-fi, the vault,
      // the arcade — keeps its meaning. Seated, the only thing in reach is getting up.
      // At the balustrade of the terrace over the city: a way down.
      const t = terraceRef.current;
      if (!best && t && !s.seat) {
        const core = world.base.bounds;
        const outsideTheBuilding = player.x < core.minX || player.x > core.maxX || player.z < core.minZ || player.z > core.maxZ;
        const toEdge = Math.min(player.x - t.minX, t.maxX - player.x, player.z - t.minZ, t.maxZ - player.z);
        if (outsideTheBuilding && toEdge < 1.1) best = { kind: 'edge', id: 'edge', label: 'JUMP OFF THE EDGE' };
      }
      if (s.seat) best = { kind: 'seat', id: s.seat.id, label: 'STAND UP' };
      else if (!best || ROOM_SPOTS.has(best.kind)) {
        let near = best ? SEAT_AT : SEAT_NEAR;
        for (const seat of world.seats) {
          const d = Math.hypot(seat.x - player.x, seat.z - player.z);
          if (d < near) {
            near = d;
            best = { kind: 'seat', id: seat.id, label: seat.kind === 'sofa' ? 'SOFA — SIT DOWN' : 'CHAIR — SIT DOWN' };
          }
        }
      }
      onNearby(best);
    }
    // Before everything else in the frame: the avatar's gait and the name tags then work from this frame's position and camera.
  }, -1);

  return (
    <>
    <CityGear gear={gear} />
    <group ref={avatar}>
      <PlayerBody look={look} motion={motion} jump={air} whipAt={whipAt} ouchAt={ouchAt} emote={emote} seated={seated} />
      <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <ringGeometry args={[0.34, 0.4, 32]} />
        <meshBasicMaterial color="#ffd166" transparent opacity={0.85} toneMapped={false} />
      </mesh>
    </group>
    </>
  );
}

/** Back on the office's own terrace (its floor is at 0) once one stands this high over the street. */
const DROP_HOME = 140;

function PlayerBody({ look, motion, jump, whipAt, ouchAt, emote, seated }: { look?: Appearance; motion: { current: Motion }; jump: { current: number }; whipAt?: number; ouchAt?: number; emote?: { name: string; at: number } | null; seated: boolean }) {
  // The gait reads `motion` every frame, so walking never re-renders; only a whip crack, a flinch or a gesture does (twice: start and end).
  const act = useActs({ whipAt, ouchAt, emote });
  return (
    <Character appearance={look ?? CEO_LOOK} pose={seated ? (act.pose === 'ouch' ? 'ouch' : 'idle') : (act.pose ?? 'stand')} cue={act.cue ?? 0} level={10} motion={motion} jump={jump} whip />
  );
}
