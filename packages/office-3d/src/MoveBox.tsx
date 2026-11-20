import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/**
 * The cardboard box of a move to another machine (`docs/MOVE.md`): a moving box as one is — kraft board with rounded
 * edges, a darker inside, the cut edge of the board along the rims, hand holes in the ends, "THIS SIDE UP" and the
 * owner's name in marker on the front, four flaps hinged at the top. Open while it is filled (what is on the desk goes
 * into it as `fill` grows), closed and taped when it is carried.
 *
 * Its origin is the middle of its bottom; +z is its front (the printed side), toward whoever packs or carries it.
 */
export const BOX = { w: 0.46, h: 0.3, d: 0.34 };
const T = 0.009;

const KRAFT = new THREE.MeshStandardMaterial({ color: '#c29563', roughness: 0.93, metalness: 0 });
const KRAFT_SIDE = new THREE.MeshStandardMaterial({ color: '#b5875a', roughness: 0.95, metalness: 0 });
const INSIDE = new THREE.MeshStandardMaterial({ color: '#8f6a43', roughness: 1, metalness: 0 });
const EDGE = new THREE.MeshStandardMaterial({ color: '#dcc097', roughness: 1, metalness: 0 });
const HOLE = new THREE.MeshStandardMaterial({ color: '#2b1f14', roughness: 1, metalness: 0 });
const TAPE = new THREE.MeshStandardMaterial({ color: '#d9c49a', roughness: 0.35, metalness: 0, transparent: true, opacity: 0.88 });

const wallLong = new RoundedBoxGeometry(BOX.w, BOX.h, T, 2, 0.004);
const wallShort = new RoundedBoxGeometry(T, BOX.h, BOX.d - 2 * T, 2, 0.004);
const bottom = new RoundedBoxGeometry(BOX.w, T, BOX.d, 2, 0.004);
const flapLong = new RoundedBoxGeometry(BOX.w - 0.004, 0.006, BOX.d / 2 - 0.002, 1, 0.002);
const flapShort = new RoundedBoxGeometry(BOX.d - 2 * T - 0.01, 0.005, 0.15, 1, 0.002);

/** The front print: arrows, "THIS SIDE UP", and the name written in marker. */
function printTexture(name: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 320;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, c.width, c.height);
  const ink = 'rgba(52, 34, 18, 0.82)';
  g.fillStyle = ink;
  g.strokeStyle = ink;
  // Two arrows up, top left.
  for (const x of [40, 92]) {
    g.beginPath();
    g.moveTo(x, 30);
    g.lineTo(x + 22, 62);
    g.lineTo(x + 8, 62);
    g.lineTo(x + 8, 100);
    g.lineTo(x - 8, 100);
    g.lineTo(x - 8, 62);
    g.lineTo(x - 22, 62);
    g.closePath();
    g.fill();
  }
  g.font = 'bold 30px Arial, Helvetica, sans-serif';
  g.textBaseline = 'middle';
  g.fillText('THIS SIDE UP', 140, 66);
  g.lineWidth = 3;
  g.strokeRect(18, 16, 476, 104);
  // The name, as somebody wrote it on with a thick marker.
  g.font = 'bold 74px "Marker Felt", "Comic Sans MS", "Segoe Print", cursive';
  g.fillStyle = 'rgba(28, 22, 18, 0.9)';
  g.textAlign = 'center';
  g.save();
  g.translate(256, 222);
  g.rotate(-0.05);
  g.fillText(name.slice(0, 14), 0, 0);
  g.restore();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** What is put into the box, in the order it goes in: each is on the desk until the move has come that far. */
export const PACKED = [
  { at: 0.12, kind: 'papers' },
  { at: 0.3, kind: 'binder' },
  { at: 0.5, kind: 'mug' },
  { at: 0.68, kind: 'notebook' },
  { at: 0.85, kind: 'photo' },
] as const;
type Kind = (typeof PACKED)[number]['kind'];

const PAPER = new THREE.MeshStandardMaterial({ color: '#f1eee6', roughness: 0.9 });
const BINDER = new THREE.MeshStandardMaterial({ color: '#3866b0', roughness: 0.6 });
const MUG = new THREE.MeshStandardMaterial({ color: '#e45b3c', roughness: 0.45 });
const NOTEBOOK = new THREE.MeshStandardMaterial({ color: '#2f7a55', roughness: 0.7 });
const FRAME = new THREE.MeshStandardMaterial({ color: '#3a2a1e', roughness: 0.5 });
const PHOTO = new THREE.MeshStandardMaterial({ color: '#9cc4e4', roughness: 0.4 });

