import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Appearance } from '@orchestrator/contracts';
import { Character, DESK_TOP, Model, arcade, coffeeTable, desk, deskPlant, divider, floorLamp, hifi, lampDome, mug, notebook, plant, rug, sofa, taskChair, trophyCase, type PoseName } from '@orchestrator/office-3d/parts';
import { COS, PITCH, SIN, type Geo, type Slot } from './geometry.ts';

/**
 * The little office drawn on the entrance page: the office's own figure and furniture (`@orchestrator/office-3d/parts`),
 * standing on the page as if the page were the floor (`geometry.ts`), and one of them — the intern — keeping up with
 * whoever scrolls.
 *
 * One canvas, a little taller than the window, lies *in* the page and is moved to where the window is before every
 * frame it draws. Between two frames the browser scrolls it together with the text, so furniture never swims
 * against the page; only what really moves (the people) is ever behind by a frame.
 *
 * This is an illustration, not the office: nobody here is a session, and the screens show coloured bars, not text.
 */

// ───────────────────────────── who is who ─────────────────────────────

const LOOKS = {
  intern: { skin: '#e0ac69', hair: '#2b1d0e', hairStyle: 'curly', shirt: '#ffd166', pants: '#27364a', accessory: 'headphones', build: 1 },
  ana: { skin: '#f1c9a5', hair: '#b5651d', hairStyle: 'bun', shirt: '#ff8c5a', pants: '#2d3748', accessory: 'glasses', build: 0.97 },
  ben: { skin: '#8d5524', hair: '#0f0f0f', hairStyle: 'short', shirt: '#5ad67d', pants: '#1f2937', accessory: 'cap', build: 1.03 },
  cho: { skin: '#c68642', hair: '#6b6b6b', hairStyle: 'long', shirt: '#c58cff', pants: '#3b3f5c', accessory: 'none', build: 0.99 },
  dee: { skin: '#ffdbac', hair: '#d9b380', hairStyle: 'curly', shirt: '#3fd0c9', pants: '#4a4238', accessory: 'headphones', build: 1 },
  eli: { skin: '#a9745a', hair: '#4a2f1b', hairStyle: 'bald', shirt: '#7fd1ff', pants: '#27364a', accessory: 'glasses', build: 1.05 },
  fay: { skin: '#e0ac69', hair: '#7a3b1d', hairStyle: 'long', shirt: '#ff5d73', pants: '#2d3748', accessory: 'none', build: 0.96 },
  gus: { skin: '#c68642', hair: '#2b1d0e', hairStyle: 'short', shirt: '#f5c542', pants: '#3b3f5c', accessory: 'cap', build: 1.04 },
  foreman: { skin: '#f1c9a5', hair: '#6b6b6b', hairStyle: 'short', shirt: '#2b3a67', pants: '#1f2937', accessory: 'none', build: 1.06 },
} satisfies Record<string, Appearance>;

type Emote = 'wave' | 'dance' | 'clap' | 'thumbsUp' | 'shrug' | 'point' | 'cheer' | 'bow';
/** How long each gesture of the office's figure lasts (as in `character/motion.ts`). */
const EMOTE_S: Record<Emote, number> = { wave: 2.6, dance: 6.5, clap: 2.8, thumbsUp: 2.2, shrug: 1.9, point: 2.2, cheer: 2.8, bow: 2.3 };

/** What every station shares with the frame that draws it: is it on the canvas right now, and may anything move. */
interface Live {
  seen: { current: boolean };
  still: boolean;
}

// ───────────────────────────── small things ─────────────────────────────

let SCREENS: { busy: THREE.CanvasTexture; idle: THREE.CanvasTexture } | null = null;
const BAR = ['#6ea8ff', '#6fd08c', '#f0c36a', '#c792ea', '#5fd3d0', '#d7dde8', '#5b6677'];

/** A screen at work, as the office draws one from across the floor: coloured bars for lines. Not a terminal's text. */
function paintScreen(tex: THREE.CanvasTexture, rows: number, cursor: boolean): void {
  const c = tex.image as HTMLCanvasElement;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#0b0f17';
  ctx.fillRect(0, 0, c.width, c.height);
  const lh = c.height / 13;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) % 1000) / 1000;
  for (let r = 0; r < 12; r++) {
    let x = c.width * 0.05;
    const n = 1 + Math.floor(rnd() * 4);
    const indent = rnd() < 0.4 ? c.width * 0.06 : 0;
    x += indent;
    for (let i = 0; i < n; i++) {
      const w = c.width * (0.06 + rnd() * 0.2);
      const color = BAR[Math.floor(rnd() * BAR.length)]!;
      if (r < rows && x + w < c.width * 0.95) {
        ctx.globalAlpha = r === 0 ? 1 : 0.86;
        ctx.fillStyle = color;
        ctx.fillRect(x, lh * (r + 0.75), w, lh * 0.42);
      }
      x += w + c.width * 0.02;
    }
    if (r === rows - 1 && cursor) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#ffd166';
      ctx.fillRect(Math.min(x, c.width * 0.9), lh * (r + 0.62), lh * 0.42, lh * 0.7);
    }
  }
  ctx.globalAlpha = 1;
  tex.needsUpdate = true;
}

function screens() {
  if (SCREENS) return SCREENS;
  const make = () => {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 154;
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  };
  SCREENS = { busy: make(), idle: make() };
  paintScreen(SCREENS.busy, 9, true);
  paintScreen(SCREENS.idle, 4, false);
  return SCREENS;
}

