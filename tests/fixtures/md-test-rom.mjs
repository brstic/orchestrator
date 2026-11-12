#!/usr/bin/env node
/**
 * A Mega Drive cartridge of our own, for tests: it shows what both control pads hold as the colour of the whole
 * screen. Nothing of anybody's game is in it; the program below is the whole of it, assembled here by hand.
 *
 *   red   (one of 8 levels) = pad 1: A = 1, B = 2, C = 4
 *   green (one of 8 levels) = pad 2: A = 1, B = 2, C = 4
 *   blue  (one of 8 levels) = 4 (the cartridge runs) + pad 1 Start = 1 + pad 2 Start = 2
 *
 * So nothing held is a dark blue screen, and `padsOf(r, g, b)` reads a pixel back into what was held.
 *
 *   node tests/fixtures/md-test-rom.mjs out.md     writes the cartridge to a file
 */
import fs from 'node:fs';

const w = (...words) => words.flatMap((x) => [(x >> 8) & 0xff, x & 0xff]);
const l = (x) => [(x >>> 24) & 0xff, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff];

const VDP_CTRL = 0xc00004;
const VDP_DATA = 0xc00000;
const PAD1 = 0xa10003;
const PAD2 = 0xa10005;

/** One pad read into d0 (TH high: C and B in bits 5, 4) and d1 (TH low: Start and A in bits 5, 4), pressed = 1. */
const readPad = (an) => {
  const moveImm = an === 2 ? 0x14bc : 0x16bc; // move.b #imm,(a2|a3)
  const toD0 = an === 2 ? 0x1012 : 0x1013; // move.b (a2|a3),d0
  const toD1 = an === 2 ? 0x1212 : 0x1213; // move.b (a2|a3),d1
  return [
    ...w(moveImm, 0x0040, 0x4e71, 0x4e71, toD0, 0x4600, 0x0240, 0x0030), // TH high; nop; nop; read; not.b d0; andi.w #$30,d0
    ...w(moveImm, 0x0000, 0x4e71, 0x4e71, toD1, 0x4601, 0x0241, 0x0030), // TH low;  nop; nop; read; not.b d1; andi.w #$30,d1
  ];
};