/** One of the things on the desk; standing (on the desk) or put in (lying in the box). */
export function Thing({ kind, inBox = false }: { kind: Kind; inBox?: boolean }) {
  switch (kind) {
    case 'papers':
      return (
        <mesh position={[0, 0.02, 0]} material={PAPER} castShadow>
          <boxGeometry args={[0.21, 0.04, 0.29]} />
        </mesh>
      );
    case 'binder':
      return inBox ? (
        <mesh position={[0, 0.03, 0]} rotation={[0, 0, Math.PI / 2]} material={BINDER} castShadow>
          <boxGeometry args={[0.06, 0.24, 0.29]} />
        </mesh>
      ) : (
        <mesh position={[0, 0.15, 0]} material={BINDER} castShadow>
          <boxGeometry args={[0.06, 0.3, 0.24]} />
        </mesh>
      );
    case 'mug':
      return (
        <group position={[0, 0, 0]}>
          <mesh position={[0, 0.05, 0]} material={MUG} castShadow>
            <cylinderGeometry args={[0.04, 0.036, 0.1, 18]} />
          </mesh>
          <mesh position={[0.045, 0.05, 0]} rotation={[0, 0, Math.PI / 2]} material={MUG}>
            <torusGeometry args={[0.024, 0.007, 8, 16, Math.PI]} />
          </mesh>
        </group>
      );
    case 'notebook':
      return (
        <mesh position={[0, 0.012, 0]} rotation={[0, 0.3, 0]} material={NOTEBOOK} castShadow>
          <boxGeometry args={[0.15, 0.022, 0.21]} />
        </mesh>
      );
    case 'photo':
      return inBox ? (
        <group position={[0, 0.012, 0]}>
          <mesh material={FRAME}>
            <boxGeometry args={[0.13, 0.016, 0.1]} />
          </mesh>
        </group>
      ) : (
        <group position={[0, 0.055, 0]} rotation={[-0.25, 0.4, 0]}>
          <mesh material={FRAME} castShadow>
            <boxGeometry args={[0.13, 0.1, 0.012]} />
          </mesh>
          <mesh position={[0, 0, 0.007]} material={PHOTO}>
            <planeGeometry args={[0.105, 0.075]} />
          </mesh>
        </group>
      );
  }
}

/** Where each thing lies once it is in the box (the box's frame, above its bottom). */
const IN_BOX: Record<Kind, [number, number, number]> = {
  papers: [-0.1, T, 0],
  binder: [0.08, T, 0],
  mug: [0.15, T + 0.06, -0.08],
  notebook: [-0.1, T + 0.04, 0.01],
  photo: [-0.02, T + 0.08, 0.04],
};

