/**
 * A material drawn on instanced copies (or on a shape that bends by morph targets) gets a twin of its own.
 *
 * three.js keeps one shader per material and checks, at every draw, whether the object in hand needs a different one
 * (instanced or not, receiving shadows or not…). A material shared by an instanced mesh and a plain one is switched
 * back and forth on every frame, and every switch recomputes what the shader needs — in a busy office about ninety
 * times a frame, a part of every frame for nothing. The twin draws the same: it shares the original's colours (the
 * same objects, so a colour changed on the original changes on it too), its pictures and everything else as it was.
 */
import * as THREE from 'three';

const twins = new WeakMap<THREE.Material, Map<string, THREE.Material>>();

/** The twin of `material` for one kind of mesh (`variant`): made once, then the same one. */
export function twin<M extends THREE.Material>(material: M, variant: string): M {
  let kinds = twins.get(material);
  if (!kinds) twins.set(material, (kinds = new Map()));
  let t = kinds.get(variant) as M | undefined;
  if (!t) {
    t = material.clone() as M;
    t.name = `${material.name || material.type} (${variant})`;
    const from = material as unknown as Record<string, unknown>;
    const to = t as unknown as Record<string, unknown>;
    for (const k of ['color', 'emissive', 'specular', 'sheenColor', 'attenuationColor']) if (from[k] instanceof THREE.Color) to[k] = from[k];
    kinds.set(variant, t);
  }
  return t;
}

export const instancedTwin = <M extends THREE.Material>(material: M): M => twin(material, 'instanced');

/** What instanced copies cast their shadow with (the shadow's own default is shared by every other kind of mesh). */
export const INSTANCED_DEPTH = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
/** What a shape that bends by morph targets (a hem over the thighs) casts its shadow with. */
export const MORPH_DEPTH = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });

/**
 * The material (and shadow) for a mesh of this geometry: a twin of its own when the geometry bends by morph targets, so
 * that the same cloth on a sleeve and on a hem is not switched between two shaders at every draw.
 */
export function bentProps<M extends THREE.Material>(geometry: THREE.BufferGeometry, material: M): { material: M; customDepthMaterial?: THREE.Material } {
  return geometry.morphAttributes.position ? { material: twin(material, 'morph'), customDepthMaterial: MORPH_DEPTH } : { material };
}
