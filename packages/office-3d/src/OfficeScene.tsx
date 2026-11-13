import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { memo, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Desk, OfficeLayout, Surroundings as SurroundingsKind } from '@orchestrator/contracts';
import type { EffectiveLayout } from './member-rooms.ts';
import { Documents as DocumentsPart, type DocsView } from './Documents.tsx';
import { HiFi as HiFiPart } from './HiFi.tsx';
import { Vault as VaultPart } from './Vault.tsx';
import { hifiPosition } from './hifi-sound.ts';
import { Humans as HumansPart, type HumanView } from './Humans.tsx';
import { SelfBubble } from './SelfBubble.tsx';
import { TalkMarks, type TalkMark } from './TalkMarks.tsx';
import { Foreman } from './Foreman.tsx';
import { PodLabels as PodLabelsPart } from './PodLabels.tsx';
import { SeatMarkers } from './Seats.tsx';
import { TV as TVPart, type TvFrames, type TvView } from './TV.tsx';
import { Building as BuildingPart, Desks as DesksPart, Lights as LightsPart, Near, Rooms as RoomsPart, Zones as ZonesPart, sceneProbe } from './Environment.tsx';
import { People as PeoplePart } from './People.tsx';
import { Rig as RigPart, type Keymap } from './Rig.tsx';
import type { AwardView, UsageClockView, BoardView, CameraMode, CeoView, HostView, NearbyTarget, PersonView, Quality, RadioView, ScreenSubscribe, WalkRequest, WallView, WhiteboardView, ZoneView, ForemanView } from './types.ts';
import { buildWorld } from './world.ts';
import { STUDIO, Surroundings as SurroundingsPart } from './surroundings/index.tsx';
import { usePacedLoop } from './pace.ts';

// Each part of the office is gone through by React again only when what it shows has changed. The office's state
// changes many times a second while people work (and something always does); without this every such change
// walked the whole scene, and the frame it landed in took two or three times as long — felt as a stutter when moving.
const Documents = memo(DocumentsPart);
const HiFi = memo(HiFiPart);
const Vault = memo(VaultPart);
const Humans = memo(HumansPart);
const PodLabels = memo(PodLabelsPart);
const TV = memo(TVPart);
const Building = memo(BuildingPart);
const Desks = memo(DesksPart);
const Lights = memo(LightsPart);
const Rooms = memo(RoomsPart);
const Zones = memo(ZonesPart);
const People = memo(PeoplePart);
const Rig = memo(RigPart);
const Surroundings = memo(SurroundingsPart);

