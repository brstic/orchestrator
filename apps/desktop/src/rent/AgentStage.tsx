/**
 * The Rent portal's 3D (`docs/RENT.md`): the employee a client talks to, at their desk — the same figure and furniture
 * the office draws (`@orchestrator/office-3d/parts`), in a pool of light on the night floor of the entrance page.
 *
 *   AgentStage  one employee at work: typing or reading while they work on it, resting when they are free, asleep with
 *               their head on their arms when they are away; a thumbs-up when an answer comes; a wave when clicked.
 *               Dragged sideways, the desk turns.
 *   TeamStage   the whole team on their feet, waving now and then — the invitation's welcome.
 *
 * Loaded on its own (three.js and react-three-fiber are big): the portal shows faces until it is here, and keeps them if
 * the browser cannot draw in 3D.
 */
import { Canvas, useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { Appearance } from '@orchestrator/contracts';
import { Character, DESK_TOP, Model, desk, deskPlant, lampDome, mug, notebook, taskChair, type PoseName } from '@orchestrator/office-3d/parts';

export type StageMood = 'working' | 'reading' | 'thinking' | 'available' | 'away' | 'paused';
export interface StageReaction {
  pose: 'wave' | 'thumbsUp' | 'cheer' | 'bow' | 'clap';
  at: number;
}

const REACT_S: Record<StageReaction['pose'], number> = { wave: 2.6, thumbsUp: 2.2, cheer: 2.8, bow: 2.3, clap: 2.8 };
const LAMP: Record<StageMood, string> = { working: '#ffd166', reading: '#ffd166', thinking: '#ffd166', available: '#3ddc84', away: '#4b5568', paused: '#ffb020' };
const POSE: Record<StageMood, PoseName> = { working: 'typing', reading: 'reading', thinking: 'thinking', available: 'idle', away: 'offline', paused: 'idle' };

/** Can this browser draw in 3D at all? (Asked once.) */
let webgl: boolean | null = null;
export function canDraw3d(): boolean {
  if (webgl !== null) return webgl;
  try {
    const c = document.createElement('canvas');
    webgl = !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    webgl = false;
  }
  return webgl;
}

/** The screen on the desk: lines of code scrolling while they work, a dim glow when not. */
function useScreen(mood: StageMood) {
  const { tex, ctx, canvas } = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 384;
    canvas.height = 230;
    const ctx = canvas.getContext('2d')!;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return { tex, ctx, canvas };
  }, []);
  useEffect(() => () => tex.dispose(), [tex]);
  const lines = useMemo(() => Array.from({ length: 40 }, (_, i) => ({ indent: [0, 1, 1, 2, 2, 1, 0, 1][i % 8]!, len: 0.25 + ((i * 37) % 60) / 100, hue: ['#8b5cf6', '#22d3c5', '#ffd166', '#6ea8ff', '#c9d2e3'][(i * 7) % 5]! })), []);
  const t0 = useRef(0);
  useFrame((_s, dt) => {
    const busy = mood === 'working' || mood === 'reading' || mood === 'thinking';
    t0.current += dt * (busy ? (mood === 'working' ? 3.2 : 1.1) : 0);
    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = mood === 'away' ? '#05070b' : '#0b1020';
    ctx.fillRect(0, 0, w, h);
    if (mood === 'away') {
      tex.needsUpdate = true;
      return;
    }
    const top = Math.floor(t0.current);
    const off = (t0.current % 1) * 16;
    for (let i = 0; i < 16; i++) {
      const l = lines[(top + i) % lines.length]!;
      ctx.fillStyle = l.hue;
      ctx.globalAlpha = busy ? 0.85 : 0.35;
      ctx.fillRect(16 + l.indent * 20, 14 + i * 16 - off, (w - 60 - l.indent * 20) * l.len, 7);
    }
    ctx.globalAlpha = 1;
    tex.needsUpdate = true;
  });
  return tex;
}

