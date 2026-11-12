import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { Surroundings as Kind } from '@orchestrator/contracts';
import type { Quality } from '../types.ts';
import type { Box, World } from '../world.ts';
import { skyMaterial } from './kit.ts';
import { plateOf } from './windows.ts';
import type { Footing, Place, PlaceInput, PlaceLook } from './place.ts';
import { ISLAND_SUN, buildDeck, buildIsland } from './island.ts';
import { NORTH_MOON, buildNorth } from './north.ts';
import { ORBIT_SUN, buildOrbit, buildStationDeck } from './orbit.ts';
import { buildPark } from './park.ts';
import { buildSkyline, buildTower } from './skyline.ts';

export { glazed, plateOf } from './windows.ts';
export type { PlaceLook } from './place.ts';

/** The office by itself, as it was before it could stand anywhere: dark all round. */
export const STUDIO = { background: '#0d1118', fog: ['#0d1118', 70, 170] as [string, number, number], far: 260 };

type Built = Exclude<Kind, 'studio'>;

interface PlaceDef {
  look: PlaceLook;
  build(input: PlaceInput): Place;
  /** What the floor stands on, for a floor of this size. */
  footing?(plate: Box): Footing;
}

const PLACES: Partial<Record<Built, PlaceDef>> = {
  skyline: {
    look: {
      sky: { zenith: '#080d2a', mid: '#3a2d6e', horizon: '#a8627e', ground: '#2a2440', midAt: 0.3, sun: [-1, -0.02, -0.35], sunColor: '#ffb07a', halo: 0.5, glow: '#ff7a3c', glowAmount: 0.85, stars: 0.55, clouds: 0.34, cloudLit: '#ff9a7e', cloudShade: '#3d3260', wind: 0.6 },
      fog: ['#7a5074', 140, 1050],
      far: 1900,
      hemisphere: ['#d5ccff', '#4a4658', 0.82],
      sun: { color: '#ffd9b4', intensity: 1.95, position: [16, 30, 18] },
      fill: { color: '#a9b4ff', intensity: 0.55 },
    },
    build: buildSkyline,
    footing: buildTower,
  },
  park: {
    look: {
      sky: { zenith: '#2a66c8', mid: '#69a5e6', horizon: '#cfe5f6', ground: '#8fb07a', midAt: 0.34, sun: [0.5, 0.78, 0.38], sunColor: '#fff4d6', sunSize: 0.032, halo: 0.55, glow: '#ffffff', glowAmount: 0.12, clouds: 0.52, cloudLit: '#ffffff', cloudShade: '#b5c4d8', wind: 1 },
      fog: ['#c9e0f2', 170, 1000],
      far: 1900,
      hemisphere: ['#e6f2ff', '#72855c', 0.95],
      sun: { color: '#fff3d8', intensity: 2.25, position: [20, 31, 15] },
      fill: { color: '#cfe2ff', intensity: 0.5 },
    },
    build: buildPark,
  },
  island: {
    look: {
      sky: { zenith: '#22387a', mid: '#b85f8e', horizon: '#ffb070', ground: '#5a5f86', midAt: 0.24, sun: ISLAND_SUN, sunColor: '#ffe0a8', sunSize: 0.05, halo: 0.95, glow: '#ff8c3a', glowAmount: 0.75, stars: 0.2, clouds: 0.44, cloudLit: '#ffb690', cloudShade: '#6b4b7c', wind: 0.8 },
      fog: ['#e2a58c', 260, 1700],
      far: 2800,
      hemisphere: ['#ffe2cc', '#5c5068', 0.86],
      sun: { color: '#ffc893', intensity: 2.0, position: [-26, 17, 10] },
      fill: { color: '#b9a8ff', intensity: 0.5 },
    },
    build: buildIsland,
    footing: buildDeck,
  },
  north: {
    look: {
      sky: { zenith: '#040816', mid: '#0a1832', horizon: '#1d3c5c', ground: '#0c1626', midAt: 0.36, sun: NORTH_MOON, sunColor: '#e6eeff', sunSize: 0.021, halo: 0.22, glow: '#2f6a6a', glowAmount: 0.25, stars: 1, aurora: 1 },
      fog: ['#16283f', 240, 1700],
      far: 2800,
      hemisphere: ['#c6d6ff', '#3c4658', 0.82],
      sun: { color: '#e3ecff', intensity: 1.85, position: [16, 30, 18] },
      fill: { color: '#86e2c2', intensity: 0.5 },
    },
    build: buildNorth,
  },
  orbit: {
    look: {
      sky: { zenith: '#010208', mid: '#02030b', horizon: '#03050f', ground: '#02030a', midAt: 0.4, sun: ORBIT_SUN, sunColor: '#fff8ea', sunSize: 0.013, halo: 0.55, stars: 1, galaxy: 0.6 },
      // No air: nothing fades with distance.
      fog: ['#02030a', 6000, 12000],
      far: 2600,
      hemisphere: ['#e2e8ff', '#3a4252', 0.8],
      sun: { color: '#ffffff', intensity: 2.25, position: [22, 26, 18] },
      fill: { color: '#86b6ff', intensity: 0.6 },
    },
    build: buildOrbit,
    footing: buildStationDeck,
  },
};

