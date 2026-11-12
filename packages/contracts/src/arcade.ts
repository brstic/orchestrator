/**
 * The arcade (docs/ARCADE.md): the games on the office's shelf, and the tables — a game one person is playing that
 * others in the office have been let in on. The one who plays runs the console; the others are sent its picture and
 * sound, and whoever holds the second pad sends their buttons back.
 */

/** A game on the office's shelf: a cartridge file somebody brought. Its id is the SHA-1 of its bytes. */
export interface ArcadeGame {
  id: string;
  title: string;
  /** The cartridge's file name; the console tells the kind of cartridge by its extension. */
  file: string;
  size: number;
  addedAt: string;
  /** Who brought it (a name). */
  addedBy: string;
}

/** Cartridge files the console runs. */
export const ARCADE_EXTENSIONS = ['md', 'gen', 'bin', 'smd', 'sms', 'gg'] as const;
/** No cartridge of these consoles is larger. */
export const ARCADE_MAX_BYTES = 16 * 1024 * 1024;
/** How many games the shelf holds. */
export const ARCADE_MAX_GAMES = 500;
/** A cartridge arrives in pieces of this size at most, so that it passes any proxy in front of the office. */
export const ARCADE_PIECE_BYTES = 384 * 1024;

/** A pad's buttons (a Mega Drive's). */
export const ARCADE_BUTTONS = ['up', 'down', 'left', 'right', 'a', 'b', 'c', 'x', 'y', 'z', 'start', 'mode'] as const;
export type ArcadeButton = (typeof ARCADE_BUTTONS)[number];

/** Somebody at a table: their window in the office, and their name. */
export interface ArcadeSeat {
  id: string;
  name: string;
}

/** A game being played that others may join. The host holds pad 1. */
export interface ArcadeTable {
  /** The host's window: a window hosts one table at most. */
  id: string;
  host: ArcadeSeat;
  title: string;
  gameId: string | null;
  /** Who holds pad 2, if anybody. */
  player2: ArcadeSeat | null;
  watching: ArcadeSeat[];
  since: string;
}

/** How many people may look on at one table (beside the two who play). */
export const ARCADE_MAX_WATCHING = 8;

/**
 * What the host sends for those at its table: `cfg` (how to read what follows: JSON), `v` (a piece of picture; `key`:
 * one that can be shown without the ones before it) and `a` (a piece of sound). `data` is base64.
 */
export type ArcadeMediaKind = 'cfg' | 'v' | 'a';
/** No single piece is larger (as base64). */
export const ARCADE_MEDIA_MAX = 700 * 1024;
/** No host sends more pieces a second than this (60 of picture, 50 of sound, and room). */
export const ARCADE_MEDIA_PER_SECOND = 240;