const SCREEN_GEO = new THREE.PlaneGeometry(0.6, 0.36);
const lampMats = new Map<string, THREE.MeshStandardMaterial>();
const lampMat = (color: string) => {
  let m = lampMats.get(color);
  if (!m) lampMats.set(color, (m = new THREE.MeshStandardMaterial({ color, emissive: new THREE.Color(color), emissiveIntensity: 1.4, roughness: 0.35, toneMapped: false })));
  return m;
};
const FLOOR = new THREE.MeshStandardMaterial({ color: '#141a28', roughness: 0.92 });
const FLOOR_GEO = new THREE.CircleGeometry(2.4, 64);
const RING_GEO = new THREE.RingGeometry(2.36, 2.42, 96);
const RING = new THREE.MeshBasicMaterial({ color: '#ffd166', transparent: true, opacity: 0.18, toneMapped: false });

/** Turns the scene with the pointer (drag), and back to rest slowly; sways a little by itself. */
function useTurn(wrap: React.RefObject<HTMLDivElement | null>) {
  const turn = useRef({ yaw: 0, target: 0, dragging: false, x: 0, moved: 0 });
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const down = (e: PointerEvent) => {
      turn.current.dragging = true;
      turn.current.x = e.clientX;
      turn.current.moved = 0;
      el.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!turn.current.dragging) return;
      const dx = e.clientX - turn.current.x;
      turn.current.x = e.clientX;
      turn.current.moved += Math.abs(dx);
      turn.current.target = Math.max(-1.3, Math.min(1.3, turn.current.target + dx * 0.008));
    };
    const up = () => {
      turn.current.dragging = false;
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
  }, [wrap]);
  return turn;
}

function Desk({ look, mood, reaction, turn }: { look: Appearance; mood: StageMood; reaction: StageReaction | null; turn: ReturnType<typeof useTurn> }) {
  const group = useRef<THREE.Group>(null);
  const screen = useScreen(mood);
  const [react, setReact] = useState<StageReaction | null>(null);
  // A reaction is played once, then they go back to what they were doing.
  useEffect(() => {
    if (!reaction) return;
    setReact(reaction);
    const t = window.setTimeout(() => setReact(null), REACT_S[reaction.pose] * 1000);
    return () => window.clearTimeout(t);
  }, [reaction]);
  useFrame((s, dt) => {
    const t = turn.current;
    if (!t.dragging) t.target *= Math.pow(0.35, dt);
    const sway = Math.sin(s.clock.elapsedTime * 0.25) * 0.08;
    t.yaw += (t.target + sway - t.yaw) * Math.min(1, dt * 6);
    if (group.current) group.current.rotation.y = t.yaw;
  });
  const pose: PoseName = react ? react.pose : POSE[mood];
  return (
    <group ref={group}>
      <mesh geometry={FLOOR_GEO} material={FLOOR} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, -0.3]} receiveShadow />
      <mesh geometry={RING_GEO} material={RING} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.002, -0.3]} />
      {/* (They sit facing the viewer across the desk, as in the office seen from its front.) */}
      <group position={[0, 0, 0.1]}>
        <Model model={desk()} />
        <Model model={taskChair()} position={[0, 0, -0.78]} />
        <mesh geometry={SCREEN_GEO} position={[-0.08, DESK_TOP - 0.0225 + 0.38, 0.2]} rotation={[0, Math.PI, 0]}>
          <meshBasicMaterial map={screen} toneMapped={false} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} />
        </mesh>
        <mesh position={[1.7 / 2 - 0.14, DESK_TOP, 0.3]} geometry={lampDome()} material={lampMat(LAMP[mood])} />
        <Model model={mug('#c96f4a')} position={[0.47, DESK_TOP, 0.1]} rotation={[0, 1.2, 0]} shadows={false} />
        <Model model={notebook('#35604a')} position={[-0.56, DESK_TOP, -0.12]} rotation={[0, 0.2, 0]} shadows={false} />
        <Model model={deskPlant()} position={[-0.68, DESK_TOP, 0.26]} scale={1.25} shadows={false} />
        <group position={[0, 0, -0.78]}>
          <Character appearance={look} pose={pose} cue={react?.at} phase={0.6} />
        </group>
      </group>
    </group>
  );
}

