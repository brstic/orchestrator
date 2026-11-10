import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import type * as THREE from 'three';

/**
 * What the person at this computer has just said, above their own character's head — the same
 * bubble everyone else sees over them. It follows the character; there is nothing to show in the
 * views where the character itself is not drawn (first person, at a workstation).
 */
export function SelfBubble({ player, text }: { player: THREE.Vector3; text: string | null }) {
  const group = useRef<THREE.Group>(null);
  // After the rig has moved the character (-1), before the overlay works out where it is on screen (0).
  useFrame(() => {
    group.current?.position.set(player.x, 1.98, player.z);
  }, -0.5);
  if (!text) return null;
  return (
    <group ref={group} position={[player.x, 1.98, player.z]}>
      <Html center zIndexRange={[33, 0]} style={{ pointerEvents: 'none' }}>
        <div className="self-says">
          <div className="human-says">{text}</div>
        </div>
      </Html>
    </group>
  );
}
