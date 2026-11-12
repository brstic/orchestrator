/**
 * What a file somebody brings to the arcade is: a cartridge the console can run, a zip with one inside, or
 * something else. Nothing here needs a page (only what Node has too), so it is tested as it is.
 */

/** Cartridge files the console runs: Mega Drive first, and the Master System and Game Gear its core also knows. */
export const ROM_EXTENSIONS = ['md', 'gen', 'bin', 'smd', 'sms', 'gg'] as const;
export const ROM_ACCEPT = [...ROM_EXTENSIONS, 'zip'].map((e) => `.${e}`).join(',');
/** No cartridge of these consoles is larger; a file beyond it is something else. */
export const ROM_MAX_BYTES = 16 * 1024 * 1024;
const ROM_MIN_BYTES = 1024;

export interface RomFile {
  /** The file's name with a cartridge's extension: the console tells the kind of cartridge by it. */
  name: string;
  bytes: Uint8Array;
}

export const extensionOf = (name: string): string => /\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1]?.toLowerCase() ?? '';
const isRomName = (name: string): boolean => (ROM_EXTENSIONS as readonly string[]).includes(extensionOf(name));
const baseName = (name: string): string => name.replace(/^.*[\\/]/, '');

/**
 * The cartridge in a file that was brought, or why it is not one. A zip gives the first cartridge inside it.
 */
export async function romFrom(name: string, bytes: Uint8Array): Promise<{ ok: true; rom: RomFile } | { ok: false; why: string }> {
  let rom: RomFile;
  if (isZip(bytes)) {
    const inside = zipEntries(bytes).filter((e) => isRomName(e.name));
    if (!inside.length) return { ok: false, why: 'no Mega Drive cartridge inside this zip' };
    try {
      rom = { name: baseName(inside[0]!.name), bytes: await unzipEntry(bytes, inside[0]!) };
    } catch (e) {
      return { ok: false, why: `this zip could not be opened (${(e as Error).message})` };
    }
  } else if (isRomName(name)) rom = { name: baseName(name), bytes };
  else return { ok: false, why: `not a cartridge file (${ROM_EXTENSIONS.map((e) => `.${e}`).join(', ')} or a .zip of one)` };
  if (rom.bytes.length < ROM_MIN_BYTES) return { ok: false, why: 'too small to be a cartridge' };
  if (rom.bytes.length > ROM_MAX_BYTES) return { ok: false, why: 'too large to be a cartridge' };
  return { ok: true, rom };
}

/**
 * The game's name: what a Mega Drive cartridge says of itself in its header (the name for outside Japan, then the
 * one for Japan), or the file's name where the header says nothing readable.
 */
export function titleOf(rom: RomFile): string {
  const fromFile = rom.name
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s*[([][^)\]]*[)\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const b = rom.bytes;
  const text = (at: number, len: number) => {
    let s = '';
    for (let i = at; i < at + len && i < b.length; i++) s += b[i]! >= 0x20 && b[i]! < 0x7f ? String.fromCharCode(b[i]!) : ' ';
    return s.replace(/\s+/g, ' ').trim();
  };
  if (text(0x100, 4) !== 'SEGA') return fromFile || rom.name;
  const named = text(0x150, 48) || text(0x120, 48);
  // A header of nothing but punctuation, or a couple of letters, names nothing.
  if (named.replace(/[^A-Za-z0-9]/g, '').length < 3) return fromFile || rom.name;
  return named.toUpperCase() === named ? named.toLowerCase().replace(/(^|[\s\-:.'(])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase()) : named;
}

// ───────────── zip ─────────────

export const isZip = (b: Uint8Array): boolean => b.length > 30 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

interface ZipEntry {
  name: string;
  method: number;
  packed: number;
  size: number;
  /** Where its local header starts. */
  at: number;
}

const u16 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u32 = (b: Uint8Array, at: number) => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;

/** The files of a zip, from its directory at the end. */
export function zipEntries(b: Uint8Array): ZipEntry[] {
  // The end record is at the very end, behind at most a comment of 64 KB.
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (u32(b, i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) return [];
  const count = u16(b, end + 10);
  let at = u32(b, end + 16);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count && at + 46 <= b.length && u32(b, at) === 0x02014b50; n++) {
    const nameLen = u16(b, at + 28);
    const name = new TextDecoder().decode(b.subarray(at + 46, at + 46 + nameLen));
    if (!name.endsWith('/')) out.push({ name, method: u16(b, at + 10), packed: u32(b, at + 20), size: u32(b, at + 24), at: u32(b, at + 42) });
    at += 46 + nameLen + u16(b, at + 30) + u16(b, at + 32);
  }
  return out;
}

export async function unzipEntry(b: Uint8Array, e: ZipEntry): Promise<Uint8Array> {
  if (e.size > ROM_MAX_BYTES) throw new Error('the file inside is too large');
  if (u32(b, e.at) !== 0x04034b50) throw new Error('damaged');
  const start = e.at + 30 + u16(b, e.at + 26) + u16(b, e.at + 28);
  const packed = b.subarray(start, start + e.packed);
  if (e.method === 0) return packed.slice();
  if (e.method !== 8) throw new Error('packed in a way this does not read');
  const stream = new Blob([packed as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  if (out.length !== e.size) throw new Error('damaged');
  return out;
}

/** A name for a cartridge that is the same for the same bytes, whatever the file was called. */
export async function romId(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes as BufferSource));
    return [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
  }
  // A page that is not served securely has no digest: a plain hash and the size tell cartridges apart well enough.
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193) >>> 0;
  return `f${h.toString(16).padStart(8, '0')}${bytes.length.toString(16)}`;
}
