import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { OfficeLayout } from '@orchestrator/contracts';
import { Documents, type DocsView } from './Documents.tsx';
import { HiFi } from './HiFi.tsx';
import { Humans, type HumanView } from './Humans.tsx';
import { PodLabels } from './PodLabels.tsx';
import { SeatMarkers } from './Seats.tsx';
import { TV, type TvFrames, type TvView } from './TV.tsx';
import { Building, Desks, Lights, Near, Rooms, Zones, sceneProbe } from './Environment.tsx';
import { People } from './People.tsx';
import { Rig, type Keymap } from './Rig.tsx';
import type { BoardView, CameraMode, CeoView, HostView, NearbyTarget, PersonView, Quality, RadioView, ScreenSubscribe, WalkRequest, WallView, WhiteboardView, ZoneView } from './types.ts';
import { buildWorld } from './world.ts';

export interface OfficeSceneProps {
  layout: OfficeLayout;
  /** Office upgrades unlocked by company milestones. */
  unlocked: string[];
  people: PersonView[];
  /** Employees whose folders really contain documents: a stack of folders appears on their desk. */
  docs: DocsView[];
  onOpenDocs: (employeeId: string) => void;
  /** The other people who are in the office right now (not the person at this computer). */
  humans: HumanView[];
  /** Ease the camera in when the owner stands at a desk (an owner setting, off by default). */
  approachZoom?: boolean;
  /** The TV: whether it is on and what it reports; its picture arrives through `tvFrames`. */
  tv: TvView;
  tvFrames: TvFrames;
  onOpenTv: () => void;
  /** Set while the owner is moving someone: the desks that are free, shown as rings a click can pick. */
  freeSeats: string[] | null;
  onPickSeat: (deskId: string) => void;
  /** The hi-fi's real state, and what a click on it does. */
  radio: RadioView;
  onOpenRadio: () => void;
  /** The owner's whip, a visual gag with no effect on anyone's work: who was last whipped and when (ms), and when the owner last swung. */
  whips: Record<string, number>;
  whipAt: number;
  walks: WalkRequest[];
  hosts: HostView[];
  board: BoardView;
  wall: WallView;
  ceo: CeoView;
  /** What the meeting-room whiteboard says (the running meeting or the last decision), and what a click on it opens. */
  whiteboard: WhiteboardView;
  onOpenMeeting: (meetingId: string | null) => void;
  /** Desk pods that belong to one project, and what a click on a zone's sign opens. */
  zones: ZoneView[];
  onOpenProject: (projectId: string) => void;
  cameraMode: CameraMode;
  quality: Quality;
  keymap: Keymap;
  selectedId: string | null;
  workstationId: string | null;
  focus: { employeeId: string; n: number } | null;
  subscribeScreen: ScreenSubscribe;
  onNearby: (n: NearbyTarget | null) => void;
  onSelect: (id: string | null) => void;
  onContext: (id: string, x: number, y: number) => void;
  onLeaveWorkstation: () => void;
}

/** Soft image-based lighting generated in code, so nothing is fetched at runtime. */
function Reflections() {
  const { gl, scene } = useThree();
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    scene.environmentIntensity = 0.32;
    return () => {
      scene.environment = null;
      env.dispose();
      pmrem.dispose();
    };
  }, [gl, scene]);
  return null;
}

/**
 * The 3D office. A pure view: everything it shows comes in through props that
 * the application derives from real orchestration state, and everything the
 * owner does here goes back out through callbacks.
 */
