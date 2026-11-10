import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { Desk, RoomDef, TerminalScreen } from '@orchestrator/contracts';
import { drawScreen } from './terminal-texture.ts';
import type { BoardView, CeoView, HostView, Quality, ScreenSubscribe, UsageClockView, WallView, WhiteboardView, ZoneView } from './types.ts';
import { DESK_SIZE, WALL_T, deskBox, deskSeat, type Box, type World } from './world.ts';
import { memberRoomTitle, type MemberRoom } from './member-rooms.ts';
import { ON_SURFACE } from './surface.ts';

/** What the scene reports about itself for the UI tests (like `window.__orchPerf`): which room interiors are mounted, what the whiteboard says. */
export function sceneProbe(): Record<string, any> {
  return ((window as any).__orchScene ??= { detail: {} });
}

// ───────────────────────────── lazy interiors ─────────────────────────────

const NEAR = 24;
const FAR = 30;

/**
 * Is the camera (or the owner's avatar) close enough to an area for its detailed interior to
 * be worth mounting? True within NEAR metres, false again only after being beyond FAR for a
 * moment — so walking along the threshold never makes furniture flicker. Overview cameras
 * (and a free camera flown high) see the whole floor, so everything is mounted for them.
 *
 * This saving is only made on the Low graphics setting (`sceneProbe().lazy`). On Medium and High
 * every interior stays mounted: things appearing and disappearing while walking reads as flicker,
 * and on a capable machine it buys nothing (the frame rate was the same either way). Overview cameras
 * (and a free camera flown high) see the whole floor, so everything is mounted for them.
 */
export function useNear(id: string, area: Box | null, player: THREE.Vector3, overview: boolean): boolean {
  const { camera } = useThree();
  const dist = () => {
    if (!area) return Infinity;
    const d = (x: number, z: number) => Math.hypot(Math.max(area.minX - x, 0, x - area.maxX), Math.max(area.minZ - z, 0, z - area.maxZ));
    return Math.min(d(camera.position.x, camera.position.z), d(player.x, player.z));
  };
  const [on, setOn] = useState(() => !!area && (sceneProbe().lazy !== true || overview || dist() < NEAR));
  const st = useRef({ on, tick: 0, farFor: 0 });
  useFrame((_s, dt) => {
    const r = st.current;
    r.farFor += dt;
    if (r.tick++ % 12 !== 0 || !area) return;
    const d = dist();
    // `forceAll` is a measuring aid: it mounts everything, to compare against the lazy state in the same view.
    const all = sceneProbe().lazy !== true || overview || camera.position.y > 16 || sceneProbe().forceAll === true;
    if (all || d < FAR) r.farFor = 0;
    const want = r.on ? r.farFor < 1.5 : all || d < NEAR;
    if (want !== r.on) {
      r.on = want;
      setOn(want);
    }
  });
  useEffect(() => {
    sceneProbe().detail[id] = on;
    return () => {
      delete sceneProbe().detail[id];
    };
  }, [id, on]);
  return on;
}

function roomBox(r: RoomDef | undefined): Box | null {
  return r ? { minX: r.x, maxX: r.x + r.w, minZ: r.z, maxZ: r.z + r.d } : null;
}

/** Children are mounted only while the camera or the owner is near the area. */
export function Near({ id, area, player, overview, children }: { id: string; area: Box | null; player: THREE.Vector3; overview: boolean; children: ReactNode }) {
  return useNear(id, area, player, overview) ? <>{children}</> : null;
}

// ───────────────────────────── helpers ─────────────────────────────

function noiseTexture(base: string, variance: number, repeat: number, grid = 0): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size);
  let seed = 1337;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() - 0.5) * variance;
    img.data[i] = Math.max(0, Math.min(255, img.data[i]! + n));
    img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1]! + n));
    img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2]! + n));
  }
  ctx.putImageData(img, 0, 0);
  if (grid) {
    ctx.strokeStyle = 'rgba(0,0,0,0.16)';
    ctx.lineWidth = 2;
    for (let i = 0; i <= grid; i++) {
      const p = (i / grid) * size;
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, size);
      ctx.moveTo(0, p);
      ctx.lineTo(size, p);
      ctx.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

const FLOOR: Record<RoomDef['kind'], { color: string; variance: number; rough: number; grid?: number; scale: number }> = {
  open: { color: '#5d6f8a', variance: 22, rough: 0.95, scale: 0.9 },
  hall: { color: '#b9c0cb', variance: 10, rough: 0.55, grid: 2, scale: 0.5 },
  ceo: { color: '#8b6a48', variance: 26, rough: 0.6, scale: 0.6 },
  meeting: { color: '#4d7c7b', variance: 20, rough: 0.95, scale: 0.9 },
  ops: { color: '#2b3344', variance: 12, rough: 0.5, grid: 2, scale: 0.6 },
  server: { color: '#262d3a', variance: 10, rough: 0.45, grid: 2, scale: 0.8 },
  break: { color: '#d8c6a6', variance: 14, rough: 0.6, grid: 3, scale: 0.5 },
  reception: { color: '#cdd1d8', variance: 10, rough: 0.4, grid: 1, scale: 0.4 },
  team: { color: '#7a6a8e', variance: 20, rough: 0.95, scale: 0.9 },
};

/** Many copies of one mesh in a single draw call. */
function Instanced({ geometry, material, matrices, castShadow = true, receiveShadow = false }: { geometry: THREE.BufferGeometry; material: THREE.Material; matrices: THREE.Matrix4[]; castShadow?: boolean; receiveShadow?: boolean }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [matrices]);
  if (!matrices.length) return null;
  return <instancedMesh ref={ref} args={[geometry, material, matrices.length]} castShadow={castShadow} receiveShadow={receiveShadow} frustumCulled />;
}

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3(1, 1, 1);
const Y = new THREE.Vector3(0, 1, 0);

/** World matrix for a part placed relative to an object at (x,z) rotated by `rot` around Y. */
function place(x: number, z: number, rot: number, lx: number, ly: number, lz: number, localRotY = 0, scale?: [number, number, number]): THREE.Matrix4 {
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  tmpQ.setFromAxisAngle(Y, rot + localRotY);
  tmpS.set(scale?.[0] ?? 1, scale?.[1] ?? 1, scale?.[2] ?? 1);
  return new THREE.Matrix4().compose(new THREE.Vector3(x + lx * cos + lz * sin, ly, z - lx * sin + lz * cos), tmpQ, tmpS);
}

/** A flat panel whose picture is drawn with the 2D canvas API (boards, signs, dashboards). */
function useCanvasTexture(width: number, height: number, px: number, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, deps: unknown[]): THREE.CanvasTexture {
  const tex = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = px;
    canvas.height = Math.round((px * height) / width);
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  }, [px, width, height]);
  useEffect(() => {
    const canvas = tex.image as HTMLCanvasElement;
    draw(canvas.getContext('2d')!, canvas.width, canvas.height);
    tex.needsUpdate = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tex, ...deps]);
  useEffect(() => () => tex.dispose(), [tex]);
  return tex;
}

function CanvasPanel({ width, height, px = 1024, draw, deps, emissive = true, ...props }: { width: number; height: number; px?: number; draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void; deps: unknown[]; emissive?: boolean } & Record<string, any>) {
  const tex = useCanvasTexture(width, height, px, draw, deps);
  return (
    <mesh {...props}>
      <planeGeometry args={[width, height]} />
      {emissive ? <meshBasicMaterial map={tex} toneMapped={false} {...ON_SURFACE} /> : <meshStandardMaterial map={tex} roughness={0.9} {...ON_SURFACE} />}
    </mesh>
  );
}

// ───────────────────────────── building ─────────────────────────────

