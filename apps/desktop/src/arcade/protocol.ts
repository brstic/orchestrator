/**
 * What the arcade window and the console say to each other. The console is the emulator, and it runs in a frame of
 * its own with nothing of the office in reach (docs/ARCADE.md): everything it is given and everything it gives back
 * crosses here, as messages.
 */

/** A Mega Drive control pad's buttons. */
export const PAD_BUTTONS = ['up', 'down', 'left', 'right', 'a', 'b', 'c', 'x', 'y', 'z', 'start', 'mode'] as const;
export type PadButton = (typeof PAD_BUTTONS)[number];
export type Player = 1 | 2;

/** The page the console lives on, beside the app's own files (the only place the office's door lets a file through). */
export const FRAME_PAGE = 'assets/arcade.html';

export type ToConsole =
  /** Switch on: the core, the cartridge, and what was kept of it from last time. */
  | { t: 'boot'; core: { js: ArrayBuffer; wasm: ArrayBuffer }; rom: { name: string; bytes: ArrayBuffer }; sram?: ArrayBuffer; state?: ArrayBuffer; sound: boolean }
  | { t: 'pad'; player: Player; button: PadButton; down: boolean }
  | { t: 'pause' }
  | { t: 'resume' }
  | { t: 'reset' }
  | { t: 'sound'; on: boolean }
  /** Hand back what is worth keeping; `state` asks for the exact moment as well as the cartridge's own memory. */
  | { t: 'keep'; id: number; state: boolean }
  | { t: 'restore'; state: ArrayBuffer };

export type FromConsole =
  | { t: 'hello' }
  | { t: 'running' }
  | { t: 'failed'; message: string }
  | { t: 'kept'; id: number; sram?: ArrayBuffer; state?: ArrayBuffer; shot?: ArrayBuffer }
  /**
   * Where the console's sound stands: `on` (it plays), `waiting` (the browser holds it back until the page has been
   * clicked), `none` (the core opened no sound at all).
   */
  | { t: 'sound'; state: SoundState };

export type SoundState = 'on' | 'waiting' | 'none';
