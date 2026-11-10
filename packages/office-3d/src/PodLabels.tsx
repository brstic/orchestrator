import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useState } from 'react';
import type { World } from './world.ts';

const podOf = (deskId: string): string => deskId.replace(/-[a-z]$/, '');

/** What the owner wrote on a table: a small sign above the middle of it. Nothing is shown for a table without a label. */
export function PodLabels({ world }: { world: World }) {
  // HTML overlays are added after the first drawn frame (mounted in the scene's first commit they can fail to appear).
  const [drawn, setDrawn] = useState(false);
  useFrame(() => {
    if (!drawn) setDrawn(true);
  });
  const labels = world.layout.podLabels ?? {};
  if (!drawn) return null;
  return (
    <>
      {Object.entries(labels).map(([pod, text]) => {
        const desks = world.layout.desks.filter((d) => podOf(d.id) === pod);
        if (!desks.length || !text) return null;
        const x = desks.reduce((n, d) => n + d.x, 0) / desks.length;
        const z = desks.reduce((n, d) => n + d.z, 0) / desks.length;
        return (
          <Html key={pod} position={[x, 1.55, z]} center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
            <div className="pod-label">{text}</div>
          </Html>
        );
      })}
    </>
  );
}