export function Building({ world, cutaway, quality, memberClocks }: { world: World; cutaway: boolean; quality: Quality; memberClocks?: Record<string, UsageClockView[]> }) {
  // The building itself is drawn from the stored office; the rooms of connected members are added to it below.
  // `base` stays the same object while members come and go, so nothing of the building is made again then.
  const base = world.base;
  const floors = useMemo(
    () =>
      base.rooms.map((r) => {
        const f = FLOOR[r.kind];
        const tex = noiseTexture(f.color, f.variance, 1, f.grid ?? 0);
        tex.repeat.set(r.w * f.scale, r.d * f.scale);
        return { room: r, material: new THREE.MeshStandardMaterial({ map: tex, roughness: f.rough, metalness: 0 }) };
      }),
    [base.rooms],
  );
  const wallMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#e7eaf0', roughness: 0.92 }), []);
  const outerMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#d5dae3', roughness: 0.9 }), []);
  const glassMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#a9d8ff', roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.3, depthWrite: false }), []);
  const frameMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#2c3442', roughness: 0.4, metalness: 0.6 }), []);
  const capMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#39424f', roughness: 0.7 }), []);
  const group = useRef<THREE.Group>(null);
  const ceiling = useRef<THREE.Group>(null);
  const ceilingMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#eef1f5', roughness: 0.95, transparent: true, opacity: cutaway ? 0 : 1 }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const panels = useMemo(() => {
    const out: Array<[number, number]> = [];
    for (let x = base.bounds.minX + 3; x < base.bounds.maxX; x += 5.5) for (let z = base.bounds.minZ + 3; z < base.bounds.maxZ; z += 5) out.push([x, z]);
    return out;
  }, [base]);
  // The light panels are painted into the ceiling itself (as its glow) rather than hung under it as separate
  // slivers: seen far down the room they are thinner than a pixel, and a texture is filtered where geometry sparkles.
  useEffect(() => {
    const W = base.layout.width;
    const D = base.layout.depth;
    const k = Math.min(40, 4096 / Math.max(W, D));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(W * k);
    canvas.height = Math.round(D * k);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#fff7e8';
    for (const [x, z] of panels) ctx.fillRect((x + W / 2 - 0.75) * k, (D / 2 - z - 0.25) * k, 1.5 * k, 0.5 * k);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 16;
    ceilingMat.emissive = new THREE.Color('#ffffff');
    ceilingMat.emissiveIntensity = 2.4;
    ceilingMat.emissiveMap = tex;
    ceilingMat.needsUpdate = true;
    return () => {
      ceilingMat.emissiveMap = null;
      ceilingMat.needsUpdate = true;
      tex.dispose();
    };
  }, [base, panels, ceilingMat]);
  const height = useRef(cutaway ? 1.1 : 3);
  const slabMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#8d95a3', roughness: 0.8 }), []);

  // Member rooms: a floor of the member's colour and a ceiling with its own light panels, made when the room appears.
  const annexKey = world.memberRooms.map((r) => `${r.roomId}:${r.x}:${r.z}:${r.w}:${r.d}:${r.color}:${r.lights.length}:${r.locked ? 'L' : ''}`).join('|');
  const annex = useMemo(
    () =>
      world.memberRooms.map((r) => {
        // Away: the room keeps a trace of its colour under grey, and its lights are off.
        const carpet = r.locked ? new THREE.Color(r.color).lerp(new THREE.Color('#43474e'), 0.94) : new THREE.Color(r.color).lerp(new THREE.Color('#566072'), 0.62);
        const tex = noiseTexture(`#${carpet.getHexString()}`, 20, 1);
        tex.repeat.set(r.w * 0.9, r.d * 0.9);
        const floor = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0 });
        // The light panels are painted into the ceiling's glow, as in the building (see above).
        const k = 40;
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(r.w * k);
        canvas.height = Math.round(r.d * k);
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#fff7e8';
        for (const [x, z] of r.lights) ctx.fillRect((x - r.x - 0.75) * k, (r.z + r.d - z - 0.25) * k, 1.5 * k, 0.5 * k);
        const glow = new THREE.CanvasTexture(canvas);
        glow.colorSpace = THREE.SRGBColorSpace;
        glow.anisotropy = 16;
        const ceil = new THREE.MeshStandardMaterial({ color: '#eef1f5', roughness: 0.95, transparent: true, opacity: ceilingMat.opacity, emissive: '#ffffff', emissiveIntensity: 2.4, emissiveMap: glow });
        const accent = new THREE.MeshStandardMaterial({ color: r.locked ? '#5b616b' : r.color, roughness: 0.6, ...ON_SURFACE });
        return { room: r, floor, ceil, accent, textures: [tex, glow] };
      }),
    [annexKey], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useEffect(
    () => () => {
      for (const a of annex) {
        a.floor.dispose();
        a.ceil.dispose();
        a.accent.dispose();
        for (const t of a.textures) t.dispose();
      }
    },
    [annex],
  );
  const annexRef = useRef(annex);
  annexRef.current = annex;
  // For the UI tests: which member rooms stand, and where.
  useEffect(() => {
    sceneProbe().memberClocks = Object.fromEntries(Object.entries(memberClocks ?? {}).map(([hostId, list]) => [hostId, list.map((c) => ({ name: c.name, week: c.week, five: c.five }))]));
    sceneProbe().memberRooms = world.memberRooms.map((r) => ({ hostId: r.hostId, memberName: r.memberName, desks: r.desks, side: r.side, x: r.x, z: r.z, w: r.w, d: r.d, door: { x: r.door.x, z: r.door.z } }));
  }, [world.memberRooms, memberClocks]);

  // Walls drop to a cut-away height for overhead cameras and rise for first-person views.
  useFrame((_s, dt) => {
    const target = cutaway ? 1.1 : 3;
    // The ceiling only exists for eye-level cameras; it fades in as the walls rise.
    const want = cutaway ? 0 : 1;
    if (Math.abs(ceilingMat.opacity - want) > 0.01) {
      ceilingMat.opacity += (want - ceilingMat.opacity) * (1 - Math.exp(-dt * 5));
      if (ceiling.current) ceiling.current.visible = ceilingMat.opacity > 0.02;
      for (const a of annexRef.current) a.ceil.opacity = ceilingMat.opacity;
    }
    if (Math.abs(height.current - target) < 0.002 || !group.current) return;
    height.current += (target - height.current) * (1 - Math.exp(-dt * 6));
    group.current.scale.y = height.current / 3;
  });

  return (
    <group>
      {/* ground outside the building */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.2, 0]} receiveShadow>
        <planeGeometry args={[220, 220]} />
        <meshStandardMaterial color="#12161e" roughness={1} />
      </mesh>
      {/* The slab's top is centimetres under the room floors, not millimetres: two surfaces that close flicker from across the office. */}
      <mesh position={[0, -0.09, 0]} receiveShadow material={slabMat}>
        <boxGeometry args={[base.layout.width + 0.6, 0.1, base.layout.depth + 0.6]} />
      </mesh>
      {floors.map(({ room, material }) => (
        <mesh key={room.id} rotation={[-Math.PI / 2, 0, 0]} position={[room.x + room.w / 2, 0.005, room.z + room.d / 2]} receiveShadow material={material}>
          <planeGeometry args={[room.w, room.d]} />
        </mesh>
      ))}
      <group ref={ceiling} visible={!cutaway}>
        {/* The underside sits just below the wall tops (and their caps), so the walls run cleanly into the ceiling:
            a ceiling resting exactly on them leaves a hairline along every wall that sparkles as the camera moves. */}
        <mesh position={[0, 2.97, 0]} rotation={[Math.PI / 2, 0, 0]} material={ceilingMat}>
          <planeGeometry args={[base.layout.width, base.layout.depth]} />
        </mesh>
        {annex.map(({ room: r, ceil }) => (
          <mesh key={r.roomId} position={[r.x + r.w / 2, 2.97, r.z + r.d / 2]} rotation={[Math.PI / 2, 0, 0]} material={ceil}>
            <planeGeometry args={[r.w, r.d]} />
          </mesh>
        ))}
      </group>
      {annex.map(({ room: r, floor, accent }) => {
        const alongZ = r.side !== 'n';
        return (
          <group key={r.roomId}>
            {/* The same slab as the building's, of the same material: where the two overlap they look the same whichever is drawn. */}
            <mesh position={[r.x + r.w / 2, -0.09, r.z + r.d / 2]} receiveShadow material={slabMat}>
              <boxGeometry args={[r.w + 0.6, 0.1, r.d + 0.6]} />
            </mesh>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[r.x + r.w / 2, 0.005, r.z + r.d / 2]} receiveShadow material={floor}>
              <planeGeometry args={[r.w, r.d]} />
            </mesh>
            {/* The threshold, in the member's colour. */}
            <mesh rotation={[-Math.PI / 2, 0, alongZ ? Math.PI / 2 : 0]} position={[r.door.x, 0.016, r.door.z]} material={accent}>
              <planeGeometry args={[r.door.width - 0.2, 0.3]} />
            </mesh>
            <MemberSigns room={r} />
            <MemberClocks room={r} clocks={memberClocks?.[r.hostId]} />
          </group>
        );
      })}
      <group ref={group} scale={[1, height.current / 3, 1]}>
        {/* A locked room's door: closed, on the whole wall, with a bar across it. */}
        {world.memberRooms.filter((r) => r.locked).map((r) => {
          const alongZ = r.side !== 'n';
          const into = r.side === 'e' ? -1 : 1;
          const px = r.door.x + (alongZ ? into * (WALL_T / 2 + 0.02) : 0);
          const pz = r.door.z + (alongZ ? 0 : WALL_T / 2 + 0.02);
          return (
            <group key={`${r.roomId}:shut`} position={[px, 0, pz]}>
              <mesh position={[0, 1.1, 0]} material={frameMat}>
                <boxGeometry args={alongZ ? [0.05, 2.2, r.door.width - 0.2] : [r.door.width - 0.2, 2.2, 0.05]} />
              </mesh>
              <mesh position={[alongZ ? into * 0.04 : 0, 1.05, alongZ ? 0 : 0.04]}>
                <boxGeometry args={alongZ ? [0.04, 0.12, r.door.width - 0.5] : [r.door.width - 0.5, 0.12, 0.04]} />
                <meshStandardMaterial color="#8a8f98" roughness={0.4} metalness={0.7} />
              </mesh>
            </group>
          );
        })}
        {/* The frame of each member room's door: it stands a few centimetres proud of the wall it is cut through. */}
        {world.memberRooms.map((r) =>
          [-1, 1].map((e) => {
            const off = e * (r.door.width / 2 - 0.05);
            const alongZ = r.side !== 'n';
            return (
              <mesh key={`${r.roomId}:${e}`} position={[r.door.x + (alongZ ? 0 : off), 1.5, r.door.z + (alongZ ? off : 0)]} material={frameMat} castShadow={quality !== 'low'}>
                <boxGeometry args={alongZ ? [WALL_T + 0.06, 3, 0.1] : [0.1, 3, WALL_T + 0.06]} />
              </mesh>
            );
          }),
        )}
        {world.walls.map((w) => {
          // Keyed by where the wall stands: when a member room cuts a door into one wall, the others are left as they are.
          const i = `${w.x1}:${w.z1}:${w.x2}:${w.z2}:${w.glass ? 'g' : 's'}`;
          const len = Math.hypot(w.x2 - w.x1, w.z2 - w.z1);
          const horizontal = Math.abs(w.z2 - w.z1) < 1e-6;
          const cx = (w.x1 + w.x2) / 2;
          const cz = (w.z1 + w.z2) / 2;
          const size: [number, number, number] = horizontal ? [len + (w.glass ? 0 : WALL_T), 3, WALL_T] : [WALL_T, 3, len + (w.glass ? 0 : WALL_T)];
          if (w.glass) {
            const rail: [number, number, number] = horizontal ? [len, 0.07, WALL_T * 0.9] : [WALL_T * 0.9, 0.07, len];
            return (
              <group key={i} position={[cx, 0, cz]}>
                {/* The pane stands between its two rails: no face of it lies inside a rail or under the floor,
                    where it would fight with them for the same depth and shimmer. */}
                <mesh position={[0, 1.5, 0]} material={glassMat}>
                  <boxGeometry args={[size[0] * (horizontal ? 1 : 0.35), 2.86, size[2] * (horizontal ? 0.35 : 1)]} />
                </mesh>
                <mesh position={[0, 0.035, 0]} material={frameMat}>
                  <boxGeometry args={rail} />
                </mesh>
                <mesh position={[0, 2.965, 0]} material={frameMat}>
                  <boxGeometry args={rail} />
                </mesh>
              </group>
            );
          }
          return (
            <group key={i} position={[cx, 0, cz]}>
              <mesh position={[0, 1.5, 0]} material={w.outer ? outerMat : wallMat} castShadow={quality !== 'low'} receiveShadow>
                <boxGeometry args={size} />
              </mesh>
              <mesh position={[0, 3.0, 0]} material={capMat}>
                <boxGeometry args={[size[0] + 0.02, 0.05, size[2] + 0.02]} />
              </mesh>
            </group>
          );
        })}
      </group>
    </group>
  );
}

/** A member room's name: on a plaque by its door (or over it), and painted on its floor for the cameras that look down. */
/**
 * The member's own Claude accounts as wall clocks, in their room: on the side wall just inside the door, one after
 * another going into the room. (The office's shared accounts hang in the CEO room.)
 */
function MemberClocks({ room, clocks }: { room: MemberRoom; clocks?: UsageClockView[] }) {
  if (!clocks?.length) return null;
  // As many as the wall has room for between the door end and the back of the room.
  const along = room.side === 'n' ? room.d : room.w;
  const shown = clocks.slice(0, Math.max(1, Math.min(3, Math.floor((along - 1.6) / 1.5))));
  return (
    <>
      {shown.map((c, n) => {
        const step = 1.3 + n * 1.5;
        // West and east rooms: the wall at the room's north side, facing into the room (the way a clock faces by itself).
        // North rooms: the wall at the room's west side, turned a quarter to face east into the room.
        const at: [number, number, number] = room.side === 'w' ? [room.x + room.w - step, 2.0, room.z + 0.1] : room.side === 'e' ? [room.x + step, 2.0, room.z + 0.1] : [room.x + 0.1, 2.0, room.z + room.d - step];
        return (
          <group key={c.key} position={at} rotation={[0, room.side === 'n' ? Math.PI / 2 : 0, 0]}>
            <UsageClock position={[0, 0, 0]} account={c} />
          </group>
        );
      })}
    </>
  );
}