function Lights() {
  return (
    <>
      <hemisphereLight args={['#b9c6ff', '#1a1208', 0.55]} />
      <spotLight position={[1.4, 4.4, 2.2]} angle={0.7} penumbra={0.7} intensity={38} color="#ffe3b0" castShadow shadow-mapSize={[1024, 1024]} shadow-bias={-0.0004} />
      <pointLight position={[-2.2, 1.6, -1.6]} intensity={6} color="#8b5cf6" />
      <pointLight position={[2.4, 1.2, -1.8]} intensity={4} color="#22d3c5" />
    </>
  );
}

/** One employee at their desk. `mood` follows what they are doing; `reaction` plays a gesture once (a new `at`). */
export function AgentStage({ look, mood, reaction, onPoke, label }: { look: Appearance; mood: StageMood; reaction: StageReaction | null; onPoke?: () => void; label?: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const turn = useTurn(wrap);
  return (
    <div
      ref={wrap}
      className="rp-stage-canvas"
      role="img"
      aria-label={label}
      onClick={() => {
        // A click (not the end of a drag) is a hello.
        if (turn.current.moved < 6) onPoke?.();
      }}
    >
      <Canvas shadows dpr={[1, 1.75]} gl={{ antialias: true, alpha: true }} camera={{ position: [2.35, 2.1, 3.75], fov: 33, near: 0.1, far: 40 }} onCreated={({ gl, camera }) => {
        gl.setClearColor(0x000000, 0);
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.15;
        camera.lookAt(0.2, 0.72, -0.3);
      }}>
        <Lights />
        <Desk look={look} mood={mood} reaction={reaction} turn={turn} />
      </Canvas>
    </div>
  );
}

const WAVES: Array<StageReaction['pose']> = ['wave', 'bow', 'thumbsUp', 'wave', 'cheer'];

function Member({ look, x, i, n }: { look: Appearance; x: number; i: number; n: number }) {
  const [now, setNow] = useState<{ pose: PoseName; cue: number }>({ pose: 'stand', cue: 0 });
  const last = useRef(-1);
  useFrame((s) => {
    // Each waves in turn, one after another, every few seconds.
    const t = s.clock.elapsedTime - i * 1.1;
    const every = Math.max(4.5, n * 1.6);
    const k = Math.floor(t / every);
    const p = WAVES[(k + i) % WAVES.length]!;
    const on = t > 0 && t - k * every < REACT_S[p];
    const key = on ? k : -1;
    if (key === last.current) return;
    last.current = key;
    setNow(on ? { pose: p, cue: k } : { pose: 'stand', cue: k });
  });
  return (
    <group position={[x, 0, 0]} rotation={[0, -x * 0.12, 0]}>
      <Character appearance={look} pose={now.pose} cue={now.cue} phase={i * 1.3} />
    </group>
  );
}

/** The whole team on their feet, waving in turn: the invitation's welcome. */
export function TeamStage({ looks }: { looks: Appearance[] }) {
  const n = Math.max(1, Math.min(looks.length, 6));
  const gap = 0.9;
  const width = (n - 1) * gap;
  return (
    <div className="rp-team-canvas" aria-hidden>
      <Canvas shadows dpr={[1, 1.75]} gl={{ antialias: true, alpha: true }} camera={{ position: [0, 1.5, 3.6 + width * 0.55], fov: 32 }} onCreated={({ gl, camera }) => {
        gl.setClearColor(0x000000, 0);
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.15;
        camera.lookAt(0, 0.95, 0);
      }}>
        <Lights />
        <mesh geometry={FLOOR_GEO} material={FLOOR} rotation={[-Math.PI / 2, 0, 0]} scale={1 + width * 0.25} receiveShadow />
        {looks.slice(0, n).map((look, i) => (
          <Member key={i} look={look} x={i * gap - width / 2} i={i} n={n} />
        ))}
      </Canvas>
    </div>
  );
}