/** The light the office stands in: its place's, or the plain one. */
export function lookOf(kind: Kind): PlaceLook | null {
  return kind === 'studio' ? null : (PLACES[kind]?.look ?? null);
}

/** Does this place put windows into the outer walls? Every place but the plain one. */
export function hasWindows(kind: Kind): boolean {
  return lookOf(kind) !== null;
}

/**
 * The time a place moves by. A measuring aid stops it: with `window.__orchScene.still = true` everything outside
 * stands still — cars, water, clouds, snow — so that a flicker check (`DEVELOPMENT.md`) counts only what shimmers
 * by mistake, not what moves on purpose.
 */
let stoppedAt: number | null = null;
function timeNow(elapsed: number): number {
  const still = (window as unknown as { __orchScene?: { still?: boolean } }).__orchScene?.still === true;
  if (!still) stoppedAt = null;
  else stoppedAt ??= elapsed;
  return stoppedAt ?? elapsed;
}

function Sky({ look }: { look: PlaceLook['sky'] }) {
  const material = useMemo(() => skyMaterial(look), [look]);
  const geometry = useMemo(() => new THREE.SphereGeometry(1, 48, 24), []);
  useEffect(() => () => material.dispose(), [material]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useFrame(({ clock }) => {
    material.uniforms.uTime!.value = timeNow(clock.elapsedTime);
  });
  // Drawn after everything solid, where nothing else was: the sky costs only the pixels that show it.
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={900} />;
}

/**
 * Where the office stands (`OwnerSettings.surroundings`): the sky, the air, and the place itself around the building.
 * The plain one draws nothing and leaves the scene as it always was.
 */
export function Surroundings({ kind, world, quality }: { kind: Kind; world: World; quality: Quality }) {
  const { scene, camera } = useThree();
  const def = kind === 'studio' ? undefined : PLACES[kind];

  useLayoutEffect(() => {
    const fog = def?.look.fog ?? STUDIO.fog;
    scene.background = new THREE.Color(def ? fog[0] : STUDIO.background);
    scene.fog = new THREE.Fog(fog[0], fog[1], fog[2]);
    const cam = camera as THREE.PerspectiveCamera;
    cam.far = def?.look.far ?? STUDIO.far;
    cam.updateProjectionMatrix();
  }, [def, scene, camera]);

  const building = world.base.bounds;
  const entranceX = world.spawn.x;
  const place = useMemo(() => def?.build({ building, entrance: { x: entranceX, z: building.maxZ }, quality }) ?? null, [def, building, entranceX, quality]);
  useEffect(() => () => place?.dispose(), [place]);

  const plate = plateOf(world);
  const plateKey = `${plate.minX}:${plate.maxX}:${plate.minZ}:${plate.maxZ}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const footing = useMemo(() => def?.footing?.(plate) ?? null, [def, plateKey]);
  useEffect(() => () => footing?.dispose(), [footing]);

  const roofed = world.bounds;
  useEffect(() => place?.setFloor?.(roofed), [place, roofed]);

  useFrame(({ clock, camera: cam }) => {
    const t = timeNow(clock.elapsedTime);
    place?.update?.(t, cam);
    footing?.update?.(t);
  });

  if (!def || !place) return null;
  return (
    <>
      <Sky look={def.look.sky} />
      <primitive object={place.group} />
      {footing && <primitive object={footing.group} />}
    </>
  );
}