function MemberSigns({ room }: { room: MemberRoom }) {
  const title = room.title;
  // Away: the signs lose their colour with the room.
  const tint = room.locked ? '#8a9099' : room.color;
  const seated = room.employees - room.unseated;
  const sub = room.locked ? 'Away · locked' : !room.employees ? 'No employees yet' : room.unseated ? `${seated} of ${room.employees} employees here` : `${room.employees} employee${room.employees === 1 ? '' : 's'}`;
  const PW = 1.2;
  const PH = 0.5;
  const label = useCanvasTexture(
    room.label.w,
    room.label.h,
    1024,
    (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      (ctx as any).letterSpacing = `${Math.round(h * 0.05)}px`;
      // A long name is painted smaller before it is cut short.
      let size = h * 0.56;
      ctx.font = font(size, 800);
      while (size > h * 0.3 && ctx.measureText(title).width > w * 0.94) ctx.font = font((size *= 0.94), 800);
      ctx.fillStyle = 'rgba(255,255,255,0.86)';
      const text = clip(ctx, title, w * 0.96);
      ctx.fillText(text, w / 2, h * 0.44);
      const tw = Math.min(w * 0.96, ctx.measureText(text).width);
      ctx.fillStyle = tint;
      ctx.fillRect(w / 2 - tw / 2, h * 0.82, tw, h * 0.07);
      (ctx as any).letterSpacing = '0px';
      ctx.textAlign = 'left';
    },
    [title, tint],
  );
  return (
    <>
      <group position={[room.plaque.x, room.plaque.above ? 2.42 : 1.5, room.plaque.z]} rotation={[0, room.plaque.rot, 0]}>
        <mesh position={[0, 0, 0.02]} castShadow>
          <boxGeometry args={[PW + 0.08, PH + 0.08, 0.04]} />
          <meshStandardMaterial color="#1c212b" roughness={0.45} metalness={0.3} />
        </mesh>
        <CanvasPanel
          width={PW}
          height={PH}
          px={768}
          position={[0, 0, 0.0415]}
          deps={[title, sub, tint]}
          draw={(ctx, w, h) => {
            ctx.fillStyle = '#10151e';
            ctx.fillRect(0, 0, w, h);
            ctx.fillStyle = tint;
            ctx.fillRect(0, 0, w * 0.03, h);
            ctx.textBaseline = 'middle';
            ctx.fillStyle = '#ffffff';
            // A long name is written smaller before it is cut short.
            let size = h * 0.3;
            ctx.font = font(size, 800);
            while (size > h * 0.17 && ctx.measureText(title).width > w * 0.86) ctx.font = font((size *= 0.94), 800);
            ctx.fillText(clip(ctx, title, w * 0.88), w * 0.08, h * 0.36);
            ctx.fillStyle = tint;
            ctx.font = font(h * 0.17, 600);
            ctx.fillText(clip(ctx, sub, w * 0.88), w * 0.08, h * 0.72);
          }}
        />
      </group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[room.label.x, 0.016, room.label.z]}>
        <planeGeometry args={[room.label.w, room.label.h]} />
        <meshBasicMaterial map={label} transparent depthWrite={false} toneMapped={false} {...ON_SURFACE} />
      </mesh>
    </>
  );
}

export function Lights({ quality, world }: { quality: Quality; world: World }) {
  const sun = useRef<THREE.DirectionalLight>(null);
  useLayoutEffect(() => {
    const l = sun.current;
    if (!l) return;
    const cam = l.shadow.camera as THREE.OrthographicCamera;
    // Wide enough for the member rooms that stand outside the building, when there are any.
    const hw = Math.max(-world.bounds.minX, world.bounds.maxX) + 4;
    const hd = Math.max(-world.bounds.minZ, world.bounds.maxZ) + 4;
    cam.left = -hw;
    cam.right = hw;
    cam.top = hd;
    cam.bottom = -hd;
    cam.near = 1;
    cam.far = 90;
    cam.updateProjectionMatrix();
    l.shadow.bias = -0.0004;
    l.shadow.normalBias = 0.03;
  }, [world.bounds.minX, world.bounds.maxX, world.bounds.minZ, world.bounds.maxZ]);
  const size = quality === 'high' ? 4096 : 2048;
  return (
    <>
      <hemisphereLight args={['#eaf1ff', '#4a4f5c', 0.85]} />
      <directionalLight ref={sun} position={[16, 30, 18]} intensity={2.1} color="#fff4e2" castShadow={quality !== 'low'} shadow-mapSize={[size, size]} />
      <directionalLight position={[-20, 16, -14]} intensity={0.55} color="#bcd4ff" />
    </>
  );
}

// ───────────────────────────── monitors ─────────────────────────────

const SCREEN_W = 0.6;
const SCREEN_H = 0.36;

/** Within this distance of the camera a monitor switches to its sharp tier; it switches back a little further out. */
const CLOSE_IN = 6;
const CLOSE_OUT = 7.5;

/**
 * A monitor showing the employee's real terminal. Frames arrive from the
 * server at a low rate; how finely and how often a screen is drawn depends on
 * how near the camera is, so an office full of screens stays cheap:
 *
 *   close (walking up to a desk)  texture twice as fine, every frame that arrives
 *   near                          readable text, every frame / once a second
 *   far                           coloured bars, every few seconds
 */
export function MonitorScreen({ sessionId, subscribe, live, position, rotation, width = SCREEN_W, height = SCREEN_H, px = 512 }: { sessionId: string | null; subscribe: ScreenSubscribe; live: boolean; position: [number, number, number]; rotation: [number, number, number]; width?: number; height?: number; px?: number }) {
  const mesh = useRef<THREE.Mesh>(null);
  const { camera } = useThree();
  const [close, setClose] = useState(false);
  const res = close ? Math.min(2048, px * 2) : px;
  const state = useRef<{ frame: TerminalScreen | null; dirty: boolean; drawnAt: number; dist: number; tick: number; close: boolean; far: boolean }>({ frame: null, dirty: true, drawnAt: 0, dist: 99, tick: 0, close: false, far: false });
  const tex = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = res;
    canvas.height = Math.round((res * height) / width);
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = res > px ? 16 : 4;
    return t;
  }, [res, px, width, height]);
  const paint = () => {
    const st = state.current;
    const canvas = tex.image as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    if (!live || !sessionId) {
      ctx.fillStyle = '#05070b';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    } else {
      drawScreen(ctx, canvas.width, canvas.height, st.frame, { lod: st.far ? 'far' : 'near' });
    }
    tex.needsUpdate = true;
  };
  // A new texture (the tier changed) is painted before it is first shown, so the screen never blinks.
  useLayoutEffect(() => {
    paint();
    return () => tex.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tex]);
  useEffect(() => {
    state.current.frame = null;
    state.current.dirty = true;
    if (!sessionId) return;
    return subscribe(sessionId, (s) => {
      state.current.frame = s;
      state.current.dirty = true;
    });
  }, [sessionId, subscribe]);
  useEffect(() => {
    state.current.dirty = true;
  }, [live]);
  const wp = useMemo(() => new THREE.Vector3(), []);
  useEffect(() => {
    if (!close) return;
    const probe = sceneProbe();
    probe.closeScreens = (probe.closeScreens ?? 0) + 1;
    return () => {
      probe.closeScreens -= 1;
    };
  }, [close]);

  useFrame((s) => {
    const st = state.current;
    if (!mesh.current) return;
    if (st.tick++ % 6 === 0) {
      mesh.current.getWorldPosition(wp);
      st.dist = wp.distanceTo(camera.position);
      const wantClose = st.dist < (st.close ? CLOSE_OUT : CLOSE_IN);
      if (wantClose !== st.close) {
        st.close = wantClose;
        setClose(wantClose);
      }
      const far = st.dist > (st.far ? 15 : 17);
      if (far !== st.far) {
        st.far = far;
        st.dirty = true;
      }
    }
    if (!st.dirty) return;
    const now = s.clock.elapsedTime;
    // Close: every frame that arrives. Mid: about once a second. Far: every few seconds, as coloured bars.
    const interval = st.dist < CLOSE_OUT ? 0 : st.dist < 18 ? 1 : 3;
    if (now - st.drawnAt < interval) return;
    st.dirty = false;
    st.drawnAt = now;
    paint();
  });

  return (
    <mesh ref={mesh} position={position} rotation={rotation} userData={{ tier: close ? 'close' : 'near' }}>
      <planeGeometry args={[width, height]} />
      <meshBasicMaterial map={tex} toneMapped={false} {...ON_SURFACE} />
    </mesh>
  );
}

// ───────────────────────────── desks ─────────────────────────────

const GEO = {
  top: new RoundedBoxGeometry(DESK_SIZE.w, 0.045, DESK_SIZE.d, 2, 0.02),
  side: new THREE.BoxGeometry(0.04, 0.7, DESK_SIZE.d - 0.12),
  drawer: new RoundedBoxGeometry(0.42, 0.52, 0.6, 2, 0.02),
  bezel: new RoundedBoxGeometry(SCREEN_W + 0.04, SCREEN_H + 0.04, 0.035, 2, 0.012),
  stand: new THREE.BoxGeometry(0.06, 0.2, 0.04),
  foot: new RoundedBoxGeometry(0.26, 0.015, 0.18, 2, 0.006),
  keyboard: new RoundedBoxGeometry(0.42, 0.018, 0.14, 2, 0.006),
  mouse: new RoundedBoxGeometry(0.06, 0.025, 0.1, 2, 0.01),
  seat: new RoundedBoxGeometry(0.5, 0.08, 0.48, 3, 0.03),
  back: new RoundedBoxGeometry(0.46, 0.55, 0.07, 3, 0.03),
  post: new THREE.CylinderGeometry(0.03, 0.03, 0.34, 8),
  base: new THREE.CylinderGeometry(0.3, 0.3, 0.035, 5),
  divider: new THREE.BoxGeometry(DESK_SIZE.w * 2 + 0.2, 0.42, 0.04),
};

export interface DeskSeatInfo {
  desk: Desk;
  sessionId: string | null;
  live: boolean;
  color: string | null;
  attention: 'question' | 'approval' | 'blocked' | 'done' | null;
  occupied: boolean;
  /** Set for an employee whose level earned a specialized workstation: what its side monitor and plate say. */
  special: { name: string; title: string; level: number; accent: string; taskKey: string | null; progress: number | null; label: string } | null;
}

// One set of materials for every desk there is: the office's own and those in member rooms.
let DESK_MATS: Record<'top' | 'frame' | 'dark' | 'chair' | 'chrome' | 'divider', THREE.MeshStandardMaterial> | null = null;
function deskMats() {
  return (DESK_MATS ??= {
    top: new THREE.MeshStandardMaterial({ color: '#efe6d6', roughness: 0.55 }),
    frame: new THREE.MeshStandardMaterial({ color: '#f4f6f9', roughness: 0.5, metalness: 0.2 }),
    dark: new THREE.MeshStandardMaterial({ color: '#1c212b', roughness: 0.45, metalness: 0.3 }),
    chair: new THREE.MeshStandardMaterial({ color: '#2f3846', roughness: 0.85 }),
    chrome: new THREE.MeshStandardMaterial({ color: '#aeb6c2', roughness: 0.25, metalness: 0.9 }),
    divider: new THREE.MeshStandardMaterial({ color: '#7d8aa0', roughness: 0.95 }),
  });
}

/**
 * A set of desks with their chairs and monitors. The scene draws two: the office's own desks, and those in the
 * rooms of connected members — so a member arriving or leaving does not touch the office's desks.
 */