const SCREEN_GEO = new THREE.PlaneGeometry(0.6, 0.36);
const lampMats = new Map<string, THREE.MeshStandardMaterial>();
const lampMat = (color: string) => {
  let m = lampMats.get(color);
  if (!m) lampMats.set(color, (m = new THREE.MeshStandardMaterial({ color, emissive: new THREE.Color(color), emissiveIntensity: 1.3, roughness: 0.35, toneMapped: false })));
  return m;
};

/** A picture painted once on a canvas (a sign, a mark over a head). */
function usePainted(w: number, h: number, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): THREE.CanvasTexture {
  const tex = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    draw(c.getContext('2d')!, w, h);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => () => tex.dispose(), [tex]);
  return tex;
}

/**
 * One of the office's people with something to do: a pose held, and optionally a gesture made every `every` seconds.
 * Off the canvas (and on a still page) it is held as it is and costs nothing.
 */
function Actor({ look, pose = 'stand', emote, every = 7, offset = 0, level = 1, live, x = 0, z = 0, rot = 0 }: { look: Appearance; pose?: PoseName; emote?: Emote; every?: number; offset?: number; level?: number; live: Live; x?: number; z?: number; rot?: number }) {
  const [now, setNow] = useState<{ pose: PoseName; cue: number }>({ pose, cue: 0 });
  const last = useRef(-1);
  useFrame((s) => {
    if (!emote || live.still || !live.seen.current) return;
    const t = s.clock.elapsedTime + offset;
    const n = Math.floor(t / every);
    const on = t - n * every < EMOTE_S[emote];
    const key = on ? n : -1;
    if (key === last.current) return;
    last.current = key;
    setNow(on ? { pose: emote, cue: n } : { pose, cue: n });
  });
  return (
    <group position={[x, 0, z]} rotation={[0, rot, 0]}>
      <Character appearance={look} pose={now.pose} cue={now.cue} level={level} phase={offset * 1.7} frozen={() => live.still || !live.seen.current} />
    </group>
  );
}

/** A desk as the office has them — chair, screen, status lamp — and whoever sits at it. */
function Workplace({ x = 0, z = 0, rot = 0, who, pose = 'typing', lamp = '#6ea8ff', screen = 'busy', pulse = false, things = 0, live, offset = 0 }: { x?: number; z?: number; rot?: number; who?: Appearance | null; pose?: PoseName; lamp?: string; screen?: 'busy' | 'idle' | 'off'; pulse?: boolean; things?: number; live: Live; offset?: number }) {
  const pulsing = useMemo(() => (pulse ? lampMat(lamp).clone() : null), [pulse, lamp]);
  useFrame((s) => {
    if (!pulsing || live.still || !live.seen.current) return;
    pulsing.emissiveIntensity = 1.6 + Math.sin(s.clock.elapsedTime * 6) * 1.2;
  });
  const sc = screens();
  return (
    <group position={[x, 0, z]} rotation={[0, rot, 0]}>
      <Model model={desk()} />
      <Model model={taskChair()} position={[0, 0, -0.78]} />
      {screen !== 'off' && (
        <mesh geometry={SCREEN_GEO} position={[-0.08, DESK_TOP - 0.0225 + 0.38, 0.2]} rotation={[0, Math.PI, 0]}>
          <meshBasicMaterial map={screen === 'busy' ? sc.busy : sc.idle} toneMapped={false} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} />
        </mesh>
      )}
      <mesh position={[1.7 / 2 - 0.14, DESK_TOP, 0.3]} geometry={lampDome()} material={pulsing ?? lampMat(lamp)} />
      {(things & 1) > 0 && <Model model={mug('#c96f4a')} position={[0.47, DESK_TOP, 0.1]} rotation={[0, 1.2, 0]} shadows={false} />}
      {(things & 2) > 0 && <Model model={notebook('#35604a')} position={[-0.56, DESK_TOP, -0.12]} rotation={[0, 0.2, 0]} shadows={false} />}
      {(things & 4) > 0 && <Model model={deskPlant()} position={[-0.68, DESK_TOP, 0.26]} scale={1.25} shadows={false} />}
      {who && <Actor look={who} pose={pose} live={live} z={-0.78} offset={offset} />}
    </group>
  );
}

const RECORD_GEO = { disc: new THREE.CylinderGeometry(0.173, 0.173, 0.006, 48), label: new THREE.CylinderGeometry(0.05, 0.05, 0.004, 28) };
const RECORD_VINYL = new THREE.MeshStandardMaterial({ color: '#0d0e12', roughness: 0.32, metalness: 0.1 });
const RECORD_LABEL = new THREE.MeshStandardMaterial({ color: '#ff5fa2', roughness: 0.7 });
const WALL = new THREE.MeshStandardMaterial({ color: '#232b3d', roughness: 0.9 });
const WALL_TRIM = new THREE.MeshStandardMaterial({ color: '#2f3a52', roughness: 0.7 });
const DOOR_LEAF = new THREE.MeshStandardMaterial({ color: '#c79a63', roughness: 0.55 });
const DOOR_KNOB = new THREE.MeshStandardMaterial({ color: '#ffd166', roughness: 0.3, metalness: 0.8 });
const DOOR_LIGHT = new THREE.MeshBasicMaterial({ color: '#ffe2a8', toneMapped: false });
const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const WALL_GEO = { left: box(1.5, 2.5, 0.12), right: box(0.9, 2.5, 0.12), top: box(1.0, 0.4, 0.12), leaf: box(0.96, 2.06, 0.05), light: new THREE.PlaneGeometry(0.98, 2.08), knob: new THREE.SphereGeometry(0.045, 14, 10), skirt: box(3.4, 0.1, 0.14) };

