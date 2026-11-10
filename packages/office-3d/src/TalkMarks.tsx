import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import type * as THREE from 'three';

/** An employee the person at this computer is in conversation with. */
export interface TalkMark {
  /** The employee. */
  id: string;
  /** 'waiting': I said something and they have not answered yet. 'answered': their answer is waiting for me. */
  kind: 'waiting' | 'answered';
}

function Mark({ mark, positions, onOpen }: { mark: TalkMark; positions: Map<string, THREE.Vector3>; onOpen: (employeeId: string) => void }) {
  const group = useRef<THREE.Group>(null);
  // After the people have been moved for this frame, before the overlay works out where it is on screen.
  useFrame(() => {
    const p = positions.get(mark.id);
    const g = group.current;
    if (!g) return;
    g.visible = !!p;
    if (p) g.position.set(p.x, 0, p.z);
  }, -0.5);
  return (
    <group ref={group}>
      <Html position={[0, 1.8, 0]} center zIndexRange={[46, 0]} style={{ pointerEvents: 'none' }}>
        {/* Lifted clear of the name tag and its attention icon, which sit around this point. */}
        <div className="talkmark-wrap">
          {mark.kind === 'answered' ? (
            <button type="button" className="talkmark talkmark-answered" title="They answered you — click to read" onClick={() => onOpen(mark.id)}>
              <span className="talkmark-glyph" aria-hidden>
                💬
              </span>
              answered you
            </button>
          ) : (
            <div className="talkmark talkmark-waiting" title="Working on what you said">
              <i />
              <i />
              <i />
            </div>
          )}
        </div>
      </Html>
    </group>
  );
}

/**
 * Over the heads of the employees I have spoken to: three dots while they work on what I said, and a
 * speech bubble once their answer is waiting for me. Mine alone — other people's conversations, and what
 * employees say to each other, put nothing here.
 */
export function TalkMarks({ marks, positions, onOpen }: { marks: TalkMark[]; positions: Map<string, THREE.Vector3>; onOpen: (employeeId: string) => void }) {
  return (
    <>
      {marks.map((m) => (
        <Mark key={`${m.id}-${m.kind}`} mark={m} positions={positions} onOpen={onOpen} />
      ))}
    </>
  );
}
