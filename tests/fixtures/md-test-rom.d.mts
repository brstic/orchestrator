/** The test cartridge (see md-test-rom.mjs). */
export function buildTestRom(): Buffer;
interface Pad {
  a: boolean;
  b: boolean;
  c: boolean;
  start: boolean;
}
export function padsOf(r: number, g: number, b: number): { running: boolean; p1: Pad; p2: Pad };
