import type * as THREE from 'three';
import type { Quality } from '../types.ts';
import type { Box } from '../world.ts';
import type { SkyLook } from './kit.ts';

/** What a place is given to be built from. */
export interface PlaceInput {
  /** The building itself, without members' rooms: it does not change while people come and go. */
  building: Box;
  /** The way in from outside: the middle of the door, on the building's south wall. */
  entrance: { x: number; z: number };
  quality: Quality;
}

/** A place, built: something to put into the scene, to move with the time, and to let go of. */
export interface Place {
  group: THREE.Object3D;
  /** Called before every frame with the scene's time in seconds. */
  update?(time: number, camera: THREE.Camera): void;
  /** Told where there is a roof — the building and every member's room, as one rectangle — when that changes: what falls from the sky stays out of it. */
  setFloor?(floor: Box): void;
  dispose(): void;
}

/** What stands directly under and around the floor (a terrace, a deck, a platform): made again when the floor grows. */
export interface Footing {
  group: THREE.Object3D;
  update?(time: number): void;
  dispose(): void;
}

/** The light a place puts the office in, and the air it is seen through. */
export interface PlaceLook {
  sky: SkyLook;
  /** Colour, where it starts and where nothing is seen any more (metres). */
  fog: [string, number, number];
  /** How far the camera sees. */
  far: number;
  /** Light from above and from below, and how much. */
  hemisphere: [string, string, number];
  sun: { color: string; intensity: number; position: [number, number, number] };
  fill: { color: string; intensity: number };
}
