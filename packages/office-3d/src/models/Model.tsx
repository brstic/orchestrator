import { useLayoutEffect, useRef } from 'react';
import * as THREE from 'three';
import { INSTANCED_DEPTH, instancedTwin } from '../twins.ts';
import type { Model as ModelData } from './kit.ts';

/** One model, standing where the group is put. */
export function Model({ model, shadows = true, ...props }: { model: ModelData; shadows?: boolean } & Record<string, any>) {
  return (
    <group {...props}>
      {model.parts.map((p, i) => (
        <mesh key={i} geometry={p.geometry} material={p.material} castShadow={shadows && p.cast} receiveShadow />
      ))}
    </group>
  );
}

function InstancedPart({ geometry, material, matrices, cast }: { geometry: THREE.BufferGeometry; material: THREE.Material; matrices: THREE.Matrix4[]; cast: boolean }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [matrices]);
  return <instancedMesh ref={ref} args={[geometry, instancedTwin(material), matrices.length]} customDepthMaterial={INSTANCED_DEPTH} castShadow={cast} receiveShadow frustumCulled />;
}

/** Many copies of one model: one draw call per material, however many copies there are. */
export function InstancedModel({ model, matrices, shadows = true }: { model: ModelData; matrices: THREE.Matrix4[]; shadows?: boolean }) {
  if (!matrices.length) return null;
  return (
    <>
      {model.parts.map((p, i) => (
        // Keyed by count: an instanced mesh cannot grow, so a longer list gets a new one.
        <InstancedPart key={`${i}:${matrices.length}`} geometry={p.geometry} material={p.material} matrices={matrices} cast={shadows && p.cast} />
      ))}
    </>
  );
}
