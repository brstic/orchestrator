import { ARCADE_BUTTONS, type ArcadeButton } from '@orchestrator/contracts';

/**
 * What the arcade window and the console say to each other. The console is the emulator, and it runs in a frame of
 * its own with nothing of the office in reach (docs/ARCADE.md): everything it is given and everything it gives back
 * crosses here, as messages.
 */

/** A Mega Drive control pad's buttons. */
export const PAD_BUTTONS = ARCADE_BUTTONS;
export type PadButton = ArcadeButton;
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
  | { t: 'restore'; state: ArrayBuffer }
  /**
   * Show the game to others (a table is open): from now on the console hands over what it draws and plays, piece by
   * piece, for the window to pass on. Off again when the table closes.
   */
  | { t: 'cast'; on: boolean };

/** The picture handed over for others is this size, whatever the size of the screen it is drawn on here. */
export const CAST_WIDTH = 640;
export const CAST_HEIGHT = 480;

export type FromConsole =
  | { t: 'hello' }
  | { t: 'running' }
  | { t: 'failed'; message: string }
  | { t: 'kept'; id: number; sram?: ArrayBuffer; state?: ArrayBuffer; shot?: ArrayBuffer }
  /**
   * Where the console's sound stands: `on` (it plays), `waiting` (the browser holds it back until the page has been
   * clicked), `none` (the core opened no sound at all).
   */
  | { t: 'sound'; state: SoundState }
  /** While the game is shown to others: a picture of the screen as it is now… */
  | { t: 'frame'; bitmap: ImageBitmap; ts: number }
  /** …and the sound since the last piece: both channels, as the console plays them (before this window's own volume). */
  | { t: 'pcm'; rate: number; left: ArrayBuffer; right: ArrayBuffer };

export type SoundState = 'on' | 'waiting' | 'none';