export interface OfficeSceneProps {
  /** The stored layout, or that layout with the rooms of connected members added (see `withMemberRooms`). */
  layout: OfficeLayout;
  /** Where the office stands (an owner's choice, the same for everybody in it). Not given: by itself, in the dark. */
  surroundings?: SurroundingsKind;
  /** Office upgrades unlocked by company milestones. */
  unlocked: string[];
  people: PersonView[];
  /** Employees whose folders really contain documents: a stack of folders appears on their desk. */
  docs: DocsView[];
  onOpenDocs: (employeeId: string) => void;
  /** The other people who are in the office right now (not the person at this computer). */
  humans: HumanView[];
  /** The employees this person is waiting to hear from, or whose answer is waiting: marks over their heads. */
  talkMarks?: TalkMark[];
  onOpenTalk?: (employeeId: string) => void;
  /** The office's foreman, if it has one: it has no desk and walks the floor. */
  foreman?: ForemanView | null;
  /** Members' team leads: each walks between the desks of its own team. */
  leads?: ForemanView[];
  /** What the person at this computer has just said out loud: a bubble over their own character for a few seconds. */
  selfSaying?: string | null;
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
  /** What a click on the vault in the server room does (walking up to it and pressing the interact key goes through `onNearby`). */
  onOpenVault?: () => void;
  /** What a click on an arcade cabinet does (walking up to it goes through `onNearby`, as for the vault). */
  onOpenArcade?: () => void;
  /** The owner's whip, a visual gag with no effect on anyone's work: who was last whipped and when (ms), and when the owner last swung. */
  whips: Record<string, number>;
  whipAt: number;
  /** When another person's whip lands on this window's own character (ms): it flinches. */
  ouchAt?: number;
  /** The gesture this person last asked their character to make (the wheel), and when. */
  emote?: { name: string; at: number } | null;
  /** Sit down on a seat (`id`) or get up (`id: null`), each time `n` changes; and jump, each time `jumpAsk` changes. */
  seatAsk?: { id: string | null; n: number } | null;
  jumpAsk?: number;
  onSeated?: (seatId: string | null) => void;
  onJumped?: () => void;
  walks: WalkRequest[];
  hosts: HostView[];
  board: BoardView;
  wall: WallView;
  ceo: CeoView;
  /** Usage clocks for members' rooms: by member computer (host id), that member's Claude accounts. */
  memberClocks?: Record<string, UsageClockView[]>;
  /** What the meeting-room whiteboard says (the running meeting or the last decision), and what a click on it opens. */
  whiteboard: WhiteboardView;
  /** The employee of the month (the board of that name shows them), and what a click on the board does. */
  award?: AwardView | null;
  onOpenAward?: (employeeId: string) => void;
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
export const OfficeScene = memo(function OfficeScene(props: OfficeSceneProps) {
  const unlocked = useMemo(() => new Set(props.unlocked), [props.unlocked.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  // The stored office and, when members are connected, the same office with their rooms attached. The first is
  // kept while members come and go: what is drawn from it stays as it is when a room appears or disappears.
  const stored = (props.layout as Partial<EffectiveLayout>).base ?? props.layout;
  const core = useMemo(() => buildWorld(stored, unlocked), [stored, unlocked]);
  const world = useMemo(() => (stored === props.layout ? core : buildWorld(props.layout, unlocked, core)), [core, props.layout, unlocked, stored]);
  // Where the hi-fi stands, for whoever works out how loud it is at a distance (the application's player).
  hifiPosition.at = world.hifi ? { x: world.hifi.x, z: world.hifi.z } : null;
  const player = useMemo(() => new THREE.Vector3(world.spawn.x, 0, world.spawn.z), []); // eslint-disable-line react-hooks/exhaustive-deps
  const positions = useRef(new Map<string, THREE.Vector3>()).current;
  // Those who walk the floor and have no desk to be met at.
  const walkersKey = [props.foreman, ...(props.leads ?? [])].map((w) => (w ? `${w.id}:${w.name}` : '')).join('|');
  const walkers = useMemo(() => [props.foreman, ...(props.leads ?? [])].filter((w): w is NonNullable<typeof w> => !!w).map((w) => ({ id: w.id, name: w.name })), [walkersKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // Where everyone stands or sits right now, for tests and captures that look at one person.
  sceneProbe().positions = positions;
  const cutaway = props.cameraMode === 'ceo' || props.cameraMode === 'management' || props.cameraMode === 'command' || props.cameraMode === 'free';

  const seatsAt = (desks: Desk[]) => {
    const byDesk = new Map(props.people.filter((p) => p.deskId).map((p) => [p.deskId!, p]));
    return desks.map((desk) => {
      const p = byDesk.get(desk.id);
      const special = p && p.workstation === 'specialized' ? { name: p.name, title: p.title, level: p.level, accent: p.roleColor ?? p.projectColor ?? '#8aa0c0', taskKey: p.taskKey, progress: p.progress, label: p.label } : null;
      return { desk, sessionId: p?.sessionId ?? null, live: !!p?.live, color: p?.projectColor ?? null, attention: p?.attention ?? null, occupied: !!p, special };
    });
  };
  const seats = useMemo(() => seatsAt(core.layout.desks), [props.people, core.layout.desks]); // eslint-disable-line react-hooks/exhaustive-deps
  const memberSeats = useMemo(() => seatsAt(world.memberDesks), [props.people, world.memberDesks]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const surroundings = props.surroundings ?? 'studio';
  const dpr: [number, number] = props.quality === 'low' ? [1, 1] : props.quality === 'medium' ? [1, 1.5] : [1, 2];
  usePacedLoop();

  return (
    <Canvas
      frameloop="never"
      shadows={props.quality !== 'low'}
      dpr={dpr}
      camera={{ fov: 50, near: 0.1, far: 260, position: [world.spawn.x + 2, 9, world.spawn.z + 10] }}
      gl={{ antialias: props.quality !== 'low', powerPreference: 'high-performance', preserveDrawingBuffer: false }}
      onCreated={({ gl, scene }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.05;
        gl.shadowMap.type = THREE.PCFSoftShadowMap;
        // The background and the air are the place's (see `Surroundings`), set before this runs: only what was not set is.
        scene.background ??= new THREE.Color(STUDIO.background);
        scene.fog ??= new THREE.Fog(...STUDIO.fog);
      }}
      onPointerMissed={(e) => {
        if (e.button === 0) props.onSelect(null);
      }}
    >
      <Reflections />
      <PerfProbe />
      <Surroundings kind={surroundings} world={world} quality={props.quality} />
      <Lights quality={props.quality} world={world} surroundings={surroundings} />
      <Building world={world} cutaway={cutaway} quality={props.quality} memberClocks={props.memberClocks} surroundings={surroundings} />
      <Desks desks={core.layout.desks} seats={seats} subscribe={props.subscribeScreen} />
      {world.memberDesks.length > 0 && <Desks desks={world.memberDesks} seats={memberSeats} subscribe={props.subscribeScreen} />}
      <Zones world={world} zones={props.zones} onOpen={props.onOpenProject} />
      <Documents world={world} docs={props.docs} onOpen={props.onOpenDocs} />
      <TV world={world} tv={props.tv} frames={props.tvFrames} onOpen={props.onOpenTv} />
      <Vault world={world} onOpen={props.onOpenVault} />
      <Humans humans={props.humans} />
      <SelfBubble player={player} text={props.cameraMode === 'first' || props.cameraMode === 'workstation' ? null : (props.selfSaying ?? null)} />
      <PodLabels world={world} />
      {props.freeSeats && <SeatMarkers desks={world.layout.desks.filter((d) => props.freeSeats!.includes(d.id))} onPick={props.onPickSeat} />}
      {/* The hi-fi belongs to the break room's interior: mounted while someone is near that room. */}
      <Near id="hifi" area={breakArea} player={player} overview={overview}>
        <HiFi world={world} radio={props.radio} onOpen={props.onOpenRadio} />
      </Near>
      <Rooms world={world} board={props.board} wall={props.wall} ceo={props.ceo} hosts={props.hosts} subscribe={props.subscribeScreen} unlocked={unlocked} whiteboard={props.whiteboard} onOpenMeeting={props.onOpenMeeting} onOpenArcade={props.onOpenArcade} award={props.award ?? null} onOpenAward={props.onOpenAward} player={player} overview={overview} />
      <SceneProbe zones={props.zones} surroundings={surroundings} />
      {props.talkMarks && props.talkMarks.length > 0 && props.cameraMode !== 'workstation' && <TalkMarks marks={props.talkMarks} positions={positions} onOpen={props.onOpenTalk ?? (() => undefined)} />}
      <People people={props.people} whips={props.whips} world={world} walks={props.walks} player={player} selectedId={props.selectedId} cutaway={cutaway} hideLabels={props.cameraMode === 'workstation'} onSelect={props.onSelect} onContext={props.onContext} positions={positions} />
      {props.foreman && <Foreman foreman={props.foreman} people={props.people} world={world} selected={props.selectedId === props.foreman.id} cutaway={cutaway} hideLabels={props.cameraMode === 'workstation'} onSelect={props.onSelect} onContext={props.onContext} positions={positions} />}
      {(props.leads ?? []).map((lead) => (
        <Foreman key={lead.id} foreman={lead} people={props.people} world={world} selected={props.selectedId === lead.id} cutaway={cutaway} hideLabels={props.cameraMode === 'workstation'} onSelect={props.onSelect} onContext={props.onContext} positions={positions} />
      ))}
      <Rig positions={positions} walkers={walkers} whipAt={props.whipAt} ouchAt={props.ouchAt} emote={props.emote} approachZoom={props.approachZoom} seatAsk={props.seatAsk} jumpAsk={props.jumpAsk} onSeated={props.onSeated} onJumped={props.onJumped} world={world} mode={props.cameraMode} people={props.people} workstationId={props.workstationId} focus={props.focus} keymap={props.keymap} player={player} onNearby={props.onNearby} onLeaveWorkstation={props.onLeaveWorkstation} />
    </Canvas>
  );
});

/**
 * For the UI tests, next to `window.__orchPerf`: `window.__orchScene` says which room interiors
 * are mounted, what the whiteboard and the zone signs show, and where a point of the world is on
 * screen (so a test can click a thing in the office the way a person would).
 */
function SceneProbe({ zones, surroundings }: { zones: ZoneView[]; surroundings: SurroundingsKind }) {
  const { camera, size, gl, scene } = useThree();
  useEffect(() => {
    const probe = sceneProbe();
    // The renderer and the scene themselves, for tests that measure what is drawn (e.g. the flicker check).
    (probe as any).three = { gl, scene, camera, THREE };
    // Where the office stands, and how far the camera sees there.
    probe.surroundings = { kind: surroundings, far: (camera as THREE.PerspectiveCamera).far, fog: scene.fog ? `#${(scene.fog as THREE.Fog).color.getHexString()}` : null };
    probe.zones = zones.map((z) => ({ id: z.id, projectId: z.projectId, name: z.name, inProgress: z.inProgress, blocked: z.blocked, done: z.done }));
    probe.project = (x: number, y: number, z: number) => {
      const v = new THREE.Vector3(x, y, z).project(camera);
      return { x: Math.round(((v.x + 1) / 2) * size.width), y: Math.round(((1 - v.y) / 2) * size.height), visible: v.z > -1 && v.z < 1 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1 };
    };
  }, [zones, surroundings, camera, size, gl, scene]);
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
