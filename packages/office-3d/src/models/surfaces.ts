import * as THREE from 'three';
import type { RoomDef } from '@orchestrator/contracts';

/**
 * What the floors are made of. Each kind of room has its own: carpet tiles on the engineering floor, oak
 * boards in the owner's office, stone in the hall and at reception, a raised floor under the racks.
 * Every floor is one small picture drawn once and repeated — so many metres of floor cost one texture.
 */

function rng(seed: number): () => number {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

const SIZE = 512;

function shade(hex: string, k: number): string {
  const c = new THREE.Color(hex);
  c.multiplyScalar(k);
  return `#${c.getHexString()}`;
}

/** Fine speckle over the whole picture: fibres, pores, dust in the glaze. */
function speckle(ctx: CanvasRenderingContext2D, rnd: () => number, amount: number): void {
  const img = ctx.getImageData(0, 0, SIZE, SIZE);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() - 0.5) * amount;
    img.data[i] = Math.max(0, Math.min(255, img.data[i]! + n));
    img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1]! + n));
    img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2]! + n));
  }
  ctx.putImageData(img, 0, 0);
}

/** Carpet tiles, four across the picture, laid quarter-turned: each tile's pile runs across its neighbour's. */
function carpet(ctx: CanvasRenderingContext2D, base: string, seed: number): void {
  const rnd = rng(seed);
  const n = 4;
  const t = SIZE / n;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const turned = (x + y) % 2 === 0;
      ctx.fillStyle = shade(base, turned ? 1.035 : 0.975);
      ctx.fillRect(x * t, y * t, t, t);
      // The pile: faint lines along the way the tile was laid.
      ctx.strokeStyle = 'rgba(255,255,255,0.035)';
      ctx.lineWidth = 1;
      for (let k = 2; k < t; k += 4) {
        ctx.beginPath();
        if (turned) {
          ctx.moveTo(x * t, y * t + k);
          ctx.lineTo(x * t + t, y * t + k);
        } else {
          ctx.moveTo(x * t + k, y * t);
          ctx.lineTo(x * t + k, y * t + t);
        }
        ctx.stroke();
      }
    }
  speckle(ctx, rnd, 20);
  // Where tiles meet.
  ctx.strokeStyle = 'rgba(0,0,0,0.1)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= n; i++) {
    ctx.beginPath();
    ctx.moveTo(i * t, 0);
    ctx.lineTo(i * t, SIZE);
    ctx.moveTo(0, i * t);
    ctx.lineTo(SIZE, i * t);
    ctx.stroke();
  }
}

/** Wooden boards running along U, their ends staggered, each a little different from the next. */
function boards(ctx: CanvasRenderingContext2D, base: string, seed: number): void {
  const rnd = rng(seed);
  const rows = 8;
  const h = SIZE / rows;
  for (let r = 0; r < rows; r++) {
    // Two or three boards to a row; the row wraps, so the picture repeats without a seam.
    const cuts = [rnd() * SIZE];
    cuts.push((cuts[0]! + SIZE * (0.4 + rnd() * 0.2)) % SIZE);
    cuts.sort((a, b) => a - b);
    const tones = [0.9 + rnd() * 0.2, 0.9 + rnd() * 0.2];
    for (let x = 0; x < SIZE; x++) {
      const tone = x >= cuts[0]! && x < cuts[1]! ? tones[0]! : tones[1]!;
      ctx.fillStyle = shade(base, tone);
      ctx.fillRect(x, r * h, 1, h);
    }
    // Grain along each board.
    for (let k = 0; k < 46; k++) {
      const y = r * h + 2 + rnd() * (h - 4);
      const x = rnd() * SIZE;
      const len = 40 + rnd() * 200;
      ctx.strokeStyle = `rgba(40,25,10,${0.04 + rnd() * 0.1})`;
      ctx.lineWidth = 0.6 + rnd();
      for (const dx of [-SIZE, 0, SIZE]) {
        ctx.beginPath();
        ctx.moveTo(x + dx, y);
        ctx.bezierCurveTo(x + dx + len * 0.3, y + (rnd() - 0.5) * 3, x + dx + len * 0.7, y + (rnd() - 0.5) * 3, x + dx + len, y);
        ctx.stroke();
      }
    }
    ctx.fillStyle = 'rgba(20,12,5,0.38)';
    ctx.fillRect(0, r * h, SIZE, 1.2);
    for (const c of cuts) ctx.fillRect(c, r * h, 1.4, h);
  }
  speckle(ctx, rnd, 8);
}

