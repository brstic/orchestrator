import { Html } from '@react-three/drei';
import { useMemo, useState } from 'react';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { DESK_SIZE } from '@orchestrator/contracts';
import type { World } from './world.ts';

/** The documents an employee really has in their folder: how many, and whose they are. */
export interface DocsView {
  employeeId: string;
  name: string;
  deskId: string;
  /** Number of Markdown files found in the employee's folder. Zero shows nothing. */
  count: number;
}

const FOLDER_COLORS = ['#e8c15a', '#6ea8ff', '#ff8c6b', '#7ed39a'];
const folderGeo = new RoundedBoxGeometry(0.24, 0.014, 0.32, 2, 0.006);
const tabGeo = new RoundedBoxGeometry(0.08, 0.014, 0.03, 2, 0.005);
const binderGeo = new RoundedBoxGeometry(0.065, 0.3, 0.24, 2, 0.01);
const labelGeo = new THREE.PlaneGeometry(0.04, 0.12);
const paperGeo = new THREE.BoxGeometry(0.225, 0.008, 0.3);

/**
 * A stack of folders and a binder on the corner of a desk, one set per employee whose folder
 * actually contains Markdown documents. The stack grows with the number of files; clicking it
 * opens those documents. Purely a view of real files — no documents, no folders on the desk.
 */
export function Documents({ world, docs, onOpen }: { world: World; docs: DocsView[]; onOpen: (employeeId: string) => void }) {
  const desks = useMemo(() => new Map(world.layout.desks.map((d) => [d.id, d])), [world.layout.desks]);
  return (
    <>
      {docs.map((d) => {
        const desk = desks.get(d.deskId);
        if (!desk || d.count <= 0) return null;
        return <Stack key={d.employeeId} x={desk.x} z={desk.z} rot={desk.rot} view={d} onOpen={onOpen} />;
      })}
    </>
  );
}

function Stack({ x, z, rot, view, onOpen }: { x: number; z: number; rot: number; view: DocsView; onOpen: (employeeId: string) => void }) {
  const [hover, setHover] = useState(false);
  // One folder for a couple of files, up to four for a well-documented project.
  const folders = Math.min(4, Math.max(1, Math.ceil(view.count / 4)));
  const mats = useMemo(() => FOLDER_COLORS.map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.75 })), []);
  const paper = useMemo(() => new THREE.MeshStandardMaterial({ color: '#f4f1e8', roughness: 0.9 }), []);
  const binder = useMemo(() => new THREE.MeshStandardMaterial({ color: '#27364f', roughness: 0.6 }), []);
  const label = useMemo(() => new THREE.MeshStandardMaterial({ color: '#f4f1e8', roughness: 0.9 }), []);
  const glow = hover ? 0.35 : 0;
  for (const m of mats) {
    m.emissive.set(hover ? '#ffffff' : '#000000');
    m.emissiveIntensity = glow * 0.5;
  }
  binder.emissive.set(hover ? '#6ea8ff' : '#000000');
  binder.emissiveIntensity = glow;
  return (
    <group position={[x, DESK_SIZE.h, z]} rotation={[0, rot, 0]}>
      {/* Front-right corner of the desk, as seen from the chair. */}
      <group
        position={[DESK_SIZE.w / 2 - 0.24, 0, -0.1]}
        onClick={(e) => {
          e.stopPropagation();
          onOpen(view.employeeId);
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
        {Array.from({ length: folders }, (_, i) => (
          <group key={i} position={[0, 0.012 + i * 0.024, 0]} rotation={[0, (i % 2 ? -1 : 1) * 0.09 * (i + 1) * 0.5, 0]}>
            <mesh geometry={paperGeo} material={paper} position={[0, 0.006, 0]} />
            <mesh geometry={folderGeo} material={mats[i % mats.length]} position={[0, 0.014, 0]} castShadow receiveShadow />
            {/* (Receiving shadows like the folder it is part of: one material, drawn one way.) */}
            <mesh geometry={tabGeo} material={mats[i % mats.length]} position={[0.06 - i * 0.03, 0.014, 0.17]} receiveShadow />
          </group>
        ))}
        {view.count >= 3 && (
          <group position={[-0.2, 0.15, 0.02]}>
            <mesh geometry={binderGeo} material={binder} castShadow />
            <mesh geometry={labelGeo} material={label} position={[0, 0.02, 0.121]} />
          </group>
        )}
        {hover && (
          <Html position={[0, 0.34, 0]} center zIndexRange={[40, 0]} style={{ pointerEvents: 'none' }}>
            <div className="doc-tip">
              {view.name}'s documents · {view.count} file{view.count === 1 ? '' : 's'}
            </div>
          </Html>
        )}
      </group>
    </group>
  );
}
