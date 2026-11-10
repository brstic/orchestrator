import { deskSeat, type Desk } from '@orchestrator/contracts';
import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import * as THREE from 'three';
import { ON_SURFACE } from './surface.ts';

/**
 * While the owner is moving someone to another desk: every free seat gets a pulsing ring, and a
 * click on one seats them there (walking up and pressing the interact key does the same).
 */
export function SeatMarkers({ desks, onPick }: { desks: Desk[]; onPick: (deskId: string) => void }) {
  const group = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (!group.current) return;
    const k = 1 + Math.sin(clock.elapsedTime * 4) * 0.08;
    for (const ring of group.current.children) ring.scale.setScalar(k);
  });
  return (
    <group ref={group}>
      {desks.map((d) => {
        const seat = deskSeat(d);
        return (
          <mesh
            key={d.id}
            rotation={[-Math.PI / 2, 0, 0]}
            position={[seat.x, 0.03, seat.z]}
            onClick={(e) => {
              e.stopPropagation();
              onPick(d.id);
            }}
            onPointerOver={() => (document.body.style.cursor = 'pointer')}
            onPointerOut={() => (document.body.style.cursor = '')}
          >
            <ringGeometry args={[0.42, 0.56, 36]} />
            <meshBasicMaterial color="#3ddc84" transparent opacity={0.85} toneMapped={false} depthWrite={false} {...ON_SURFACE} />
          </mesh>
        );
      })}
    </group>
  );
}