export function MoveBox({ fill, closed, name }: { fill: number; closed: boolean; name: string }) {
  const print = useMemo(() => printTexture(name), [name]);
  const printMat = useMemo(() => new THREE.MeshStandardMaterial({ map: print, transparent: true, roughness: 0.95, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }), [print]);
  // The flaps turn about their hinges: out and down when open, flat over the top when closed (the short ones first).
  const shut = useRef(closed ? 1 : 0);
  const long = [useRef<THREE.Group>(null), useRef<THREE.Group>(null)];
  const short = [useRef<THREE.Group>(null), useRef<THREE.Group>(null)];
  const tape = useRef<THREE.Group>(null);
  useFrame((_s, dt) => {
    shut.current += ((closed ? 1 : 0) - shut.current) * Math.min(1, dt * 3.2);
    const k = shut.current;
    const shortK = Math.min(1, k * 1.6);
    const longK = Math.max(0, k * 1.6 - 0.6);
    // Open: folded out past upright (−2.1 rad from flat-closed); closed: flat (0).
    long[0].current?.rotation.set(-(1 - longK) * 2.1, 0, 0);
    long[1].current?.rotation.set((1 - longK) * 2.1, 0, 0);
    short[0].current?.rotation.set(0, 0, (1 - shortK) * 2.0);
    short[1].current?.rotation.set(0, 0, -(1 - shortK) * 2.0);
    if (tape.current) tape.current.visible = k > 0.97;
  });
  const half = { w: BOX.w / 2, d: BOX.d / 2 };
  return (
    <group>
      {/* The shell: the bottom, the long walls front and back, the short ends. */}
      <mesh geometry={bottom} material={KRAFT} position={[0, T / 2, 0]} castShadow receiveShadow />
      <mesh geometry={wallLong} material={KRAFT} position={[0, BOX.h / 2, half.d - T / 2]} castShadow />
      <mesh geometry={wallLong} material={KRAFT} position={[0, BOX.h / 2, -half.d + T / 2]} castShadow />
      <mesh geometry={wallShort} material={KRAFT_SIDE} position={[half.w - T / 2, BOX.h / 2, 0]} castShadow />
      <mesh geometry={wallShort} material={KRAFT_SIDE} position={[-half.w + T / 2, BOX.h / 2, 0]} castShadow />
      {/* The inside, darker, a hair inside the walls. */}
      <mesh material={INSIDE} position={[0, BOX.h / 2 + T / 2, half.d - T - 0.0015]}>
        <boxGeometry args={[BOX.w - 2 * T - 0.002, BOX.h - T, 0.002]} />
      </mesh>
      <mesh material={INSIDE} position={[0, BOX.h / 2 + T / 2, -half.d + T + 0.0015]}>
        <boxGeometry args={[BOX.w - 2 * T - 0.002, BOX.h - T, 0.002]} />
      </mesh>
      <mesh material={INSIDE} position={[half.w - T - 0.0015, BOX.h / 2 + T / 2, 0]}>
        <boxGeometry args={[0.002, BOX.h - T, BOX.d - 2 * T - 0.004]} />
      </mesh>
      <mesh material={INSIDE} position={[-half.w + T + 0.0015, BOX.h / 2 + T / 2, 0]}>
        <boxGeometry args={[0.002, BOX.h - T, BOX.d - 2 * T - 0.004]} />
      </mesh>
      <mesh material={INSIDE} position={[0, T + 0.0011, 0]}>
        <boxGeometry args={[BOX.w - 2 * T - 0.002, 0.002, BOX.d - 2 * T - 0.002]} />
      </mesh>
      {/* The cut edge of the board along the rims. */}
      {[half.d - T / 2, -half.d + T / 2].map((z) => (
        <mesh key={`e${z}`} material={EDGE} position={[0, BOX.h + 0.0008, z]}>
          <boxGeometry args={[BOX.w, 0.0016, T + 0.001]} />
        </mesh>
      ))}
      {[half.w - T / 2, -half.w + T / 2].map((x) => (
        <mesh key={`e${x}`} material={EDGE} position={[x, BOX.h + 0.0008, 0]}>
          <boxGeometry args={[T + 0.001, 0.0016, BOX.d]} />
        </mesh>
      ))}
      {/* Hand holes in both ends. */}
      {[half.w + 0.0006, -half.w - 0.0006].map((x) => (
        <mesh key={`h${x}`} material={HOLE} position={[x, BOX.h - 0.065, 0]} rotation={[0, 0, 0]}>
          <boxGeometry args={[0.002, 0.034, 0.11]} />
        </mesh>
      ))}
      {/* The print on the front. */}
      <mesh material={printMat} position={[0, BOX.h * 0.5, half.d + 0.0012]}>
        <planeGeometry args={[BOX.w * 0.9, BOX.w * 0.9 * (320 / 512)]} />
      </mesh>
      {/* What is in it so far. */}
      {!closed &&
        PACKED.filter((p) => fill >= p.at).map((p) => (
          <group key={p.kind} position={IN_BOX[p.kind]}>
            <Thing kind={p.kind} inBox />
          </group>
        ))}
      {/* The flaps, hinged at the top edges: the long ones front and back, the short ones at the ends. */}
      <group ref={long[0]} position={[0, BOX.h, half.d]}>
        <mesh geometry={flapLong} material={KRAFT} position={[0, 0.003, -BOX.d / 4]} castShadow />
      </group>
      <group ref={long[1]} position={[0, BOX.h + 0.006, -half.d]}>
        <mesh geometry={flapLong} material={KRAFT} position={[0, 0.003, BOX.d / 4]} castShadow />
      </group>
      <group ref={short[0]} position={[half.w - T, BOX.h - 0.003, 0]}>
        <mesh geometry={flapShort} material={KRAFT_SIDE} position={[-0.075, 0, 0]} rotation={[0, Math.PI / 2, 0]} />
      </group>
      <group ref={short[1]} position={[-half.w + T, BOX.h - 0.003, 0]}>
        <mesh geometry={flapShort} material={KRAFT_SIDE} position={[0.075, 0, 0]} rotation={[0, Math.PI / 2, 0]} />
      </group>
      {/* Tape along the seam and down the front and back. */}
      <group ref={tape} visible={closed}>
        <mesh material={TAPE} position={[0, BOX.h + 0.0125, 0]}>
          <boxGeometry args={[0.055, 0.001, BOX.d + 0.002]} />
        </mesh>
        {[half.d + 0.0016, -half.d - 0.0016].map((z) => (
          <mesh key={`t${z}`} material={TAPE} position={[0, BOX.h - 0.05, z]}>
            <boxGeometry args={[0.055, 0.1, 0.001]} />
          </mesh>
        ))}
      </group>
    </group>
  );
}