/**
 * A piece of wall with the office's door in it and its neon sign on it. Shut at the top of the page; at the bottom it
 * stands ajar with the light on inside.
 */
function DoorWall({ open }: { open: boolean }) {
  // The sign over the door, in the manner of the office's own neon: tubes of light with a glow around them.
  const sign = usePainted(1024, 420, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const text = open ? 'come on in.' : 'knock, knock.';
    const face = '"Snell Roundhand", "Brush Script MT", "Segoe Script", cursive';
    let size = h * 0.62;
    ctx.font = `italic 700 ${size}px ${face}`;
    while (size > h * 0.2 && ctx.measureText(text).width > w * 0.84) ctx.font = `italic 700 ${(size *= 0.95)}px ${face}`;
    const [glow, tube] = open ? ['#ffb020', '#fff3d6'] : ['#ff4d9a', '#ffe3f0'];
    for (const [blur, alpha, width] of [[h * 0.2, 0.6, 12], [h * 0.09, 0.85, 9], [0, 1, 5]] as Array<[number, number, number]>) {
      ctx.shadowColor = glow;
      ctx.shadowBlur = blur;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = blur ? glow : tube;
      ctx.lineWidth = width;
      ctx.strokeText(text, w / 2, h * 0.5);
    }
    ctx.globalAlpha = 1;
  });
  // The door is 1 m wide, between x = −0.2 and x = 0.8; the wall runs from −1.7 to 1.7.
  return (
    <group>
      <mesh geometry={WALL_GEO.left} material={WALL} position={[-0.95, 1.25, 0]} castShadow receiveShadow />
      <mesh geometry={WALL_GEO.right} material={WALL} position={[1.25, 1.25, 0]} castShadow receiveShadow />
      <mesh geometry={WALL_GEO.top} material={WALL} position={[0.3, 2.3, 0]} castShadow />
      <mesh geometry={WALL_GEO.skirt} material={WALL_TRIM} position={[0, 0.05, 0]} />
      {open && <mesh geometry={WALL_GEO.light} material={DOOR_LIGHT} position={[0.3, 1.04, -0.05]} />}
      <group position={[-0.18, 0, 0.04]} rotation={[0, open ? -1.05 : 0, 0]}>
        <mesh geometry={WALL_GEO.leaf} material={DOOR_LEAF} position={[0.48, 1.03, 0]} castShadow />
        <mesh geometry={WALL_GEO.knob} material={DOOR_KNOB} position={[0.86, 1.02, 0.05]} />
      </group>
      <mesh position={[-0.9, 1.5, 0.075]}>
        <planeGeometry args={[1.5, 0.615]} />
        <meshBasicMaterial map={sign} transparent depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  );
}