export function Desks({ desks, seats, subscribe }: { desks: Desk[]; seats: DeskSeatInfo[]; subscribe: ScreenSubscribe }) {
  const mats = deskMats();
  const m = useMemo(() => {
    const out = { top: [] as THREE.Matrix4[], side: [] as THREE.Matrix4[], drawer: [] as THREE.Matrix4[], bezel: [] as THREE.Matrix4[], stand: [] as THREE.Matrix4[], foot: [] as THREE.Matrix4[], keyboard: [] as THREE.Matrix4[], mouse: [] as THREE.Matrix4[], seat: [] as THREE.Matrix4[], back: [] as THREE.Matrix4[], post: [] as THREE.Matrix4[], base: [] as THREE.Matrix4[], divider: [] as THREE.Matrix4[] };
    for (const d of desks) {
      const { x, z, rot } = d;
      out.top.push(place(x, z, rot, 0, DESK_SIZE.h, 0));
      out.side.push(place(x, z, rot, -DESK_SIZE.w / 2 + 0.04, 0.36, 0), place(x, z, rot, DESK_SIZE.w / 2 - 0.04, 0.36, 0));
      out.drawer.push(place(x, z, rot, DESK_SIZE.w / 2 - 0.3, 0.3, 0.02));
      // The monitor stands at the far edge of the desk and faces the seat (local -Z).
      out.foot.push(place(x, z, rot, -0.08, DESK_SIZE.h + 0.03, 0.22));
      out.stand.push(place(x, z, rot, -0.08, DESK_SIZE.h + 0.13, 0.24));
      out.bezel.push(place(x, z, rot, -0.08, DESK_SIZE.h + 0.38, 0.22));
      out.keyboard.push(place(x, z, rot, -0.08, DESK_SIZE.h + 0.034, -0.16));
      out.mouse.push(place(x, z, rot, 0.28, DESK_SIZE.h + 0.036, -0.15));
      const seat = deskSeat(d);
      out.seat.push(place(seat.x, seat.z, rot, 0, 0.47, 0));
      out.back.push(place(seat.x, seat.z, rot, 0, 0.82, -0.25));
      out.post.push(place(seat.x, seat.z, rot, 0, 0.26, 0));
      out.base.push(place(seat.x, seat.z, rot, 0, 0.05, 0));
    }
    // A low privacy divider down the middle of each pod (between desks that face each other).
    const seen = new Set<string>();
    for (const d of desks) {
      // Desks turned a quarter (member rooms on the east and west walls) face each other along X instead of Z.
      const turned = Math.abs(Math.sin(d.rot)) > 0.7;
      const across = (o: Desk) => (turned ? o.x - d.x : o.z - d.z);
      const along = (o: Desk) => (turned ? o.z - d.z : o.x - d.x);
      const mate = desks.find((o) => o !== d && Math.abs(along(o)) < 0.01 && Math.abs(Math.abs(across(o)) - 1) < 0.06);
      if (!mate) continue;
      const row = desks.filter((o) => Math.abs(across(o)) < 0.01 && Math.abs(along(o)) < 2.2);
      const mid = row.reduce((a, o) => a + (turned ? o.z : o.x), 0) / row.length;
      const cx = turned ? (d.x + mate.x) / 2 : mid;
      const cz = turned ? mid : (d.z + mate.z) / 2;
      const key = `${cx.toFixed(1)}:${cz.toFixed(1)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.divider.push(turned ? place(cx, cz, Math.PI / 2, 0, DESK_SIZE.h + 0.23, 0) : new THREE.Matrix4().makeTranslation(cx, DESK_SIZE.h + 0.23, cz));
    }
    return out;
  }, [desks]);

  return (
    <group>
      <Instanced geometry={GEO.top} material={mats.top} matrices={m.top} receiveShadow />
      <Instanced geometry={GEO.side} material={mats.frame} matrices={m.side} />
      <Instanced geometry={GEO.drawer} material={mats.frame} matrices={m.drawer} />
      <Instanced geometry={GEO.bezel} material={mats.dark} matrices={m.bezel} />
      <Instanced geometry={GEO.stand} material={mats.dark} matrices={m.stand} />
      <Instanced geometry={GEO.foot} material={mats.dark} matrices={m.foot} />
      <Instanced geometry={GEO.keyboard} material={mats.dark} matrices={m.keyboard} castShadow={false} />
      <Instanced geometry={GEO.mouse} material={mats.dark} matrices={m.mouse} castShadow={false} />
      <Instanced geometry={GEO.seat} material={mats.chair} matrices={m.seat} />
      <Instanced geometry={GEO.back} material={mats.chair} matrices={m.back} />
      <Instanced geometry={GEO.post} material={mats.chrome} matrices={m.post} castShadow={false} />
      <Instanced geometry={GEO.base} material={mats.chrome} matrices={m.base} castShadow={false} />
      <Instanced geometry={GEO.divider} material={mats.divider} matrices={m.divider} />
      {seats.map((s) => {
        const { x, z, rot } = s.desk;
        const cos = Math.cos(rot);
        const sin = Math.sin(rot);
        const lz = 0.22 - 0.02;
        const sx = x + -0.08 * cos + lz * sin;
        const sz = z - -0.08 * sin + lz * cos;
        return (
          <group key={s.desk.id}>
            {s.occupied && <MonitorScreen sessionId={s.sessionId} live={s.live} subscribe={subscribe} position={[sx, DESK_SIZE.h + 0.38, sz]} rotation={[0, rot + Math.PI, 0]} />}
            <DeskLight x={x + (DESK_SIZE.w / 2 - 0.14) * cos + 0.3 * sin} z={z - (DESK_SIZE.w / 2 - 0.14) * sin + 0.3 * cos} color={s.color} attention={s.attention} on={s.occupied} />
            {s.special && <SpecialDesk desk={s.desk} info={s.special} live={s.live} dark={mats.dark} />}
          </group>
        );
      })}
    </group>
  );
}

const SIDE_W = 0.3;
const SIDE_H = 0.46;
const SPECIAL_GEO = {
  bezel: new RoundedBoxGeometry(SIDE_W + 0.04, SIDE_H + 0.04, 0.03, 2, 0.012),
  arm: new THREE.BoxGeometry(0.035, 0.36, 0.035),
  foot: new RoundedBoxGeometry(0.2, 0.015, 0.16, 2, 0.006),
  strip: new THREE.BoxGeometry(DESK_SIZE.w - 0.12, 0.014, 0.022),
  mat: new RoundedBoxGeometry(0.86, 0.006, 0.34, 2, 0.003),
  plate: new THREE.BoxGeometry(0.3, 0.075, 0.02),
};

/**
 * A specialized workstation, earned with levels: a portrait side monitor with the employee's
 * real task and progress, a light strip in their role's colour, a desk mat and a name plate
 * with their level. Looks only — the desk gives its owner nothing a standard desk does not.
 */
function SpecialDesk({ desk, info, live, dark }: { desk: Desk; info: NonNullable<DeskSeatInfo['special']>; live: boolean; dark: THREE.Material }) {
  const strip = useMemo(() => new THREE.MeshStandardMaterial({ color: info.accent, emissive: new THREE.Color(info.accent), emissiveIntensity: 1, toneMapped: false }), [info.accent]);
  strip.emissiveIntensity = live ? 1.7 : 0.25;
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#232a36', roughness: 0.9 }), []);
  const brass = useMemo(() => new THREE.MeshStandardMaterial({ color: '#b08d3c', roughness: 0.35, metalness: 0.8 }), []);
  const top = DESK_SIZE.h + 0.0225;
  return (
    <group position={[desk.x, 0, desk.z]} rotation={[0, desk.rot, 0]}>
      {/* portrait side monitor, left of the main one and turned toward the chair */}
      <group position={[-0.62, 0, 0.2]} rotation={[0, Math.PI - 0.32, 0]}>
        <mesh geometry={SPECIAL_GEO.foot} material={dark} position={[0, top + 0.008, -0.03]} />
        <mesh geometry={SPECIAL_GEO.arm} material={dark} position={[0, top + 0.18, -0.035]} />
        <mesh geometry={SPECIAL_GEO.bezel} material={dark} position={[0, top + 0.38, -0.018]} castShadow />
        <CanvasPanel
          width={SIDE_W}
          height={SIDE_H}
          px={256}
          position={[0, top + 0.38, 0]}
          deps={[info.name, info.level, info.taskKey, info.progress, info.label, info.accent, live]}
          draw={(ctx, w, h) => {
            ctx.fillStyle = '#080b11';
            ctx.fillRect(0, 0, w, h);
            if (!live) return;
            ctx.fillStyle = info.accent;
            ctx.fillRect(0, 0, w, h * 0.03);
            ctx.textBaseline = 'middle';
            ctx.fillStyle = '#ffffff';
            ctx.font = font(h * 0.1, 800);
            ctx.fillText(clip(ctx, info.name, w * 0.88), w * 0.07, h * 0.12);
            ctx.fillStyle = info.accent;
            ctx.font = font(h * 0.065, 700);
            ctx.fillText(`LEVEL ${info.level}`, w * 0.07, h * 0.215);
            ctx.fillStyle = '#7f8aa0';
            ctx.font = font(h * 0.05, 600);
            ctx.fillText('CURRENT TASK', w * 0.07, h * 0.36);
            ctx.fillStyle = '#ffffff';
            ctx.font = font(h * 0.13, 800);
            ctx.fillText(info.taskKey ?? '—', w * 0.07, h * 0.47);
            if (info.taskKey && info.progress != null) {
              ctx.fillStyle = '#1c2533';
              ctx.fillRect(w * 0.07, h * 0.57, w * 0.86, h * 0.035);
              ctx.fillStyle = info.accent;
              ctx.fillRect(w * 0.07, h * 0.57, w * 0.86 * Math.max(0, Math.min(1, info.progress / 100)), h * 0.035);
              ctx.fillStyle = '#b9c3d3';
              ctx.font = font(h * 0.05, 600);
              ctx.fillText(`${Math.round(info.progress)}%`, w * 0.07, h * 0.65);
            }
            ctx.fillStyle = '#7f8aa0';
            ctx.font = font(h * 0.05, 600);
            ctx.fillText('NOW', w * 0.07, h * 0.8);
            ctx.fillStyle = '#d7dde8';
            ctx.font = font(h * 0.06, 700);
            ctx.fillText(clip(ctx, info.label, w * 0.88), w * 0.07, h * 0.89);
          }}
        />
      </group>
      <mesh geometry={SPECIAL_GEO.strip} material={strip} position={[0, top + 0.007, DESK_SIZE.d / 2 - 0.03]} />
      <mesh geometry={SPECIAL_GEO.mat} material={mat} position={[-0.02, top + 0.003, -0.15]} receiveShadow />
      {/* name plate on the chair-side edge, tilted up toward whoever walks up behind the chair */}
      <group position={[0.52, top + 0.04, -DESK_SIZE.d / 2 + 0.05]} rotation={[0, Math.PI, 0]}>
        <group rotation={[-0.45, 0, 0]}>
          <mesh geometry={SPECIAL_GEO.plate} material={brass} position={[0, 0, -0.011]} castShadow />
          <CanvasPanel
            width={0.28}
            height={0.06}
            px={512}
            deps={[info.level, info.title]}
            draw={(ctx, w, h) => {
              ctx.fillStyle = '#c9a54a';
              ctx.fillRect(0, 0, w, h);
              ctx.textBaseline = 'middle';
              ctx.fillStyle = '#2a2008';
              ctx.font = font(h * 0.6, 800);
              const lv = `LV ${info.level}`;
              ctx.fillText(lv, w * 0.04, h * 0.54);
              const x = w * 0.04 + ctx.measureText(lv).width + w * 0.04;
              ctx.font = font(h * 0.42, 600);
              ctx.fillText(clip(ctx, info.title, w * 0.96 - x), x, h * 0.54);
            }}
          />
        </group>
      </group>
    </group>
  );
}

// ───────────────────────────── project zones ─────────────────────────────

/**
 * A desk pod that belongs to one project: its floor is outlined and tinted in the project's
 * colour, and a sign above the pod names the project and shows its real task counts.
 * Clicking the sign opens the project.
 */
export function Zones({ world, zones, onOpen }: { world: World; zones: ZoneView[]; onOpen: (projectId: string) => void }) {
  const desks = useMemo(() => new Map(world.layout.desks.map((d) => [d.id, d])), [world.layout.desks]);
  return (
    <>
      {zones.map((z) => {
        const list = z.deskIds.map((id) => desks.get(id)).filter((d): d is Desk => !!d);
        if (!list.length) return null;
        return <Zone key={z.id} zone={z} desks={list} onOpen={onOpen} />;
      })}
    </>
  );
}

function Zone({ zone, desks, onOpen }: { zone: ZoneView; desks: Desk[]; onOpen: (projectId: string) => void }) {
  const [hover, setHover] = useState(false);
  // The pod's floor: its desks and the chairs behind them, with a little margin.
  const area = useMemo(() => {
    const b: Box = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    let cx = 0;
    let cz = 0;
    for (const d of desks) {
      const box = deskBox(d);
      const seat = deskSeat(d);
      b.minX = Math.min(b.minX, box.minX, seat.x - 0.4);
      b.maxX = Math.max(b.maxX, box.maxX, seat.x + 0.4);
      b.minZ = Math.min(b.minZ, box.minZ, seat.z - 0.4);
      b.maxZ = Math.max(b.maxZ, box.maxZ, seat.z + 0.4);
      cx += d.x / desks.length;
      cz += d.z / desks.length;
    }
    const pad = 0.3;
    return { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2, w: b.maxX - b.minX + pad * 2, d: b.maxZ - b.minZ + pad * 2, cx, cz };
  }, [desks]);
  const frame = useMemo(() => {
    const { w, d } = area;
    const t = 0.09;
    const shape = new THREE.Shape();
    shape.moveTo(-w / 2, -d / 2);
    shape.lineTo(w / 2, -d / 2);
    shape.lineTo(w / 2, d / 2);
    shape.lineTo(-w / 2, d / 2);
    shape.closePath();
    const hole = new THREE.Path();
    hole.moveTo(-w / 2 + t, -d / 2 + t);
    hole.lineTo(-w / 2 + t, d / 2 - t);
    hole.lineTo(w / 2 - t, d / 2 - t);
    hole.lineTo(w / 2 - t, -d / 2 + t);
    hole.closePath();
    shape.holes.push(hole);
    return new THREE.ShapeGeometry(shape);
  }, [area]);
  useEffect(() => () => frame.dispose(), [frame]);
  const SW = 1.7;
  const SH = 0.5;
  // Just above the monitors, level with the name tags: seen from an overhead camera the tags of the near row
  // then fall below the sign and those of the far row above it, instead of on top of it.
  const SIGN_Y = 1.38;
  const tex = useCanvasTexture(SW, SH, 768, (ctx, w, h) => {
    ctx.fillStyle = '#10151e';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = zone.color;
    ctx.fillRect(0, 0, w * 0.025, h);
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.font = font(h * 0.34, 800);
    ctx.fillText(clip(ctx, zone.name, w * 0.9), w * 0.06, h * 0.3);
    ctx.font = font(h * 0.2, 700);
    let x = w * 0.06;
    for (const [n, label, color] of [
      [zone.inProgress, 'in progress', '#f0c36a'],
      [zone.blocked, 'blocked', '#ff6b7d'],
      [zone.done, 'done', '#6fd08c'],
    ] as Array<[number, string, string]>) {
      ctx.fillStyle = n ? color : '#5b6677';
      const text = `${n} ${label}`;
      ctx.fillText(text, x, h * 0.72);
      x += ctx.measureText(text).width + w * 0.045;
    }
  }, [zone.name, zone.color, zone.inProgress, zone.blocked, zone.done]);
  // The sign faces along the desks (toward the chairs on both sides).
  const rot = desks[0]!.rot;
  useEffect(() => {
    const signs = (sceneProbe().zoneSigns ??= {});
    signs[zone.id] = { x: area.cx, y: SIGN_Y + SH / 2, z: area.cz, projectId: zone.projectId };
    return () => {
      delete signs[zone.id];
    };
  }, [zone.id, zone.projectId, area, SIGN_Y]);
  const pointer = {
    onClick: (e: { stopPropagation: () => void }) => {
      e.stopPropagation();
      onOpen(zone.projectId);
    },
    onPointerOver: (e: { stopPropagation: () => void }) => {
      e.stopPropagation();
      setHover(true);
      document.body.style.cursor = 'pointer';
    },
    onPointerOut: () => {
      setHover(false);
      document.body.style.cursor = '';
    },
  };
  return (
    <group>
      {/* The same sign once more as a plaque on the floor in front of the zone: what the overhead cameras read. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[area.x, 0.016, area.z + area.d / 2 + 0.42]} {...pointer}>
        <planeGeometry args={[SW * 1.3, SH * 1.3]} />
        <meshBasicMaterial map={tex} toneMapped={false} {...ON_SURFACE} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[area.x, 0.011, area.z]}>
        <planeGeometry args={[area.w, area.d]} />
        <meshBasicMaterial color={zone.color} transparent opacity={0.2} depthWrite={false} toneMapped={false} {...ON_SURFACE} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[area.x, 0.014, area.z]} geometry={frame}>
        <meshBasicMaterial color={zone.color} transparent opacity={0.9} depthWrite={false} toneMapped={false} {...ON_SURFACE} />
      </mesh>
      <group position={[area.cx, 0, area.cz]} rotation={[0, rot, 0]}>
        <mesh position={[0, SIGN_Y / 2, 0]}>
          <cylinderGeometry args={[0.022, 0.022, SIGN_Y, 10]} />
          <meshStandardMaterial color="#2c3442" roughness={0.4} metalness={0.6} />
        </mesh>
        <group position={[0, SIGN_Y + SH / 2, 0]} {...pointer}>
          <mesh castShadow>
            <boxGeometry args={[SW + 0.08, SH + 0.08, 0.04]} />
            <meshStandardMaterial color={hover ? '#ffffff' : zone.color} roughness={0.5} emissive={zone.color} emissiveIntensity={hover ? 0.9 : 0.35} />
          </mesh>
          <mesh position={[0, 0, 0.0215]}>
            <planeGeometry args={[SW, SH]} />
            <meshBasicMaterial map={tex} toneMapped={false} {...ON_SURFACE} />
          </mesh>
          <mesh position={[0, 0, -0.0215]} rotation={[0, Math.PI, 0]}>
            <planeGeometry args={[SW, SH]} />
            <meshBasicMaterial map={tex} toneMapped={false} {...ON_SURFACE} />
          </mesh>
        </group>
      </group>
    </group>
  );
}

const ATTENTION_COLOR = { question: '#ffb020', approval: '#ffb020', blocked: '#ff4d5e', done: '#3ddc84' } as const;

/** The status lamp on each desk: project colour normally, pulsing when the employee needs the owner. */
function DeskLight({ x, z, color, attention, on }: { x: number; z: number; color: string | null; attention: DeskSeatInfo['attention']; on: boolean }) {
  const mat = useRef<THREE.MeshStandardMaterial>(null);
  useFrame((s) => {
    if (!mat.current) return;
    mat.current.emissiveIntensity = attention ? 1.6 + Math.sin(s.clock.elapsedTime * 6) * 1.2 : on ? 1.1 : 0.05;
  });
  const c = attention ? ATTENTION_COLOR[attention] : (color ?? '#8aa0c0');
  return (
    <mesh position={[x, DESK_SIZE.h + 0.07, z]}>
      <cylinderGeometry args={[0.035, 0.045, 0.09, 12]} />
      <meshStandardMaterial ref={mat} color={on ? c : '#3a4250'} emissive={c} emissiveIntensity={on ? 1 : 0.05} toneMapped={false} />
    </mesh>
  );
}

// ───────────────────────────── rooms ─────────────────────────────

function Plant({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 0.22, 0]} castShadow>
        <cylinderGeometry args={[0.2, 0.15, 0.44, 14]} />
        <meshStandardMaterial color="#d9d3c8" roughness={0.8} />
      </mesh>
      {[
        [0, 0.78, 0, 0.36],
        [0.16, 0.62, 0.08, 0.24],
        [-0.14, 0.66, -0.1, 0.26],
        [0.02, 1.08, -0.04, 0.24],
      ].map(([px, py, pz, r], i) => (
        <mesh key={i} position={[px!, py!, pz!]} castShadow>
          <icosahedronGeometry args={[r!, 1]} />
          <meshStandardMaterial color={i % 2 ? '#3f8f5a' : '#357a4c'} roughness={0.9} flatShading />
        </mesh>
      ))}
    </group>
  );
}

function font(px: number, weight = 600): string {
  return `${weight} ${px}px "Inter", "SF Pro Display", "Segoe UI", system-ui, sans-serif`;
}

function clip(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > max) t = t.slice(0, -1);
  return t + '…';
}

const COLUMN_COLOR: Record<string, string> = { BACKLOG: '#7f8aa0', READY: '#6ea8ff', IN_PROGRESS: '#f0c36a', REVIEW: '#c792ea', DONE: '#6fd08c', BLOCKED: '#ff6b7d' };

function drawBoard(ctx: CanvasRenderingContext2D, w: number, h: number, board: BoardView) {
  ctx.fillStyle = '#f7f8fa';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#1c2330';
  ctx.font = font(h * 0.07, 700);
  ctx.textBaseline = 'middle';
  ctx.fillText(clip(ctx, board.title, w * 0.9), w * 0.02, h * 0.07);
  const top = h * 0.15;
  const colW = (w * 0.96) / Math.max(1, board.columns.length);
  board.columns.forEach((col, i) => {
    const x = w * 0.02 + i * colW;
    ctx.fillStyle = COLUMN_COLOR[col.status] ?? '#888';
    ctx.fillRect(x + 4, top, colW - 8, h * 0.012);
    ctx.fillStyle = '#4a5364';
    ctx.font = font(h * 0.042, 700);
    ctx.fillText(`${col.status.replace('_', ' ')}  ${col.items.length}`, x + 6, top + h * 0.045);
    const cardH = h * 0.105;
    const max = Math.floor((h - top - h * 0.1) / (cardH + 6));
    col.items.slice(0, max).forEach((it, j) => {
      const y = top + h * 0.08 + j * (cardH + 6);
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#d5dae3';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(x + 6, y, colW - 12, cardH, 8);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = it.color;
      ctx.fillRect(x + 6, y, 6, cardH);
      ctx.fillStyle = '#1c2330';
      ctx.font = font(h * 0.036, 700);
      ctx.fillText(clip(ctx, `${it.key}  ${it.title}`, colW - 34), x + 20, y + cardH * 0.34);
      ctx.fillStyle = '#6b7588';
      ctx.font = font(h * 0.03, 500);
      ctx.fillText(clip(ctx, it.who, colW - 34), x + 20, y + cardH * 0.72);
    });
    if (col.items.length > max) {
      ctx.fillStyle = '#8a93a5';
      ctx.font = font(h * 0.03, 600);
      ctx.fillText(`+${col.items.length - max} more`, x + 8, h - h * 0.035);
    }
  });
}

function drawLines(ctx: CanvasRenderingContext2D, w: number, h: number, title: string, lines: string[], accent = '#6ea8ff') {
  ctx.fillStyle = '#0b0f17';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, w, h * 0.02);
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.font = font(h * 0.11, 700);
  ctx.fillText(clip(ctx, title, w * 0.92), w * 0.04, h * 0.14);
  ctx.font = font(h * 0.072, 500);
  lines.slice(0, 9).forEach((l, i) => {
    ctx.fillStyle = l.startsWith('!') ? '#ff8a98' : l.startsWith('?') ? '#ffd98a' : '#b9c3d3';
    ctx.fillText(clip(ctx, l, w * 0.92), w * 0.04, h * 0.3 + i * h * 0.078);
  });
}

/** Clockwise from twelve o'clock, as a canvas angle: 0% is at the top, 25% at three, 50% at six, 75% at nine. */
const dialAngle = (percent: number) => (percent / 100) * Math.PI * 2 - Math.PI / 2;

/** The face of a usage clock: the week around the rim (the last tenth in red), and a small dial for the 5-hour window. */
function drawClockFace(ctx: CanvasRenderingContext2D, w: number, h: number, hasFive: boolean) {
  const c = w / 2;
  const R = w * 0.485;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#f3efe6';
  ctx.beginPath();
  ctx.arc(c, c, R, 0, Math.PI * 2);
  ctx.fill();
  const dial = (cx: number, cy: number, r: number, numerals: boolean) => {
    // the last tenth is where it runs out
    ctx.strokeStyle = '#d9434e';
    ctx.lineWidth = r * 0.075;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.93, dialAngle(90), dialAngle(100));
    ctx.stroke();
    for (let p = 0; p < 100; p += numerals ? 5 : 25) {
      const a = dialAngle(p);
      const major = p % 25 === 0;
      ctx.strokeStyle = '#20242c';
      ctx.lineWidth = r * (major ? 0.035 : 0.016);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r * (major ? 0.8 : 0.87), cy + Math.sin(a) * r * (major ? 0.8 : 0.87));
      ctx.lineTo(cx + Math.cos(a) * r * 0.97, cy + Math.sin(a) * r * 0.97);
      ctx.stroke();
    }
    if (!numerals) return;
    ctx.fillStyle = '#20242c';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = font(r * 0.15, 700);
    for (const p of [0, 25, 50, 75]) {
      const a = dialAngle(p);
      ctx.fillText(p === 0 ? '0' : String(p), cx + Math.cos(a) * r * 0.66, cy + Math.sin(a) * r * 0.66);
    }
  };
  dial(c, c, R, true);
  ctx.fillStyle = '#6b7280';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = font(R * 0.1, 700);
  ctx.fillText('WEEK · % USED', c, c - R * 0.36);
  if (hasFive) {
    const sy = c + R * 0.44;
    const sr = R * 0.31;
    ctx.fillStyle = '#e7e1d4';
    ctx.beginPath();
    ctx.arc(c, sy, sr, 0, Math.PI * 2);
    ctx.fill();
    dial(c, sy, sr, false);
    ctx.fillStyle = '#6b7280';
    ctx.font = font(sr * 0.3, 700);
    ctx.fillText('5 H', c, sy + sr * 0.42);
  }
  ctx.textAlign = 'left';
}

const CLOCK_R = 0.5;
const CLOCK_MAT = {
  rim: new THREE.MeshStandardMaterial({ color: '#232830', roughness: 0.35, metalness: 0.6 }),
  hand: new THREE.MeshStandardMaterial({ color: '#15181e', roughness: 0.5 }),
  five: new THREE.MeshStandardMaterial({ color: '#c2410c', roughness: 0.5 }),
  hub: new THREE.MeshStandardMaterial({ color: '#8f2738', roughness: 0.4, metalness: 0.3 }),
};

/**
 * A wall clock for one Claude account. The big hand shows how much of the week is used (straight up: nothing; all the
 * way round: everything), the small dial does the same for the 5-hour window. The hands sweep to a new reading rather
 * than jump; with nothing reported they rest at twelve and the label says so.
 */
function UsageClock({ position, account }: { position: [number, number, number]; account: UsageClockView }) {
  const big = useRef<THREE.Group>(null);
  const small = useRef<THREE.Group>(null);
  const shown = useRef({ week: 0, five: 0 });
  const hasFive = account.five !== null;
  const face = useCanvasTexture(1, 1, 768, (ctx, w, h) => drawClockFace(ctx, w, h, hasFive), [hasFive]);
  const label = [account.name, ...account.lines];
  useFrame((_s, dt) => {
    const k = 1 - Math.exp(-Math.min(dt, 0.1) * 2.2);
    const s = shown.current;
    s.week += ((account.week ?? 0) - s.week) * k;
    s.five += ((account.five ?? 0) - s.five) * k;
    if (big.current) big.current.rotation.z = -(s.week / 100) * Math.PI * 2;
    if (small.current) small.current.rotation.z = -(s.five / 100) * Math.PI * 2;
  });
  return (
    <group position={position}>
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0, 0.03]} material={CLOCK_MAT.rim}>
        <cylinderGeometry args={[CLOCK_R + 0.045, CLOCK_R + 0.045, 0.06, 48]} />
      </mesh>
      <mesh position={[0, 0, 0.066]}>
        <circleGeometry args={[CLOCK_R, 48]} />
        <meshStandardMaterial map={face} roughness={0.7} {...ON_SURFACE} />
      </mesh>
      {/* the week: the big hand */}
      <group ref={big} position={[0, 0, 0.085]}>
        <mesh position={[0, CLOCK_R * 0.36, 0]} material={CLOCK_MAT.hand}>
          <boxGeometry args={[0.028, CLOCK_R * 0.92, 0.012]} />
        </mesh>
      </group>
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0, 0.09]} material={CLOCK_MAT.hub}>
        <cylinderGeometry args={[0.035, 0.035, 0.03, 20]} />
      </mesh>
      {/* the 5-hour window: the small dial */}
      {hasFive && (
        <group position={[0, -CLOCK_R * 0.44 * 0.97, 0.085]}>
          <group ref={small}>
            <mesh position={[0, CLOCK_R * 0.115, 0]} material={CLOCK_MAT.five}>
              <boxGeometry args={[0.02, CLOCK_R * 0.27, 0.01]} />
            </mesh>
          </group>
          <mesh rotation={[Math.PI / 2, 0, 0]} material={CLOCK_MAT.five}>
            <cylinderGeometry args={[0.018, 0.018, 0.02, 14]} />
          </mesh>
        </group>
      )}
      <CanvasPanel
        width={1.3}
        height={0.42}
        px={640}
        position={[0, -CLOCK_R - 0.34, 0.03]}
        deps={[label.join('|')]}
        draw={(ctx, w, h) => {
          ctx.fillStyle = '#0b0f17';
          ctx.fillRect(0, 0, w, h);
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          label.slice(0, 3).forEach((line, i) => {
            ctx.fillStyle = i === 0 ? '#ffffff' : /\b[0-9]% left|\b1[0-4]% left/.test(line) ? '#ff8a98' : '#b9c3d3';
            ctx.font = font(h * (i === 0 ? 0.24 : 0.2), i === 0 ? 700 : 500);
            ctx.fillText(clip(ctx, line, w * 0.94), w / 2, h * (0.2 + i * 0.3));
          });
          ctx.textAlign = 'left';
        }}
      />
    </group>
  );
}

function Chair({ x, z, rot, color = '#39424f' }: { x: number; z: number; rot: number; color?: string }) {
  return (
    <group position={[x, 0, z]} rotation={[0, rot, 0]}>
      <mesh position={[0, 0.46, 0]} geometry={GEO.seat} castShadow>
        <meshStandardMaterial color={color} roughness={0.85} />
      </mesh>
      <mesh position={[0, 0.8, -0.25]} geometry={GEO.back} castShadow>
        <meshStandardMaterial color={color} roughness={0.85} />
      </mesh>
      <mesh position={[0, 0.25, 0]} geometry={GEO.post}>
        <meshStandardMaterial color="#aeb6c2" metalness={0.9} roughness={0.25} />
      </mesh>
    </group>
  );
}

function Rack({ x, z, host, detail }: { x: number; z: number; host: HostView | null; detail: boolean }) {
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 1.0, 0]} castShadow>
        <boxGeometry args={[0.8, 2.0, 1.05]} />
        <meshStandardMaterial color={host ? '#1a1f29' : '#242a35'} roughness={0.5} metalness={0.5} />
      </mesh>
      {detail && <RackFront x={x} host={host} />}
    </group>
  );
}

/** The lit front of a rack: status LEDs and the machine's name plate. Mounted only when someone is near the server room. */
function RackFront({ x, host }: { x: number; host: HostView | null }) {
  const leds = useRef<THREE.MeshStandardMaterial>(null);
  useFrame((s) => {
    if (!leds.current) return;
    // Blinking only for a host that is really connected; steady red when it is not.
    leds.current.emissiveIntensity = !host ? 0 : host.status === 'online' ? 1.2 + Math.sin(s.clock.elapsedTime * (4 + (host.cpu ?? 0) / 12) + x) * 0.9 : 1.4;
  });
  const color = !host ? '#20262f' : host.status === 'online' ? '#3ddc84' : host.status === 'revoked' ? '#7b8494' : '#ff4d5e';
  return (
    <>
      {[0.4, 0.75, 1.1, 1.45, 1.8].map((y) => (
        <mesh key={y} position={[0, y, 0.531]}>
          <boxGeometry args={[0.66, 0.035, 0.01]} />
          <meshStandardMaterial ref={y === 1.1 ? leds : undefined} color={color} emissive={color} emissiveIntensity={host ? 1 : 0} toneMapped={false} />
        </mesh>
      ))}
      {host && (
        <CanvasPanel
          width={0.7}
          height={0.26}
          px={256}
          position={[0, 2.2, 0.53]}
          deps={[host.name, host.status, host.sessions, Math.round(host.cpu ?? -1), Math.round(host.mem ?? -1)]}
          draw={(ctx, w, h) => {
            ctx.fillStyle = '#0b0f17';
            ctx.fillRect(0, 0, w, h);
            ctx.textBaseline = 'middle';
            ctx.fillStyle = '#fff';
            ctx.font = font(h * 0.3, 700);
            ctx.fillText(clip(ctx, host.name, w * 0.92), w * 0.04, h * 0.25);
            ctx.fillStyle = color;
            ctx.font = font(h * 0.22, 600);
            ctx.fillText(host.status.toUpperCase() + ` · ${host.sessions} sessions`, w * 0.04, h * 0.58);
            ctx.fillStyle = '#9aa7b8';
            ctx.fillText(host.status === 'online' ? `CPU ${host.cpu == null ? 'n/a' : Math.round(host.cpu) + '%'}  MEM ${host.mem == null ? 'n/a' : Math.round(host.mem) + '%'}` : 'no data', w * 0.04, h * 0.84);
          }}
        />
      )}
    </>
  );
}

/** Break a line into at most `max` rows that fit `width`. */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number, max: number): string[] {
  const rows: string[] = [];
  let row = '';
  for (const word of text.split(/\s+/)) {
    const next = row ? `${row} ${word}` : word;
    if (ctx.measureText(next).width <= width || !row) row = next;
    else {
      rows.push(row);
      row = word;
    }
  }
  if (row) rows.push(row);
  if (rows.length > max) {
    rows.length = max;
    rows[max - 1] = clip(ctx, rows[max - 1]! + ' …', width);
  }
  return rows.map((r) => clip(ctx, r, width));
}

const MARKER = { blue: '#1d3b8b', red: '#b3261e', green: '#1f7a3d', ink: '#232830', grey: '#7a8291' };

/** The meeting-room whiteboard, written in marker: the topic, where the meeting stands, and what was said or decided. */
function drawWhiteboard(ctx: CanvasRenderingContext2D, w: number, h: number, wb: WhiteboardView) {
  ctx.fillStyle = '#fbfbf7';
  ctx.fillRect(0, 0, w, h);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const left = w * 0.045;
  const width = w * 0.91;
  if (wb.state === 'empty') {
    ctx.fillStyle = MARKER.grey;
    ctx.font = font(h * 0.13, 700);
    ctx.fillText(wb.title, left, h * 0.3);
    ctx.font = font(h * 0.062, 500);
    wrap(ctx, wb.lines[0] ?? '', width, 3).forEach((row, i) => ctx.fillText(row, left, h * 0.5 + i * h * 0.09));
    return;
  }
  ctx.fillStyle = MARKER.grey;
  ctx.font = font(h * 0.05, 700);
  ctx.fillText(wb.state === 'running' ? 'MEETING IN PROGRESS' : 'LAST DECISION', left, h * 0.075);
  ctx.fillStyle = MARKER.blue;
  ctx.font = font(h * 0.105, 800);
  const title = wrap(ctx, wb.title, width, 2);
  title.forEach((row, i) => ctx.fillText(row, left, h * 0.19 + i * h * 0.115));
  let y = h * 0.19 + title.length * h * 0.115;
  // The title is underlined the way a marker would do it.
  ctx.strokeStyle = MARKER.blue;
  ctx.lineWidth = Math.max(2, h * 0.008);
  ctx.beginPath();
  ctx.moveTo(left, y - h * 0.045);
  ctx.lineTo(left + Math.min(width, Math.max(...title.map((r) => ctx.measureText(r).width))), y - h * 0.045);
  ctx.stroke();
  ctx.fillStyle = wb.state === 'running' ? MARKER.red : MARKER.green;
  ctx.font = font(h * 0.065, 700);
  ctx.fillText(clip(ctx, wb.status, width), left, y + h * 0.02);
  y += h * 0.115;
  ctx.font = font(h * 0.058, 500);
  const rowH = h * 0.078;
  for (const line of wb.lines) {
    const rows = wrap(ctx, line, width - w * 0.03, 2);
    if (y + rows.length * rowH > h * 0.99) break;
    // "HEADING:" lines are the decision document's own section titles.
    const heading = /^[^a-z]+:$/.test(line);
    ctx.fillStyle = heading ? MARKER.blue : line.startsWith('✓') ? MARKER.green : line.startsWith('…') ? MARKER.grey : MARKER.ink;
    ctx.font = font(h * 0.058, heading ? 800 : 500);
    const bullet = !heading && !/^[✓…]/.test(line);
    if (bullet) {
      ctx.beginPath();
      ctx.arc(left + w * 0.008, y, h * 0.011, 0, Math.PI * 2);
      ctx.fill();
    }
    rows.forEach((row, i) => ctx.fillText(row, left + (bullet ? w * 0.03 : 0), y + i * rowH));
    y += rows.length * rowH;
  }
}

function Whiteboard({ at, view, onOpen }: { at: NonNullable<World['whiteboard']>; view: WhiteboardView; onOpen: (meetingId: string | null) => void }) {
  const [hover, setHover] = useState(false);
  const frame = useMemo(() => new THREE.MeshStandardMaterial({ color: '#c9ced6', roughness: 0.35, metalness: 0.7 }), []);
  frame.emissive.set(hover ? '#6ea8ff' : '#000000');
  frame.emissiveIntensity = hover ? 0.8 : 0;
  useEffect(() => {
    sceneProbe().whiteboard = { ...view, x: at.x, y: 1.7, z: at.z };
  }, [view, at]);
  return (
    <group
      position={[at.x, 1.7, at.z]}
      rotation={[0, at.rot, 0]}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(view.meetingId);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHover(true);
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        setHover(false);
        document.body.style.cursor = '';
      }}
    >
      <mesh material={frame}>
        <boxGeometry args={[at.w + 0.1, at.h + 0.1, 0.04]} />
      </mesh>
      {/* the pen tray */}
      <mesh position={[0, -at.h / 2 - 0.06, 0.05]} material={frame}>
        <boxGeometry args={[at.w * 0.5, 0.025, 0.09]} />
      </mesh>
      <CanvasPanel width={at.w} height={at.h} px={1536} position={[0, 0, 0.0215]} deps={[JSON.stringify(view)]} draw={(ctx, w, h) => drawWhiteboard(ctx, w, h, view)} />
    </group>
  );
}

const BOOKS = ['#b5483c', '#3c6fb5', '#d9a441', '#4c8f5e', '#7a5aa8', '#c9ced6'];

/** One decoration from the layout. Mounted only while someone is near it. */
function Decoration({ d, player, overview }: { d: World['layout']['decorations'][number]; player: THREE.Vector3; overview: boolean }) {
  const area = useMemo(() => ({ minX: d.x, maxX: d.x, minZ: d.z, maxZ: d.z }), [d.x, d.z]);
  if (!useNear(`decoration:${d.id}`, area, player, overview)) return null;
  if (d.kind === 'plant') return <Plant x={d.x} z={d.z} />;
  if (d.kind === 'arcade')
    return (
      <group position={[d.x, 0, d.z]} rotation={[0, d.rot, 0]}>
        <mesh position={[0, 0.9, 0]} castShadow>
          <boxGeometry args={[0.8, 1.8, 0.8]} />
          <meshStandardMaterial color="#5b2d8e" roughness={0.5} />
        </mesh>
        <mesh position={[0, 1.25, 0.41]}>
          <planeGeometry args={[0.6, 0.45]} />
          <meshBasicMaterial color="#3ddc84" toneMapped={false} />
        </mesh>
      </group>
    );
  if (d.kind === 'trophy_case')
    return (
      <group position={[d.x, 0, d.z]} rotation={[0, d.rot, 0]}>
        <mesh position={[0, 0.7, 0]} castShadow>
          <boxGeometry args={[2.0, 1.4, 0.45]} />
          <meshStandardMaterial color="#2a313d" roughness={0.4} />
        </mesh>
        {[-0.6, 0, 0.6].map((x) => (
          <mesh key={x} position={[x, 1.6, 0]} castShadow>
            <cylinderGeometry args={[0.12, 0.06, 0.36, 12]} />
            <meshStandardMaterial color="#f5c542" metalness={0.9} roughness={0.2} />
          </mesh>
        ))}
      </group>
    );
  if (d.kind === 'neon_sign')
    return (
      <mesh position={[d.x, 2.3, d.z]} rotation={[0, d.rot, 0]}>
        <boxGeometry args={[4.5, 0.5, 0.06]} />
        <meshStandardMaterial color="#ff5fa2" emissive="#ff5fa2" emissiveIntensity={2.2} toneMapped={false} />
      </mesh>
    );
  if (d.kind === 'bookshelf')
    return (
      <group position={[d.x, 0, d.z]} rotation={[0, d.rot, 0]}>
        <mesh position={[0, 0.9, -0.17]} castShadow>
          <boxGeometry args={[1.6, 1.8, 0.04]} />
          <meshStandardMaterial color="#5a4330" roughness={0.6} />
        </mesh>
        {[-0.78, 0.78].map((x) => (
          <mesh key={x} position={[x, 0.9, 0]} castShadow>
            <boxGeometry args={[0.04, 1.8, 0.38]} />
            <meshStandardMaterial color="#6f5236" roughness={0.55} />
          </mesh>
        ))}
        {[0.04, 0.48, 0.92, 1.36, 1.78].map((y) => (
          <mesh key={y} position={[0, y, 0]}>
            <boxGeometry args={[1.56, 0.04, 0.38]} />
            <meshStandardMaterial color="#6f5236" roughness={0.55} />
          </mesh>
        ))}
        {[0.06, 0.5, 0.94, 1.38].flatMap((y, row) =>
          [0, 1, 2, 3, 4].map((i) => {
            // Blocks of books: widths and colours vary by position, the same for the same shelf every time.
            const wBook = 0.2 + ((row * 3 + i * 5) % 4) * 0.03;
            const hBook = 0.26 + ((row + i * 2) % 3) * 0.04;
            return (
              <mesh key={`${row}:${i}`} position={[-0.6 + i * 0.3, y + hBook / 2, 0.02]}>
                <boxGeometry args={[wBook, hBook, 0.24]} />
                <meshStandardMaterial color={BOOKS[(row * 2 + i) % BOOKS.length]} roughness={0.8} />
              </mesh>
            );
          }),
        )}
      </group>
    );
  if (d.kind === 'floor_lamp')
    return (
      <group position={[d.x, 0, d.z]}>
        <mesh position={[0, 0.02, 0]} castShadow>
          <cylinderGeometry args={[0.17, 0.19, 0.04, 20]} />
          <meshStandardMaterial color="#2c3442" roughness={0.4} metalness={0.6} />
        </mesh>
        <mesh position={[0, 0.82, 0]}>
          <cylinderGeometry args={[0.016, 0.016, 1.6, 8]} />
          <meshStandardMaterial color="#aeb6c2" roughness={0.25} metalness={0.9} />
        </mesh>
        <mesh position={[0, 1.68, 0]}>
          <cylinderGeometry args={[0.13, 0.2, 0.3, 20, 1, true]} />
          <meshStandardMaterial color="#fff1d0" emissive="#ffd98a" emissiveIntensity={1.3} side={THREE.DoubleSide} toneMapped={false} />
        </mesh>
      </group>
    );
  if (d.kind === 'sofa')
    return (
      <group position={[d.x, 0, d.z]} rotation={[0, d.rot, 0]}>
        <mesh position={[0, 0.24, -0.05]} castShadow>
          <boxGeometry args={[2.0, 0.48, 0.8]} />
          <meshStandardMaterial color="#4f6d8f" roughness={0.95} />
        </mesh>
        <mesh position={[0, 0.6, 0.35]} castShadow>
          <boxGeometry args={[2.0, 0.5, 0.2]} />
          <meshStandardMaterial color="#4f6d8f" roughness={0.95} />
        </mesh>
        {[-0.92, 0.92].map((x) => (
          <mesh key={x} position={[x, 0.42, -0.05]} castShadow>
            <boxGeometry args={[0.16, 0.36, 0.8]} />
            <meshStandardMaterial color="#456180" roughness={0.95} />
          </mesh>
        ))}
      </group>
    );
  return null;
}

/**
 * Everything that stands in the rooms. The large furniture of each room is always there; the
 * detailed interior (chairs, live screens, rack lights, appliances, decorations) is mounted
 * only while the camera or the owner is near that room, or an overview camera shows the floor.
 */
export function Rooms({
  world,
  board,
  wall,
  ceo,
  hosts,
  subscribe,
  unlocked,
  whiteboard,
  onOpenMeeting,
  player,
  overview,
}: {
  world: World;
  board: BoardView;
  wall: WallView;
  ceo: CeoView;
  hosts: HostView[];
  subscribe: ScreenSubscribe;
  unlocked: Set<string>;
  whiteboard: WhiteboardView;
  onOpenMeeting: (meetingId: string | null) => void;
  player: THREE.Vector3;
  overview: boolean;
}) {
  const wood = useMemo(() => new THREE.MeshStandardMaterial({ color: '#6f5236', roughness: 0.5 }), []);
  const white = useMemo(() => new THREE.MeshStandardMaterial({ color: '#f1f3f6', roughness: 0.5 }), []);
  const dark = useMemo(() => new THREE.MeshStandardMaterial({ color: '#1c212b', roughness: 0.45, metalness: 0.3 }), []);
  const fabric = useMemo(() => new THREE.MeshStandardMaterial({ color: '#c96f4a', roughness: 0.95 }), []);
  const br = world.room('break');
  const rr = world.room('reception');
  const cr = world.room('ceo');
  const or = world.room('ops');
  const mr = world.room('meeting');
  const sr = world.room('server');
  const tiles = wall.tiles.slice(0, 6);
  const near = {
    meeting: useNear('meeting', useMemo(() => roomBox(mr), [mr]), player, overview),
    ops: useNear('ops', useMemo(() => roomBox(or), [or]), player, overview),
    server: useNear('server', useMemo(() => roomBox(sr), [sr]), player, overview),
    ceo: useNear('ceo', useMemo(() => roomBox(cr), [cr]), player, overview),
    break: useNear('break', useMemo(() => roomBox(br), [br]), player, overview),
    reception: useNear('reception', useMemo(() => roomBox(rr), [rr]), player, overview),
  };

  // For the UI tests: what the usage clocks on the CEO room wall are showing.
  useEffect(() => {
    sceneProbe().clocks = ceo.accounts.map((a) => ({ name: a.name, week: a.week, five: a.five, lines: a.lines }));
  }, [ceo.accounts]);

  return (
    <group>
      {/* project board */}
      {world.board && (
        <group position={[world.board.x, 1.75, world.board.z]} rotation={[0, world.board.rot, 0]}>
          <mesh position={[0, 0, -0.03]} material={dark}>
            <boxGeometry args={[world.board.w + 0.16, world.board.h + 0.16, 0.05]} />
          </mesh>
          <CanvasPanel width={world.board.w} height={world.board.h} px={2048} deps={[JSON.stringify(board)]} draw={(ctx, w, h) => drawBoard(ctx, w, h, board)} />
        </group>
      )}

      {/* meeting room: the table and the whiteboard are always there, the chairs come with proximity */}
      {world.meeting && mr && (
        <group>
          <mesh position={[world.meeting.x, 0.73, world.meeting.z]} castShadow receiveShadow material={wood}>
            <boxGeometry args={[world.meeting.w, 0.06, world.meeting.d]} />
          </mesh>
          {[-1, 1].map((s) => (
            <mesh key={s} position={[world.meeting!.x + (s * world.meeting!.w) / 3, 0.36, world.meeting!.z]} material={dark} castShadow>
              <boxGeometry args={[0.12, 0.7, world.meeting!.d * 0.6]} />
            </mesh>
          ))}
          {near.meeting && world.meeting.seats.map((s, i) => <Chair key={i} x={s.x} z={s.z} rot={s.rot} color="#3d4a5c" />)}
          {world.whiteboard && <Whiteboard at={world.whiteboard} view={whiteboard} onOpen={onOpenMeeting} />}
        </group>
      )}

      {/* operations room: the wall shows real terminals (live only while someone is near enough to see them) */}
      {world.opsWall && or && (
        <group>
          {[0, 1, 2, 3, 4, 5].map((i) => {
            const col = i % 3;
            const row = Math.floor(i / 3);
            const tw = world.opsWall!.w / 3 - 0.2;
            const th = tw * 0.56;
            const x = world.opsWall!.x + (col - 1) * (tw + 0.2);
            const y = 0.75 + (1 - row) * (th + 0.14) + th / 2;
            const tile = tiles[i];
            return (
              <group key={i}>
                <mesh position={[x, y, world.opsWall!.z - 0.03]} material={dark}>
                  <boxGeometry args={[tw + 0.08, th + 0.08, 0.05]} />
                </mesh>
                {tile && near.ops ? (
                  <MonitorScreen sessionId={tile.sessionId} live subscribe={subscribe} position={[x, y, world.opsWall!.z + 0.001]} rotation={[0, 0, 0]} width={tw} height={th} px={768} />
                ) : (
                  <mesh position={[x, y, world.opsWall!.z + 0.001]}>
                    <planeGeometry args={[tw, th]} />
                    <meshBasicMaterial color="#05070b" />
                  </mesh>
                )}
              </group>
            );
          })}
          <mesh position={[or.x + or.w / 2, 0.45, or.z + 4.6]} material={dark} castShadow>
            <boxGeometry args={[5.2, 0.9, 1.0]} />
          </mesh>
          {near.ops && <CanvasPanel width={2.4} height={0.9} px={768} position={[or.x + or.w / 2, 1.28, or.z + 4.75]} rotation={[-0.5, Math.PI, 0]} deps={[wall.stats.join('|')]} draw={(ctx, w, h) => drawLines(ctx, w, h, 'OPERATIONS', wall.stats, '#3ddc84')} />}
        </group>
      )}

      {/* server room: one rack per connected machine */}
      {world.racks.map((r, i) => (
        <Rack key={i} x={r.x} z={r.z} host={hosts[i] ?? null} detail={near.server} />
      ))}

      {/* CEO office */}
      {world.ceoDesk && cr && (
        <group>
          <mesh position={[world.ceoDesk.x, 0.74, world.ceoDesk.z]} material={wood} castShadow receiveShadow>
            <boxGeometry args={[2.4, 0.07, 1.1]} />
          </mesh>
          <mesh position={[world.ceoDesk.x, 0.36, world.ceoDesk.z + 0.3]} material={dark} castShadow>
            <boxGeometry args={[2.2, 0.7, 0.06]} />
          </mesh>
          {near.ceo && <Chair x={world.ceoDesk.x} z={world.ceoDesk.z - 0.95} rot={0} color="#1f2630" />}
          <mesh position={[cr.x + cr.w / 2, 1.75, cr.z + 0.1]} material={dark}>
            <boxGeometry args={[5.2, 2.0, 0.05]} />
          </mesh>
          {/* How much Claude is left: a clock per account, to the right of the company board and then to its left. */}
          {near.ceo &&
            (() => {
              const cx = cr.x + cr.w / 2;
              const step = 1.5;
              const perSide = Math.max(1, Math.floor((cr.w / 2 - 2.6 - 0.35) / step));
              return ceo.accounts.slice(0, perSide * 2).map((a, i) => {
                const side = i < perSide ? 1 : -1;
                const n = i < perSide ? i : i - perSide;
                return <UsageClock key={a.key} account={a} position={[cx + side * (2.6 + 0.85 + n * step), 2.0, cr.z + 0.1]} />;
              });
            })()}
          {near.ceo && <CanvasPanel width={5.0} height={1.8} px={1536} position={[cr.x + cr.w / 2, 1.75, cr.z + 0.13]} deps={[ceo.company, ceo.lines.join('|')]} draw={(ctx, w, h) => drawLines(ctx, w, h, ceo.company, ceo.lines)} />}
          <mesh position={[cr.x + 1.3, 0.3, cr.z + cr.d - 2.2]} material={fabric} castShadow>
            <boxGeometry args={[0.9, 0.6, 2.2]} />
          </mesh>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[world.ceoDesk.x, 0.012, world.ceoDesk.z + 0.4]}>
            <planeGeometry args={[4.6, 3.4]} />
            <meshStandardMaterial color="#39465c" roughness={1} />
          </mesh>
        </group>
      )}

      {/* break room */}
      {br && (
        <group>
          <mesh position={[br.x + br.w - 0.55, 0.46, br.z + 3.2]} material={white} castShadow>
            <boxGeometry args={[0.8, 0.92, 4.6]} />
          </mesh>
          <mesh position={[br.x + br.w - 0.55, 0.94, br.z + 3.2]} material={wood}>
            <boxGeometry args={[0.86, 0.04, 4.66]} />
          </mesh>
          {near.break && (
            <>
              <mesh position={[br.x + br.w - 0.55, 1.14, br.z + 2.2]} material={dark} castShadow>
                <boxGeometry args={[0.4, 0.36, 0.34]} />
              </mesh>
              <mesh position={[br.x + br.w - 0.5, 0.95, br.z + 5.9]} castShadow>
                <boxGeometry args={[0.8, 1.9, 0.8]} />
                <meshStandardMaterial color="#c8ced8" metalness={0.7} roughness={0.3} />
              </mesh>
            </>
          )}
          <group position={[br.x + br.w / 2 - 0.8, 0, br.z + br.d - 1.0]}>
            <mesh position={[0, 0.25, 0]} material={fabric} castShadow>
              <boxGeometry args={[2.6, 0.5, 0.95]} />
            </mesh>
            <mesh position={[0, 0.62, 0.38]} material={fabric} castShadow>
              <boxGeometry args={[2.6, 0.5, 0.2]} />
            </mesh>
          </group>
          <mesh position={[br.x + br.w / 2 - 0.8, 0.3, br.z + br.d - 2.5]} material={wood} castShadow>
            <boxGeometry args={[1.3, 0.06, 0.7]} />
          </mesh>
        </group>
      )}

      {/* reception */}
      {world.reception && rr && (
        <group>
          <mesh position={[world.reception.x, 0.55, world.reception.z]} material={white} castShadow>
            <boxGeometry args={[3.4, 1.1, 0.9]} />
          </mesh>
          <mesh position={[world.reception.x, 1.12, world.reception.z]} material={wood}>
            <boxGeometry args={[3.5, 0.05, 1.0]} />
          </mesh>
          <mesh position={[rr.x + rr.w - 1.0, 0.25, rr.z + 2.6]} material={fabric} castShadow>
            <boxGeometry args={[0.9, 0.5, 3.0]} />
          </mesh>
          {near.reception && (
            <CanvasPanel
              width={5}
              height={1.3}
              px={1536}
              position={[rr.x + rr.w - 0.1, 2.0, rr.z + rr.d / 2]}
              rotation={[0, -Math.PI / 2, 0]}
              deps={[ceo.company, ceo.tagline]}
              draw={(ctx, w, h) => {
                ctx.fillStyle = '#10151e';
                ctx.fillRect(0, 0, w, h);
                ctx.textBaseline = 'middle';
                ctx.textAlign = 'center';
                ctx.fillStyle = '#ffffff';
                ctx.font = font(h * 0.36, 800);
                ctx.fillText(clip(ctx, ceo.company.toUpperCase(), w * 0.9), w / 2, h * 0.4);
                ctx.fillStyle = '#6ea8ff';
                ctx.font = font(h * 0.14, 500);
                ctx.fillText(ceo.tagline, w / 2, h * 0.76);
                ctx.textAlign = 'left';
              }}
            />
          )}
        </group>
      )}

      {world.layout.decorations.map((d) => (d.requires && !unlocked.has(d.requires) ? null : <Decoration key={d.id} d={d} player={player} overview={overview} />))}
    </group>
  );
}
