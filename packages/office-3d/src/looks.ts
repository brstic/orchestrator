import type { Appearance } from '@orchestrator/contracts';
import { SHOES, TIES, traitsOf } from './character/look.ts';

/**
 * The look the office gives a person who has not made their own character (`docs/CHARACTER.md`) — the same in
 * every window, theirs and everybody else's. The root owner is the office's boss in a dark suit; everybody else
 * gets a look from the colour the office gives them (`hue`), the same each time and different from person to person.
 */
export const CEO_LOOK: Appearance = { skin: '#e0ac69', hair: '#241c17', hairStyle: 'short', shirt: '#2b3c66', pants: '#2b3c66', accessory: 'none', build: 1.03, outfit: 'suit', tie: '#8f2738', shoes: '#4a2c1c' };

const SKIN = ['#f1c9a5', '#e0ac69', '#c68642', '#8d5524', '#ffdbac'];
const HAIR = ['#2c1b10', '#3b2a1a', '#6b4423', '#111111', '#a0522d', '#d6b370'];

function hsl(h: number, s: number, l: number): string {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export function defaultLook(hue: number, role: 'owner' | 'colleague' | 'visitor' | undefined, id?: string | null): Appearance {
  if (id === 'owner') return CEO_LOOK;
  const look: Appearance = {
    skin: SKIN[hue % SKIN.length]!,
    hair: HAIR[(hue >> 2) % HAIR.length]!,
    hairStyle: (['short', 'long', 'bun', 'curly'] as const)[(hue >> 4) % 4]!,
    shirt: hsl(hue, 55, 46),
    pants: hsl((hue + 200) % 360, 18, 24),
    accessory: 'none',
    build: 1,
  };
  // Owners other than the root one wear a suit, as they always have (their figure is drawn at a high level).
  return role === 'owner' ? { ...look, outfit: 'suit' } : look;
}

/**
 * A look with everything the office would otherwise decide by itself written out (the outfit, the face, the brows,
 * the eyes, the build, the shoes, the tie) — drawn exactly the same, but now each of them can be changed one at a
 * time: what the character creator starts from.
 */
export function filledLook(a: Appearance, level: number): Appearance {
  const t = traitsOf(a, level);
  const casual = t.outfit === 'tee' || t.outfit === 'sweater';
  return {
    ...a,
    outfit: t.outfit,
    face: t.face,
    brows: t.brow,
    eyes: a.eyes ?? t.iris,
    girth: Math.round(t.girth * 100) / 100,
    glasses: a.glasses ?? a.accessory === 'glasses',
    accessory: a.accessory === 'glasses' ? 'none' : a.accessory,
    facialHair: a.facialHair ?? 'none',
    shoes: a.shoes ?? (t.outfit === 'suit' ? SHOES[0]! : SHOES[(t.seed >>> 3) % (casual ? 4 : 3)]!),
    tie: a.tie ?? TIES[t.seed % TIES.length]!,
  };
}
