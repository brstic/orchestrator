import { Html } from '@react-three/drei';
import { useState } from 'react';
import { Model } from './models/Model.tsx';
import { vault } from './models/rooms.ts';
import type { World } from './world.ts';

/**
 * The vault in the server room: the safe the office keeps its passwords and keys in. Here it is only the
 * thing one walks up to (or clicks) to open the vault's window; what is in it is not drawn in the office.
 * Nothing on it moves.
 */
export function Vault({ world, onOpen }: { world: World; onOpen?: () => void }) {
  const [hover, setHover] = useState(false);
  if (!world.vault) return null;
  const { x, z, rot } = world.vault;
  return (
    <group
      position={[x, 0, z]}
      rotation={[0, rot, 0]}
      onClick={(e) => {
        e.stopPropagation();
        onOpen?.();
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
      <Model model={vault()} />
      {hover && (
        <Html position={[0, 1.95, 0]} center zIndexRange={[40, 0]} style={{ pointerEvents: 'none' }}>
          <div className="doc-tip">Vault · click to open</div>
        </Html>
      )}
    </group>
  );
}
