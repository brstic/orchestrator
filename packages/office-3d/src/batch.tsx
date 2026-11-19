import { useFrame, useThree } from '@react-three/fiber';
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { PartBatcher, type Batcher } from './part-batch.ts';

/** The office's batcher of people's parts (`part-batch.ts`); null outside the office (the character creator, the small stages). */
const Ctx = createContext<Batcher | null>(null);
export const useBatcher = (): Batcher | null => useContext(Ctx);

/**
 * Draws the people's parts inside it together (see above). Each frame, just before the office is drawn: the world
 * matrices are brought up to date here (and not again by the renderer), then copied into the instances.
 */
export function PartBatches({ children }: { children: ReactNode }) {
  const { scene } = useThree();
  const batcher = useMemo(() => new PartBatcher(scene), [scene]);
  useEffect(() => {
    const probe = ((window as unknown as { __orchScene?: Record<string, unknown> }).__orchScene ??= {});
    probe.batches = () => batcher.stats();
    probe.batchedParts = () => batcher.batched();
    // The renderer would bring every world matrix up to date again when it draws: done here, once.
    const was = scene.matrixWorldAutoUpdate;
    scene.matrixWorldAutoUpdate = false;
    return () => {
      scene.matrixWorldAutoUpdate = was;
      batcher.dispose();
    };
  }, [batcher, scene]);
  // After every animation (priority 0 and below), before the frame is drawn (`StableFrame`, priority 1).
  useFrame(({ camera }) => {
    scene.updateMatrixWorld();
    if (camera.parent === null) camera.updateMatrixWorld();
    batcher.update(camera);
  }, 0.5);
  return <Ctx.Provider value={batcher}>{children}</Ctx.Provider>;
}