/** The mark over somebody who is asking: the office's own amber question mark. */
function Asking({ y = 1.9 }: { y?: number }) {
  const tex = usePainted(128, 128, (ctx, w) => {
    ctx.clearRect(0, 0, w, w);
    ctx.fillStyle = '#ffb020';
    ctx.beginPath();
    ctx.arc(w / 2, w / 2, w * 0.44, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1a1405';
    ctx.font = `800 ${w * 0.62}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('?', w / 2, w * 0.54);
  });
  return (
    <sprite position={[0, y, 0]} scale={[0.34, 0.34, 1]}>
      <spriteMaterial map={tex} toneMapped={false} depthWrite={false} />
    </sprite>
  );
}

// ───────────────────────────── the places ─────────────────────────────

/** Where the intern goes at a place, in the place's own frame (x to the right, z toward the viewer). */
interface Spot {
  x: number;
  z: number;
  rot: number;
  label: string;
  /** Sits down (and holds this pose) instead of standing. */
  sit?: PoseName;
  /** Walks here first, so as not to go through the furniture. */
  via?: [number, number];
  /** The gesture made here, again and again while staying. */
  emote?: Emote;
  /** On a still page the intern is shown here, not moving. */
  calm?: boolean;
}

interface Place {
  /** Turned by this much about the vertical. */
  rot: number;
  /** How far its things reach from its origin, in metres (for knowing when it is on the canvas). */
  reach: number;
  spot?: Spot;
  render: (live: Live) => ReactNode;
}

const PLACES: Record<string, Place> = {
  // The top of the page: the door, shut, and the intern in front of it.
  lobby: {
    rot: -0.2,
    reach: 3,
    spot: { x: -0.75, z: 1.05, rot: 0.25, label: 'SAYING HELLO', emote: 'wave', calm: true },
    render: () => (
      <>
        <group position={[0, 0, -0.55]}>
          <DoorWall open={false} />
        </group>
        <Model model={rug(2.3, 1.5, '#3b4a6b', '#2a3550')} position={[-0.1, 0, 0.75]} />
        <Model model={plant(2)} position={[1.25, 0, 0.2]} />
      </>
    ),
  },
  // Four desks back to back, as on the office's floor, with three of them taken.
  pod: {
    rot: -0.5,
    reach: 3.6,
    render: (live) => (
      <>
        <Workplace x={-0.95} z={-0.5} who={LOOKS.ana} pose="typing" lamp="#6ea8ff" things={5} live={live} offset={0.3} />
        <Workplace x={0.95} z={-0.5} who={LOOKS.ben} pose="thinking" lamp="#c792ea" things={2} live={live} offset={2.1} />
        <Workplace x={-0.95} z={0.5} rot={Math.PI} who={LOOKS.cho} pose="reading" lamp="#3ddc84" things={3} live={live} offset={4.2} />
        <Workplace x={0.95} z={0.5} rot={Math.PI} who={null} screen="off" lamp="#4a5261" live={live} />
        <Model model={divider(1.7 * 2 + 0.2)} />
        <Model model={plant(0)} position={[-2.7, 0, 0.3]} />
      </>
    ),
  },
  // The intern's own desk.
  desk: {
    rot: -0.7,
    reach: 2.4,
    spot: { x: 0, z: -0.78, rot: 0, label: 'TYPING', sit: 'typing', via: [-0.85, -0.9], calm: true },
    render: (live) => (
      <>
        <Workplace who={null} lamp="#ffd166" things={7} live={live} />
        <Model model={floorLamp()} position={[1.2, 0, -0.9]} />
      </>
    ),
  },
  // Somebody with a hand up, and the lamp on their desk asking for an answer.
  hand: {
    rot: -0.55,
    reach: 2.6,
    spot: { x: -1.25, z: -0.5, rot: 1.25, label: 'LISTENING', emote: 'thumbsUp' },
    render: (live) => (
      <>
        <Workplace who={LOOKS.dee} pose="raiseHand" lamp="#ffb020" pulse things={1} live={live} offset={1.2} />
        <group position={[0, 0, -0.78]}>
          <Asking y={1.86} />
        </group>
      </>
    ),
  },
  // What the office keeps of work that was really finished.
  trophies: {
    rot: -0.35,
    reach: 2.4,
    spot: { x: -1.05, z: 0.85, rot: 2.3, label: 'CHEERING', emote: 'cheer' },
    render: () => (
      <>
        <Model model={trophyCase()} position={[0.2, 0, -0.2]} />
        <Model model={plant(1)} position={[1.55, 0, 0.35]} />
      </>
    ),
  },
  // The foreman on a round, at the desk of somebody who has nodded off.
  foreman: {
    rot: -0.6,
    reach: 2.8,
    spot: { x: -1.5, z: 0.5, rot: 1.0, label: 'STAYING OUT OF IT', emote: 'shrug' },
    render: (live) => (
      <>
        <Workplace who={LOOKS.eli} pose="offline" lamp="#4a5261" screen="idle" things={3} live={live} offset={3.3} />
        <Actor look={LOOKS.foreman} level={9} emote="point" every={6} offset={1} live={live} x={-1.15} z={-0.95} rot={1.45} />
      </>
    ),
  },
  // People who came in from elsewhere.
  guests: {
    rot: -0.3,
    reach: 2.6,
    spot: { x: 0, z: 0.95, rot: 3.1, label: 'MEETING THE OTHERS', emote: 'wave' },
    render: (live) => (
      <>
        <Model model={rug(2.8, 2, '#2f5d62', '#234447')} />
        <Actor look={LOOKS.fay} emote="wave" every={8} offset={0.5} live={live} x={-0.75} z={-0.25} rot={0.9} />
        <Actor look={LOOKS.gus} emote="clap" every={9} offset={4} live={live} x={0.8} z={-0.3} rot={-0.8} />
        <Model model={plant(2)} position={[1.5, 0, -1.0]} />
      </>
    ),
  },
  // The break room: the hi-fi, somewhere to sit, a game.
  lounge: {
    rot: -0.4,
    reach: 3.2,
    spot: { x: 0.1, z: 0.9, rot: 0.3, label: 'DANCING', emote: 'dance', calm: true },
    render: () => (
      <>
        <Model model={rug(3, 2, '#5a3f6b', '#40304d')} position={[0, 0, 0.5]} />
        <group position={[0, 0, -1.0]} scale={0.82}>
          <Model model={hifi()} />
          {/* The record on the platter, which the office also lays on top of the model. */}
          <mesh geometry={RECORD_GEO.disc} material={RECORD_VINYL} position={[0.32, 0.6435, 0.02]} />
          <mesh geometry={RECORD_GEO.label} material={RECORD_LABEL} position={[0.32, 0.6465, 0.02]} />
        </group>
        <Model model={arcade()} position={[-1.85, 0, -0.45]} rotation={[0, 0.55, 0]} />
        <Model model={sofa(1.5, '#c96f4a')} position={[1.8, 0, 0.7]} rotation={[0, Math.PI / 2 + 0.25, 0]} />
        <Model model={coffeeTable(0.9, 0.55)} position={[0.95, 0, 1.3]} rotation={[0, -0.3, 0]} />
      </>
    ),
  },
  // The bottom of the page: the door again, ajar.
  door: {
    rot: -0.2,
    reach: 3,
    spot: { x: -0.85, z: 1.0, rot: 0.3, label: 'THIS IS THE DOOR', emote: 'wave', calm: true },
    render: () => (
      <>
        <group position={[0, 0, -0.55]}>
          <DoorWall open />
        </group>
        <Model model={rug(2.3, 1.5, '#6b4a2f', '#4d3521')} position={[-0.1, 0, 0.75]} />
        <Model model={plant(0)} position={[1.3, 0, 0.25]} />
      </>
    ),
  },
};

interface Placed {
  id: string;
  kind: string;
  place: Place;
  x: number;
  z: number;
  live: Live;
}

/** A spot in the scene's own measure. */
interface Way extends Spot {
  wx: number;
  wz: number;
  wrot: number;
  vx: number | null;
  vz: number | null;
  /** Where on the page (pixels from its top) the spot is, and how near the window's focus has to be for the intern to stay. */
  y: number;
  band: number;
}

const wrapPi = (a: number) => {
  let r = (a + Math.PI) % (Math.PI * 2);
  if (r < 0) r += Math.PI * 2;
  return r - Math.PI;
};

// ───────────────────────────── the intern ─────────────────────────────

/** What the page is told every frame, without React: where the canvas lies and where the intern is on it. */
interface Shared {
  /** The page pixel the canvas' top edge is at. */
  top: number;
  scroll: number;
  /** The pointer, in page pixels (or far away). */
  px: number;
  py: number;
  /** Changed to make the intern flinch (a click on it). */
  ouch: number;
  /** The intern on the canvas: feet, and the height of its head above them, in pixels. */
  gx: number;
  gy: number;
  gh: number;
}

/** Where on the window the intern likes to be, from the top. */
const FOCUS = 0.64;
const TOP_SPEED = 8.2;
const ACCEL = 30;

function Intern({ geo, ways, still, shared, tag, pool }: { geo: Geo; ways: Way[]; still: boolean; shared: Shared; tag: RefObject<HTMLDivElement | null>; pool: RefObject<HTMLDivElement | null> }) {
  const group = useRef<THREE.Group>(null);
  const [act, setAct] = useState<{ pose: PoseName; cue: number }>({ pose: 'stand', cue: 0 });
  const look = useRef(0);
  const s = useRef({ x: 0, z: 0, vx: 0, vz: 0, yaw: 0, at: -2, path: [] as Array<[number, number]>, step: 0, out: 0, acting: false, rise: 0, since: 0, emoting: false, cue: 0, label: '', ouch: 0, ouchUntil: 0, back: null as { pose: PoseName; cue: number } | null, placed: false });
  const waysRef = useRef(ways);
  waysRef.current = ways;
  const geoRef = useRef(geo);
  geoRef.current = geo;
  // A new layout: stand where the page now says.
  useLayoutEffect(() => {
    s.current.placed = false;
  }, [geo.ppu, geo.vw, ways]);

  useFrame((state, rawDt) => {
    const g = geoRef.current;
    const W = waysRef.current;
    const st = s.current;
    const k = g.ppu * SIN;
    const dt = Math.min(rawDt, 0.05);
    const t = state.clock.elapsedTime;
    const S = shared.scroll;
    const F = S + g.vh * FOCUS;
    const say = (label: string) => {
      if (label === st.label) return;
      st.label = label;
      const el = tag.current?.querySelector('.ent-tag-state');
      if (el) el.textContent = label;
    };

    // Which place the window is at, if any.
    let near = -1;
    let best = Infinity;
    for (let i = 0; i < W.length; i++) {
      const d = Math.abs(F - W[i]!.y);
      if (d < W[i]!.band && d < best) {
        best = d;
        near = i;
      }
    }
    // Above the first place and below the last there is nowhere else to be.
    if (near < 0 && W.length) near = F <= W[0]!.y ? 0 : F >= W[W.length - 1]!.y ? W.length - 1 : -1;

    if (still) {
      // A calm page: no walking. The intern is simply at the nearest of a few places, as it would be there.
      let pick = -1;
      let dist = Infinity;
      for (let i = 0; i < W.length; i++) {
        if (!W[i]!.calm) continue;
        const d = Math.abs(F - W[i]!.y);
        if (d < dist) {
          dist = d;
          pick = i;
        }
      }
      const w = W[pick];
      if (w && st.at !== pick) {
        st.at = pick;
        st.x = w.wx;
        st.z = w.wz;
        st.yaw = w.wrot;
        setAct({ pose: w.sit ?? 'stand', cue: 0 });
        say(w.sit ? w.label : 'HERE IF YOU NEED ME');
      }
    } else {
      const lane = g.corridor / g.ppu;
      const w = W[near];
      if (!st.placed) {
        // First frame (or a new layout): be where the window is, not on the way there.
        st.placed = true;
        st.vx = st.vz = 0;
        st.at = near;
        st.acting = false;
        st.x = w ? w.wx : lane;
        st.z = w ? w.wz : F / k;
        st.yaw = w ? w.wrot : 0;
        st.path = w ? [[w.wx, w.wz]] : [];
        st.step = 0;
        st.out = 0;
      }
      if (st.at !== near) {
        // Going somewhere else. Out of a place the way it was come into — back past its furniture to the walkway —
        // and into the next one from the walkway: level with it, then round to the chair, then onto it.
        const out: Array<[number, number]> = [];
        const was = W[st.at];
        if (was) {
          const into = Math.max(0, st.step - st.out);
          if (st.acting && was.sit) st.rise = 0.28;
          if (was.vx !== null && into >= 2) out.push([was.vx, was.vz!]);
          if (into >= 1) out.push([lane, was.vz ?? was.wz]);
          if (st.acting || st.emoting) setAct({ pose: 'stand', cue: st.cue });
          st.acting = false;
          st.emoting = false;
        }
        st.at = near;
        st.out = out.length;
        if (w) {
          out.push([lane, w.vz ?? w.wz]);
          if (w.vx !== null) out.push([w.vx, w.vz!]);
          out.push([w.wx, w.wz]);
        }
        st.path = out;
        st.step = 0;
      }
      // Counted from the walkway: 0 on the way to the place's gate, 1 past it, 2 past the corner by the chair.
      const into = Math.max(0, st.step - st.out);

      // Left far behind (a long jump of the page): come in from just beyond the edge of the window instead of running the whole way.
      const gy = st.z * k;
      if (!st.acting && (gy < S - 260 || gy > S + g.vh + 260)) {
        st.z = (gy < S ? S - 90 : S + g.vh + 150) / k;
        st.x = lane;
        st.vx = st.vz = 0;
        // What was left of the way out is behind now.
        if (st.step < st.out) {
          st.path = st.path.slice(st.out);
          st.out = 0;
          st.step = 0;
        }
      }

      if (st.rise > 0) st.rise -= dt;
      else if (!st.acting) {
        const next = st.path[st.step];
        const last = st.step >= st.path.length - 1;
        const tx = next ? next[0] : lane;
        const tz = next ? next[1] : Math.max(W[0]?.wz ?? 0, Math.min(W[W.length - 1]?.wz ?? 1e9, F / k));
        const dx = tx - st.x;
        const dz = tz - st.z;
        const dist = Math.hypot(dx, dz);
        const pace = Math.hypot(st.vx, st.vz);
        if (next && (!last || !w) && dist < 0.28) st.step++;
        else if (next && last && w && dist < 0.07 && pace < 1.2) {
          // Arrived.
          st.x = w.wx;
          st.z = w.wz;
          st.vx = st.vz = 0;
          st.acting = true;
          st.since = t;
          st.emoting = !w.sit && !!w.emote;
          setAct({ pose: w.sit ?? w.emote ?? 'stand', cue: ++st.cue });
          say(w.label);
        } else if (dist > 0.004) {
          // As fast as the legs go — faster the further behind — and slowing only for the last stretch.
          let left = dist;
          for (let i = st.step; i < st.path.length - 1; i++) left += Math.hypot(st.path[i + 1]![0] - st.path[i]![0], st.path[i + 1]![1] - st.path[i]![1]);
          const top = TOP_SPEED + Math.max(0, Math.min(4, (left - 4) * 0.8));
          const want = Math.min(top, (next && w ? left : dist) * 5.5 + 0.35);
          let ax = (dx / dist) * want - st.vx;
          let az = (dz / dist) * want - st.vz;
          const a = Math.hypot(ax, az);
          const most = ACCEL * dt;
          if (a > most) {
            ax *= most / a;
            az *= most / a;
          }
          st.vx += ax;
          st.vz += az;
          st.x += st.vx * dt;
          st.z += st.vz * dt;
        } else st.vx = st.vz = 0;
      } else if (w && w.emote && !w.sit) {
        // Staying: the gesture again after a pause.
        const len = EMOTE_S[w.emote];
        if (st.emoting && t - st.since > len) {
          st.emoting = false;
          setAct({ pose: 'stand', cue: st.cue });
        } else if (!st.emoting && t - st.since > len + 1.8) {
          st.emoting = true;
          st.since = t;
          setAct({ pose: w.emote, cue: ++st.cue });
        }
      }

      const speed = Math.hypot(st.vx, st.vz);
      if (!st.acting) say(speed > 3.4 ? 'CATCHING UP' : speed > 0.5 ? 'WALKING WITH YOU' : 'WAITING FOR YOU');
      // Facing: the way it goes; at a place, the way the place asks; otherwise the viewer.
      const face = st.acting && w ? w.wrot : speed > 0.45 ? Math.atan2(st.vx, st.vz) : w && into >= 1 && Math.hypot(w.wx - st.x, w.wz - st.z) < 0.3 ? w.wrot : 0;
      st.yaw += wrapPi(face - st.yaw) * (1 - Math.exp(-dt * (st.acting ? 16 : 11)));

      // The head follows the pointer when there is nothing else to do.
      let want = 0;
      if (speed < 0.3 && !(st.acting && w?.sit) && shared.px > -1e5) {
        const a = wrapPi(Math.atan2(shared.px / g.ppu - st.x, shared.py / k - st.z) - st.yaw);
        if (Math.abs(a) < 1.5) want = Math.max(-0.9, Math.min(0.9, a * 0.8));
      }
      look.current += (want - look.current) * (1 - Math.exp(-dt * 6));

      // A click on the intern: the office's whip, which sends nothing to anybody.
      if (shared.ouch !== st.ouch) {
        st.ouch = shared.ouch;
        st.ouchUntil = t + 0.95;
        setAct((a) => {
          if (a.pose !== 'ouch') st.back = a;
          return { pose: 'ouch', cue: ++st.cue };
        });
        tag.current?.classList.add('is-ouch');
      } else if (st.ouchUntil && t > st.ouchUntil) {
        st.ouchUntil = 0;
        tag.current?.classList.remove('is-ouch');
        const back = st.back;
        st.back = null;
        setAct(st.acting ? (back ?? { pose: 'stand', cue: st.cue }) : { pose: 'stand', cue: st.cue });
      }
    }

    if (group.current) {
      group.current.position.set(st.x, 0, st.z);
      group.current.rotation.y = st.yaw;
    }
    // The name tag and the pool of light under the feet are part of the page, moved with the figure.
    const seated = st.acting && !!W[st.at]?.sit;
    const gx = st.x * g.ppu;
    const gyc = st.z * k - shared.top;
    const head = (seated ? 1.5 : 1.98) * g.ppu * COS;
    shared.gx = gx;
    shared.gy = gyc + shared.top;
    shared.gh = head;
    if (tag.current) tag.current.style.transform = `translate3d(${gx.toFixed(1)}px, ${(gyc - head).toFixed(1)}px, 0) translate(-50%, -100%)`;
    if (pool.current) pool.current.style.transform = `translate3d(${gx.toFixed(1)}px, ${gyc.toFixed(1)}px, 0) translate(-50%, -50%)`;
  }, -1);

  return (
    <group ref={group}>
      <Character appearance={LOOKS.intern} pose={act.pose} cue={act.cue} look={look} phase={0.4} frozen={still ? () => true : undefined} />
    </group>
  );
}

// ───────────────────────────── the scene ─────────────────────────────

const SUN_DIR = new THREE.Vector3(0.42, -1, 0.5).normalize();
const DIST = 60;

function Scene({ geo, slots, scroller, wrap, still, shared, tag, pool }: { geo: Geo; slots: Slot[]; scroller: HTMLElement; wrap: RefObject<HTMLDivElement | null>; still: boolean; shared: Shared; tag: RefObject<HTMLDivElement | null>; pool: RefObject<HTMLDivElement | null> }) {
  const { camera, gl, scene, invalidate } = useThree();
  const sun = useRef<THREE.DirectionalLight>(null);
  const floor = useRef<THREE.Mesh>(null);
  const groups = useRef(new Map<string, THREE.Group>());
  const k = geo.ppu * SIN;

  // Soft reflections for the metal and glass of the furniture, as in the office.
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    scene.environmentIntensity = 0.3;
    return () => {
      scene.environment = null;
      env.dispose();
      pmrem.dispose();
    };
  }, [gl, scene]);

  const placed = useMemo<Placed[]>(
    () =>
      slots.flatMap((sl) => {
        const place = PLACES[sl.kind];
        return place ? [{ id: sl.id, kind: sl.kind, place, x: sl.x / geo.ppu, z: sl.y / k, live: { seen: { current: true }, still } }] : [];
      }),
    [slots, geo.ppu, k, still],
  );

  const ways = useMemo<Way[]>(() => {
    const out: Way[] = [];
    for (const p of placed) {
      const sp = p.place.spot;
      if (!sp) continue;
      const c = Math.cos(p.place.rot);
      const sn = Math.sin(p.place.rot);
      const at = (x: number, z: number): [number, number] => [p.x + x * c + z * sn, p.z - x * sn + z * c];
      const [wx, wz] = at(sp.x, sp.z);
      const via = sp.via ? at(sp.via[0], sp.via[1]) : null;
      out.push({ ...sp, wx, wz, wrot: sp.rot + p.place.rot, vx: via ? via[0] : null, vz: via ? via[1] : null, y: wz * k, band: 0 });
    }
    out.sort((a, b) => a.y - b.y);
    // Stay at a place while the window's focus is within a fifth of the window of it — less where two places are close.
    out.forEach((w, i) => {
      const gap = Math.min(i > 0 ? w.y - out[i - 1]!.y : Infinity, i < out.length - 1 ? out[i + 1]!.y - w.y : Infinity);
      w.band = Math.min(geo.vh * 0.2, gap * 0.4);
    });
    return out;
  }, [placed, k, geo.vh]);

  // The light keeps its direction and moves with the window; its shadow covers what the canvas shows.
  const lightBasis = useMemo(() => {
    const m = new THREE.Matrix4().lookAt(new THREE.Vector3().copy(SUN_DIR).multiplyScalar(-1), new THREE.Vector3(), new THREE.Vector3(0, 1, 0));
    return { r: new THREE.Vector3().setFromMatrixColumn(m, 0), u: new THREE.Vector3().setFromMatrixColumn(m, 1) };
  }, []);
  const hc = geo.vh + 2 * geo.over;
  const half = Math.max(geo.vw / geo.ppu, hc / k) / 2 + 3;
  useLayoutEffect(() => {
    const cam = camera as THREE.OrthographicCamera;
    cam.zoom = geo.ppu;
    cam.near = 1;
    cam.far = DIST * 3;
    cam.rotation.set(-PITCH, 0, 0);
    cam.updateProjectionMatrix();
    const l = sun.current;
    if (l) {
      const sc = l.shadow.camera;
      sc.left = sc.bottom = -half;
      sc.right = sc.top = half;
      sc.near = 1;
      sc.far = 160;
      sc.updateProjectionMatrix();
      l.shadow.bias = -0.0005;
      l.shadow.normalBias = 0.035;
      l.shadow.needsUpdate = true;
    }
    invalidate();
  }, [camera, geo.ppu, half, invalidate]);

  const tmp = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    const S = scroller.scrollTop;
    const top = Math.round(S - geo.over);
    shared.top = top;
    shared.scroll = S;
    if (wrap.current) wrap.current.style.transform = `translate3d(0, ${top}px, 0)`;
    const cx = geo.vw / 2 / geo.ppu;
    const cz = (top + hc / 2) / k;
    camera.position.set(cx, DIST * SIN, cz + DIST * COS);
    floor.current?.position.set(cx, 0.003, cz);
    const l = sun.current;
    if (l) {
      // Moved in whole texels of its shadow map, so shadows do not shimmer as the page scrolls.
      const texel = (half * 2) / l.shadow.mapSize.x;
      tmp.set(cx, 0, cz);
      const a = Math.round(tmp.dot(lightBasis.r) / texel) * texel;
      const b = Math.round(tmp.dot(lightBasis.u) / texel) * texel;
      const c = tmp.dot(SUN_DIR);
      l.target.position.set(0, 0, 0).addScaledVector(lightBasis.r, a).addScaledVector(lightBasis.u, b).addScaledVector(SUN_DIR, c);
      l.position.copy(l.target.position).addScaledVector(SUN_DIR, -70);
      l.target.updateMatrixWorld();
    }
    // Only what is on the canvas is drawn, or moved.
    for (const p of placed) {
      const y = p.z * k;
      const r = p.place.reach * geo.ppu;
      const seen = y + r > top - 40 && y - r - 2.4 * geo.ppu < top + hc + 40;
      p.live.seen.current = seen;
      const grp = groups.current.get(p.id);
      if (grp && grp.visible !== seen) grp.visible = seen;
    }
  }, -2);

  // The screens of people at work change a little, a few times a second.
  const tick = useRef(0);
  useFrame((s) => {
    if (still) return;
    const n = Math.floor(s.clock.elapsedTime * 2.5);
    if (n === tick.current) return;
    tick.current = n;
    paintScreen(screens().busy, 4 + (n % 9), n % 2 === 0);
  });

  return (
    <>
      <hemisphereLight args={['#d6e4ff', '#4a4f66', 1.35]} />
      <directionalLight ref={sun} castShadow intensity={2.9} color="#ffeccf" shadow-mapSize={[2048, 2048]} />
      <directionalLight position={[-30, 20, 40]} intensity={0.5} color="#9db8ff" />
      <mesh ref={floor} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[140, 140]} />
        <shadowMaterial transparent opacity={0.5} />
      </mesh>
      {placed.map((p) => (
        <group
          key={p.id}
          ref={(g) => {
            if (g) groups.current.set(p.id, g);
            else groups.current.delete(p.id);
          }}
          position={[p.x, 0, p.z]}
          rotation={[0, p.place.rot, 0]}
        >
          {p.place.render(p.live)}
        </group>
      ))}
      <Intern geo={geo} ways={ways} still={still} shared={shared} tag={tag} pool={pool} />
    </>
  );
}

export interface StageProps {
  geo: Geo;
  slots: Slot[];
  scroller: HTMLElement;
  /** A calm page: nothing runs, nothing waves. */
  still: boolean;
  /** Said once the first frame is on the page (the page's own pools of light under the furniture then make sense). */
  onReady?: () => void;
}

export default function Stage({ geo, slots, scroller, still, onReady }: StageProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const tag = useRef<HTMLDivElement>(null);
  const pool = useRef<HTMLDivElement>(null);
  const shared = useRef<Shared>({ top: 0, scroll: 0, px: -1e6, py: -1e6, ouch: 0, gx: -1e6, gy: -1e6, gh: 0 }).current;
  const hc = geo.vh + 2 * geo.over;
  const invalidate = useRef<() => void>(() => undefined);
  const [idle, setIdle] = useState(false);

  // No more pixels than a mid-range laptop draws comfortably.
  const dpr = useMemo(() => {
    const want = Math.min(window.devicePixelRatio || 1, 1.5);
    return Math.max(0.75, Math.min(want, Math.sqrt(4_200_000 / (geo.vw * hc))));
  }, [geo.vw, hc]);

  useEffect(() => {
    // After a minute of nobody doing anything the drawing stops (the figures hold their pose) until somebody does.
    let timer = 0;
    const awake = () => {
      setIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), 60_000);
    };
    const page = scroller;
    const rectOf = () => page.getBoundingClientRect();
    const onMove = (e: PointerEvent) => {
      const r = rectOf();
      shared.px = e.clientX - r.left;
      shared.py = e.clientY - r.top + page.scrollTop;
      const over = hit(e.clientX - r.left, e.clientY - r.top + page.scrollTop);
      page.classList.toggle('ent-over-intern', over);
      awake();
      if (still) invalidate.current();
    };
    const hit = (x: number, y: number) => Math.abs(x - shared.gx) < geo.ppu * 0.42 && y < shared.gy + geo.ppu * 0.12 && y > shared.gy - shared.gh * 0.92;
    const onClick = (e: MouseEvent) => {
      if (still || (e.target as HTMLElement | null)?.closest?.('a, button, input, label, form, .ent-door')) return;
      const r = rectOf();
      if (hit(e.clientX - r.left, e.clientY - r.top + page.scrollTop)) shared.ouch++;
    };
    const onScroll = () => {
      awake();
      invalidate.current();
    };
    const onLeave = () => {
      shared.px = shared.py = -1e6;
    };
    page.addEventListener('pointermove', onMove, { passive: true });
    page.addEventListener('pointerleave', onLeave, { passive: true });
    page.addEventListener('click', onClick);
    page.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('keydown', awake);
    awake();
    return () => {
      window.clearTimeout(timer);
      page.removeEventListener('pointermove', onMove);
      page.removeEventListener('pointerleave', onLeave);
      page.removeEventListener('click', onClick);
      page.removeEventListener('scroll', onScroll);
      window.removeEventListener('keydown', awake);
      page.classList.remove('ent-over-intern');
    };
  }, [scroller, shared, still, geo.ppu]);

  return (
    <div ref={wrap} className="ent-stage" style={{ height: hc }} aria-hidden>
      <div ref={pool} className="ent-follow-pool" />
      <Canvas
        orthographic
        shadows
        frameloop={still || idle ? 'demand' : 'always'}
        dpr={dpr}
        gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
        camera={{ zoom: geo.ppu, near: 1, far: DIST * 3, position: [0, DIST * SIN, DIST * COS] }}
        resize={{ scroll: false, debounce: { scroll: 0, resize: 0 } }}
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
        onCreated={(state) => {
          state.gl.setClearColor(0x000000, 0);
          state.gl.toneMapping = THREE.ACESFilmicToneMapping;
          state.gl.toneMappingExposure = 1.12;
          invalidate.current = state.invalidate;
          onReady?.();
        }}
      >
        <Scene geo={geo} slots={slots} scroller={scroller} wrap={wrap} still={still} shared={shared} tag={tag} pool={pool} />
      </Canvas>
      <div ref={tag} className="ent-tag">
        <div className="ent-tag-ouch">jao!</div>
        <div className="ent-tag-name">The intern</div>
        <div className="ent-tag-state">WAITING FOR YOU</div>
      </div>
    </div>
  );
}