/** Large stone or ceramic tiles, `n` across the picture, with soft clouding and thin joints. */
function tiles(ctx: CanvasRenderingContext2D, base: string, n: number, seed: number, o: { joint?: string; cloud?: number; veins?: boolean; studs?: boolean } = {}): void {
  const rnd = rng(seed);
  const t = SIZE / n;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      ctx.fillStyle = shade(base, 0.975 + rnd() * 0.05);
      ctx.fillRect(x * t, y * t, t, t);
    }
  // Clouding: big soft patches, lighter and darker, wrapped at the edges.
  for (let i = 0; i < 46; i++) {
    const x = rnd() * SIZE;
    const y = rnd() * SIZE;
    const r = 30 + rnd() * 90;
    const light = rnd() < 0.5;
    for (const dx of [-SIZE, 0, SIZE])
      for (const dy of [-SIZE, 0, SIZE]) {
        const g = ctx.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
        g.addColorStop(0, `rgba(${light ? '255,255,255' : '0,0,0'},${(o.cloud ?? 0.05) * (0.5 + rnd() * 0.5)})`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x + dx - r, y + dy - r, r * 2, r * 2);
      }
  }
  if (o.veins) {
    for (let i = 0; i < 9; i++) {
      let x = rnd() * SIZE;
      let y = rnd() * SIZE;
      ctx.strokeStyle = `rgba(120,125,135,${0.08 + rnd() * 0.1})`;
      ctx.lineWidth = 0.6 + rnd() * 1.2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let k = 0; k < 9; k++) {
        x += 20 + rnd() * 40;
        y += (rnd() - 0.5) * 50;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }
  speckle(ctx, rnd, 7);
  ctx.strokeStyle = o.joint ?? 'rgba(0,0,0,0.2)';
  ctx.lineWidth = 2;
  for (let i = 0; i <= n; i++) {
    ctx.beginPath();
    ctx.moveTo(i * t, 0);
    ctx.lineTo(i * t, SIZE);
    ctx.moveTo(0, i * t);
    ctx.lineTo(SIZE, i * t);
    ctx.stroke();
  }
  if (o.studs) {
    // A raised floor: a lock in each corner of every panel.
    ctx.fillStyle = 'rgba(160,170,185,0.5)';
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++)
        for (const [cx, cy] of [[0.08, 0.08], [0.92, 0.08], [0.08, 0.92], [0.92, 0.92]]) {
          ctx.beginPath();
          ctx.arc((x + cx!) * t, (y + cy!) * t, 2.2, 0, Math.PI * 2);
          ctx.fill();
        }
  }
}

interface FloorSpec {
  /** Metres of floor one repeat of the picture covers. */
  span: number;
  rough: number;
  draw: (ctx: CanvasRenderingContext2D) => void;
}

const FLOORS: Record<RoomDef['kind'], FloorSpec> = {
  open: { span: 2.4, rough: 0.96, draw: (c) => carpet(c, '#5f7190', 11) },
  team: { span: 2.4, rough: 0.96, draw: (c) => carpet(c, '#786a8e', 13) },
  meeting: { span: 2.4, rough: 0.96, draw: (c) => carpet(c, '#4d7c7b', 17) },
  ceo: { span: 1.6, rough: 0.5, draw: (c) => boards(c, '#a17a50', 19) },
  hall: { span: 2.4, rough: 0.42, draw: (c) => tiles(c, '#c3c8d1', 2, 23, { joint: 'rgba(0,0,0,0.16)', cloud: 0.045 }) },
  reception: { span: 2.4, rough: 0.3, draw: (c) => tiles(c, '#d9dbdf', 2, 29, { joint: 'rgba(0,0,0,0.14)', cloud: 0.05, veins: true }) },
  break: { span: 1.8, rough: 0.5, draw: (c) => tiles(c, '#dccbad', 3, 31, { joint: 'rgba(60,40,20,0.22)', cloud: 0.04 }) },
  ops: { span: 2.4, rough: 0.5, draw: (c) => tiles(c, '#2c3446', 4, 37, { joint: 'rgba(0,0,0,0.45)', cloud: 0.03, studs: true }) },
  server: { span: 2.4, rough: 0.45, draw: (c) => tiles(c, '#293040', 4, 41, { joint: 'rgba(0,0,0,0.5)', cloud: 0.03, studs: true }) },
};

const pictures = new Map<string, HTMLCanvasElement>();

/** The floor of one room `w` × `d` metres. A room's own material: the picture is shared, how often it repeats is not. */
export function floorMaterial(kind: RoomDef['kind'], w: number, d: number): { material: THREE.MeshStandardMaterial; texture: THREE.Texture } {
  const spec = FLOORS[kind];
  let canvas = pictures.get(kind);
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    spec.draw(canvas.getContext('2d')!);
    pictures.set(kind, canvas);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(w / spec.span, d / spec.span);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return { material: new THREE.MeshStandardMaterial({ map: texture, roughness: spec.rough, metalness: 0 }), texture };
}

/** A carpet in any colour (members choose their room's), for a floor `w` × `d` metres. */
export function carpetMaterial(color: string, w: number, d: number): { material: THREE.MeshStandardMaterial; texture: THREE.Texture } {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  carpet(canvas.getContext('2d')!, color, 43);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(w / 2.4, d / 2.4);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return { material: new THREE.MeshStandardMaterial({ map: texture, roughness: 0.96, metalness: 0 }), texture };
}

let ceilingPicture: HTMLCanvasElement | null = null;

/** A suspended ceiling of acoustic tiles, 0.6 m square in a white grid, for a ceiling `w` × `d` metres. */
export function ceilingTexture(w: number, d: number): THREE.Texture {
  if (!ceilingPicture) {
    ceilingPicture = document.createElement('canvas');
    ceilingPicture.width = ceilingPicture.height = 256;
    const ctx = ceilingPicture.getContext('2d')!;
    const rnd = rng(53);
    ctx.fillStyle = '#eceff3';
    ctx.fillRect(0, 0, 256, 256);
    // The tiles' pitted face.
    for (let i = 0; i < 2600; i++) {
      ctx.fillStyle = `rgba(90,100,115,${0.05 + rnd() * 0.12})`;
      ctx.fillRect(rnd() * 256, rnd() * 256, 1 + rnd(), 1 + rnd());
    }
    // The grid they hang in: a light bar with a shadow line beside it.
    for (const p of [0, 128]) {
      ctx.fillStyle = '#f8f9fb';
      ctx.fillRect(p, 0, 5, 256);
      ctx.fillRect(0, p, 256, 5);
      ctx.fillStyle = 'rgba(60,70,85,0.28)';
      ctx.fillRect(p + 5, 0, 1.5, 256);
      ctx.fillRect(0, p + 5, 256, 1.5);
    }
  }
  const t = new THREE.CanvasTexture(ceilingPicture);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(w / 1.2, d / 1.2);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