export function OfficeScene(props: OfficeSceneProps) {
  const unlocked = useMemo(() => new Set(props.unlocked), [props.unlocked.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const world = useMemo(() => buildWorld(props.layout, unlocked), [props.layout, unlocked]);
  const player = useMemo(() => new THREE.Vector3(world.spawn.x, 0, world.spawn.z), []); // eslint-disable-line react-hooks/exhaustive-deps
  const positions = useRef(new Map<string, THREE.Vector3>()).current;
  const cutaway = props.cameraMode === 'ceo' || props.cameraMode === 'management' || props.cameraMode === 'command' || props.cameraMode === 'free';

  const seats = useMemo(() => {
    const byDesk = new Map(props.people.filter((p) => p.deskId).map((p) => [p.deskId!, p]));
    return world.layout.desks.map((desk) => {
      const p = byDesk.get(desk.id);
      const special = p && p.workstation === 'specialized' ? { name: p.name, title: p.title, level: p.level, accent: p.roleColor ?? p.projectColor ?? '#8aa0c0', taskKey: p.taskKey, progress: p.progress, label: p.label } : null;
      return { desk, sessionId: p?.sessionId ?? null, live: !!p?.live, color: p?.projectColor ?? null, attention: p?.attention ?? null, occupied: !!p, special };
    });
  }, [props.people, world.layout.desks]);

  // Cameras that show the whole floor at once: every room's interior is mounted for them.
  const overview = props.cameraMode === 'command' || props.cameraMode === 'management';
  const breakArea = useMemo(() => {
    const r = world.room('break');
    return r ? { minX: r.x, maxX: r.x + r.w, minZ: r.z, maxZ: r.z + r.d } : null;
  }, [world]);

  // Interiors far from the owner are left out only on the Low setting (see `useNear`).
  useEffect(() => {
    sceneProbe().lazy = props.quality === 'low';
  }, [props.quality]);
  const dpr: [number, number] = props.quality === 'low' ? [1, 1] : props.quality === 'medium' ? [1, 1.5] : [1, 2];

  return (
    <Canvas
      shadows={props.quality !== 'low'}
      dpr={dpr}
      camera={{ fov: 50, near: 0.1, far: 260, position: [world.spawn.x + 2, 9, world.spawn.z + 10] }}
      gl={{ antialias: props.quality !== 'low', powerPreference: 'high-performance', preserveDrawingBuffer: false }}
      onCreated={({ gl, scene }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.05;
        gl.shadowMap.type = THREE.PCFSoftShadowMap;
        scene.background = new THREE.Color('#0d1118');
        scene.fog = new THREE.Fog('#0d1118', 70, 170);
      }}
      onPointerMissed={(e) => {
        if (e.button === 0) props.onSelect(null);
      }}
    >
      <Reflections />
      <PerfProbe />
      <Lights quality={props.quality} world={world} />
      <Building world={world} cutaway={cutaway} quality={props.quality} />
      <Desks world={world} seats={seats} subscribe={props.subscribeScreen} />
      <Zones world={world} zones={props.zones} onOpen={props.onOpenProject} />
      <Documents world={world} docs={props.docs} onOpen={props.onOpenDocs} />
      <TV world={world} tv={props.tv} frames={props.tvFrames} onOpen={props.onOpenTv} />
      <Humans humans={props.humans} />
      <PodLabels world={world} />
      {props.freeSeats && <SeatMarkers desks={world.layout.desks.filter((d) => props.freeSeats!.includes(d.id))} onPick={props.onPickSeat} />}
      {/* The hi-fi belongs to the break room's interior: mounted while someone is near that room. */}
      <Near id="hifi" area={breakArea} player={player} overview={overview}>
        <HiFi world={world} radio={props.radio} onOpen={props.onOpenRadio} />
      </Near>
      <Rooms world={world} board={props.board} wall={props.wall} ceo={props.ceo} hosts={props.hosts} subscribe={props.subscribeScreen} unlocked={unlocked} whiteboard={props.whiteboard} onOpenMeeting={props.onOpenMeeting} player={player} overview={overview} />
      <SceneProbe zones={props.zones} />
      <People people={props.people} whips={props.whips} world={world} walks={props.walks} player={player} selectedId={props.selectedId} cutaway={cutaway} hideLabels={props.cameraMode === 'workstation'} onSelect={props.onSelect} onContext={props.onContext} positions={positions} />
      <Rig whipAt={props.whipAt} approachZoom={props.approachZoom} world={world} mode={props.cameraMode} people={props.people} workstationId={props.workstationId} focus={props.focus} keymap={props.keymap} player={player} onNearby={props.onNearby} onLeaveWorkstation={props.onLeaveWorkstation} />
    </Canvas>
  );
}

/**
 * For the UI tests, next to `window.__orchPerf`: `window.__orchScene` says which room interiors
 * are mounted, what the whiteboard and the zone signs show, and where a point of the world is on
 * screen (so a test can click a thing in the office the way a person would).
 */
function SceneProbe({ zones }: { zones: ZoneView[] }) {
  const { camera, size, gl, scene } = useThree();
  useEffect(() => {
    const probe = sceneProbe();
    // The renderer and the scene themselves, for tests that measure what is drawn (e.g. the flicker check).
    (probe as any).three = { gl, scene, camera, THREE };
    probe.zones = zones.map((z) => ({ id: z.id, projectId: z.projectId, name: z.name, inProgress: z.inProgress, blocked: z.blocked, done: z.done }));
    probe.project = (x: number, y: number, z: number) => {
      const v = new THREE.Vector3(x, y, z).project(camera);
      return { x: Math.round(((v.x + 1) / 2) * size.width), y: Math.round(((1 - v.y) / 2) * size.height), visible: v.z > -1 && v.z < 1 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1 };
    };
  }, [zones, camera, size, gl, scene]);
  return null;
}

/**
 * Measures the frame rate the scene really achieves: frames per second over the last two
 * seconds and the slowest single frame in that window, published as `window.__orchPerf`
 * (shown in Settings, and checked by the UI test).
 */
function PerfProbe() {
  const acc = useRef({ start: 0, frames: 0, worst: 0 });
  useFrame(({ gl }, dt) => {
    const now = performance.now();
    const a = acc.current;
    if (!a.start) a.start = now;
    a.frames++;
    a.worst = Math.max(a.worst, dt * 1000);
    if (now - a.start >= 2000) {
      // Draw calls and triangles of the last frame (shadow pass included): what the lazily mounted rooms save.
      (window as any).__orchPerf = { fps: Math.round((a.frames * 10000) / (now - a.start)) / 10, worstFrameMs: Math.round(a.worst * 10) / 10, calls: gl.info.render.calls, triangles: gl.info.render.triangles, geometries: gl.info.memory.geometries, textures: gl.info.memory.textures, at: Date.now() };
      a.start = now;
      a.frames = 0;
      a.worst = 0;
    }
  });
  return null;
}