export function buildTestRom() {
  const START = 0x200;
  const code = [
    ...w(0x46fc, 0x2700), // move.w #$2700,sr
    ...w(0x23fc), ...l(0x53454741), ...l(0xa14000), // move.l #'SEGA',$A14000 (a console with a licence screen wants it)
    ...w(0x41f9), ...l(VDP_CTRL), // lea VDP_CTRL,a0
    ...w(0x43f9), ...l(VDP_DATA), // lea VDP_DATA,a1
    ...w(0x45f9), ...l(PAD1), // lea PAD1,a2
    ...w(0x47f9), ...l(PAD2), // lea PAD2,a3
    ...w(0x30bc, 0x8004), // reg 0: no horizontal interrupt
    ...w(0x30bc, 0x8144), // reg 1: display on, mode 5, no vertical interrupt
    ...w(0x30bc, 0x8200), // reg 2: plane A at 0
    ...w(0x30bc, 0x8400), // reg 4: plane B at 0
    ...w(0x30bc, 0x8700), // reg 7: the backdrop is colour 0
    ...w(0x30bc, 0x8c81), // reg 12: 40 cells wide
    ...w(0x30bc, 0x8f02), // reg 15: the address steps by 2
    ...w(0x30bc, 0x9001), // reg 16: 64 by 32 planes
    // Video memory cleared, so every tile is empty and the backdrop is all that shows.
    ...w(0x20bc), ...l(0x40000000), // move.l #$40000000,(a0)   write to video memory from 0
    ...w(0x3e3c, 0x7fff), // move.w #$7FFF,d7
    ...w(0x4251), // clear: clr.w (a1)
    ...w(0x51cf, 0xfffc), // dbra d7,clear
    // Both pads: TH is an output.
    ...w(0x13fc, 0x0040), ...l(0xa10009), // move.b #$40,$A10009
    ...w(0x13fc, 0x0040), ...l(0xa1000b), // move.b #$40,$A1000B
  ];
  const loopAt = START + code.length;
  const loop = [
    ...readPad(2),
    ...w(0x343c, 0x0800), // move.w #$0800,d2            blue 4: running
    ...w(0xe448, 0x8440), // lsr.w #2,d0 ; or.w d0,d2    B, C -> red 2, 4
    ...w(0x3601, 0x0243, 0x0010, 0xe64b, 0x8443), // move.w d1,d3 ; andi.w #$10,d3 ; lsr.w #3,d3 ; or.w d3,d2   A -> red 1
    ...w(0x0241, 0x0020, 0xe949, 0x8441), // andi.w #$20,d1 ; lsl.w #4,d1 ; or.w d1,d2   Start -> blue 1
    ...readPad(3),
    ...w(0xe548, 0x8440), // lsl.w #2,d0 ; or.w d0,d2    B, C -> green 2, 4
    ...w(0x3601, 0x0243, 0x0010, 0xe34b, 0x8443), // move.w d1,d3 ; andi.w #$10,d3 ; lsl.w #1,d3 ; or.w d3,d2   A -> green 1
    ...w(0x0241, 0x0020, 0xeb49, 0x8441), // andi.w #$20,d1 ; lsl.w #5,d1 ; or.w d1,d2   Start -> blue 2
    ...w(0x20bc), ...l(0xc0000000), // move.l #$C0000000,(a0)    write to colour memory from 0
    ...w(0x3282), // move.w d2,(a1)
  ];
  const back = loopAt - (loopAt + loop.length + 2);
  loop.push(...w(0x6000, back & 0xffff)); // bra.w loop
  const rteAt = loopAt + loop.length;
  const program = [...code, ...loop, ...w(0x4e73)]; // rte: where every interrupt and exception goes

  const rom = Buffer.alloc(0x10000);
  // Vectors: the stack, where to start, and everything else to the `rte`.
  rom.writeUInt32BE(0x00fffe00, 0);
  rom.writeUInt32BE(START, 4);
  for (let v = 2; v < 64; v++) rom.writeUInt32BE(rteAt, v * 4);
  const text = (at, s, len) => rom.write(s.padEnd(len, ' ').slice(0, len), at, 'latin1');
  text(0x100, 'SEGA MEGA DRIVE', 16);
  text(0x110, '(C)ORCH 2026.NOV', 16);
  text(0x120, 'ORCHESTRATOR PAD TEST', 48);
  text(0x150, 'ORCHESTRATOR PAD TEST', 48);
  text(0x180, 'GM 00000000-00', 14);
  text(0x190, 'J', 16);
  rom.writeUInt32BE(0, 0x1a0);
  rom.writeUInt32BE(rom.length - 1, 0x1a4);
  rom.writeUInt32BE(0x00ff0000, 0x1a8);
  rom.writeUInt32BE(0x00ffffff, 0x1ac);
  text(0x1b0, '', 64);
  text(0x1f0, 'JUE', 16);
  Buffer.from(program).copy(rom, START);
  // The checksum the header carries: the sum of every word from $200.
  let sum = 0;
  for (let i = 0x200; i < rom.length; i += 2) sum = (sum + rom.readUInt16BE(i)) & 0xffff;
  rom.writeUInt16BE(sum, 0x18e);
  return rom;
}

/**
 * What a pixel of the test cartridge's picture says is held. A channel has 8 levels; the core draws them as
 * 0, 33, 66, 99, 140, 173, 206, 239 (through 5 bits a channel), so the scale's top is 240, not 255.
 */
export function padsOf(r, g, b) {
  const level = (c) => Math.min(7, Math.round((c / 240) * 7));
  const [R, G, B] = [level(r), level(g), level(b)];
  const pad = (x, start) => ({ a: !!(x & 1), b: !!(x & 2), c: !!(x & 4), start });
  return { running: !!(B & 4), p1: pad(R, !!(B & 1)), p2: pad(G, !!(B & 2)) };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()) && process.argv[2]) {
  fs.writeFileSync(process.argv[2], buildTestRom());
  console.log(`wrote ${process.argv[2]}`);
}
