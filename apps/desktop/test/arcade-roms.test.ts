import assert from 'node:assert/strict';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { romFrom, romId, titleOf, zipEntries } from '../src/arcade/roms.ts';
import { buildTestRom } from '../../../tests/fixtures/md-test-rom.mjs';

const rom = () => new Uint8Array(buildTestRom());

/** A zip of the given files, written the plain way: each deflated (or stored), then the directory. */
function zip(files: Array<{ name: string; bytes: Uint8Array; store?: boolean }>): Uint8Array {
  const parts: Buffer[] = [];
  const dir: Buffer[] = [];
  let at = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const packed = f.store ? Buffer.from(f.bytes) : zlib.deflateRawSync(f.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(f.store ? 0 : 8, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(f.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(f.store ? 0 : 8, 10);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(f.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(at, 42);
    parts.push(local, name, packed);
    dir.push(central, name);
    at += 30 + name.length + packed.length;
  }
  const dirBytes = Buffer.concat(dir);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dirBytes.length, 12);
  end.writeUInt32LE(at, 16);
  return new Uint8Array(Buffer.concat([...parts, dirBytes, end]));
}

test('a cartridge file is taken as it is, under its own name', async () => {
  const r = await romFrom('/Users/me/Games/Pad Test (E).md', rom());
  assert.ok(r.ok);
  assert.equal(r.rom.name, 'Pad Test (E).md');
  assert.equal(r.rom.bytes.length, 65536);
});

test('a zip gives the cartridge inside it, deflated or stored, past whatever else is in there', async () => {
  for (const store of [false, true]) {
    const z = zip([
      { name: 'readme.txt', bytes: new TextEncoder().encode('hello') },
      { name: 'folder/Pad Test.gen', bytes: rom(), store },
    ]);
    assert.deepEqual(zipEntries(z).map((e) => e.name), ['readme.txt', 'folder/Pad Test.gen']);
    const r = await romFrom('games.zip', z);
    assert.ok(r.ok, store ? 'stored' : 'deflated');
    assert.equal(r.rom.name, 'Pad Test.gen');
    assert.deepEqual(Buffer.from(r.rom.bytes), buildTestRom());
  }
});

test('what is not a cartridge says why', async () => {
  const text = new TextEncoder().encode('x'.repeat(5000));
  const notRom = await romFrom('notes.txt', text);
  assert.ok(!notRom.ok && /not a cartridge file/.test(notRom.why));
  const empty = await romFrom('games.zip', zip([{ name: 'readme.txt', bytes: text }]));
  assert.ok(!empty.ok && /no Mega Drive cartridge inside/.test(empty.why));
  const tiny = await romFrom('tiny.md', new Uint8Array(100));
  assert.ok(!tiny.ok && /too small/.test(tiny.why));
  const huge = await romFrom('huge.bin', new Uint8Array(17 * 1024 * 1024));
  assert.ok(!huge.ok && /too large/.test(huge.why));
  const broken = zip([{ name: 'a.md', bytes: rom() }]);
  broken.fill(0xff, 40, 400);
  const damaged = await romFrom('broken.zip', broken);
  assert.ok(!damaged.ok && /could not be opened/.test(damaged.why));
});

test('a game is named by what its cartridge says, and by its file where the cartridge says nothing', () => {
  assert.equal(titleOf({ name: 'whatever.md', bytes: rom() }), 'Orchestrator Pad Test');
  // No header (a Master System cartridge, or an interleaved dump): the file's name, without what is in brackets.
  const blank = new Uint8Array(4096);
  assert.equal(titleOf({ name: 'Alex_Kidd (Europe) [!].sms', bytes: blank }), 'Alex Kidd');
  // A header that names nothing.
  const noName = rom();
  noName.fill(0x20, 0x120, 0x180);
  assert.equal(titleOf({ name: 'Mystery Game.bin', bytes: noName }), 'Mystery Game');
  // A name the cartridge wrote in mixed case is left as it is.
  const mixed = rom();
  mixed.fill(0x20, 0x150, 0x180);
  mixed.set(new TextEncoder().encode('Sonic The Hedgehog'), 0x150);
  assert.equal(titleOf({ name: 'x.md', bytes: mixed }), 'Sonic The Hedgehog');
});

test('the same cartridge is the same game whatever the file was called; another cartridge is another', async () => {
  const a = await romId(rom());
  const other = rom();
  other[0x300] ^= 1;
  assert.equal(a, await romId(rom()));
  assert.notEqual(a, await romId(other));
  assert.match(a, /^[0-9a-f]{40}$/);
});
