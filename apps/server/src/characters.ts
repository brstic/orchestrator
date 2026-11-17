import { DEFAULT_LOOK, cleanAppearance, type Appearance } from '@orchestrator/contracts';
import type { Engine } from '@orchestrator/orchestration';

const KV = 'characters';

/**
 * Each person's own character, as they made it in the character creator (`docs/CHARACTER.md`): one look per person
 * — the member's id, 'owner' for the root owner — whatever window or computer they come in from. Kept in the
 * office's store, so it is there every time they come in. Somebody who never made one has none here; every window
 * then draws the look the office gives them by itself (`defaultLook` in office-3d).
 */
export class Characters {
  private looks: Record<string, Appearance>;
  private engine: Engine;

  constructor(engine: Engine) {
    this.engine = engine;
    this.looks = engine.core.store.kvGet<Record<string, Appearance>>(KV, {});
  }

  get(id: string): Appearance | null {
    return this.looks[id] ?? null;
  }

  /** Keep a look for this person: whatever comes in is cleaned first (`cleanAppearance`). */
  set(id: string, input: unknown): Appearance {
    const look = cleanAppearance(input, this.looks[id] ?? DEFAULT_LOOK);
    this.looks[id] = look;
    this.save();
    return look;
  }

  /** Back to the look the office gives them. */
  clear(id: string): void {
    if (!(id in this.looks)) return;
    delete this.looks[id];
    this.save();
  }

  private save(): void {
    this.engine.core.store.kvSet(KV, this.looks);
  }
}
