import * as THREE from 'three';
import { INSTANCED_DEPTH } from './twins.ts';

/**
 * People's rigid parts drawn together: every hand of everybody in one draw, every shoe in another, and so on.
 *
 * Why (2026-11-20, a colleague's MacBook Air overheated with the office open): two thirds of what the office draws
 * are people — about 24 parts each, every one its own draw — and what a frame costs the computer goes with the number of
 * draws (three.js's own work for each, and the browser's GPU process passing each one on). The same part of different
 * people is the same shape with the same finish; only the colour differs. Drawn as instances of one mesh, with each
 * person's colour as the instance's colour (multiplied with a white copy of the material: the same colour, to the
 * bit), it looks the same and costs one draw.
 *
 * The parts themselves stay where they are — moved by the character's own animation, clickable as before (three's
 * raycasting does not look at `visible`) — they are only not drawn (`visible` false); each frame their world matrices
 * and colours are copied into the instances. A part is batched when it is a plain mesh (not skinned, not bent by morph
 * targets) with one `MeshStandardMaterial`, opaque, not mirrored; everything else is drawn as before. A part marked
 * `userData.own` (shown and hidden by the character itself: the coiled whip, the lash) is left alone.
 *
 * Only inside `<PartBatches>` (the office): the character creator and the other small stages draw characters as before.
 */
export interface Batcher {
  /** Looks at the parts under `root` again (after the character rendered: a part may have come, gone or changed). */
  scan(root: THREE.Object3D): void;
  /** The character under `root` is gone: its parts are let go of. */
  drop(root: THREE.Object3D): void;
}

interface Part {
  mesh: THREE.Mesh;
  root: THREE.Object3D;
  group: Group;
}

interface Group {
  key: string;
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
  parts: Part[];
  mesh: THREE.InstancedMesh | null;
  capacity: number;
  /** A shadow is cast: the part counts as in view a little further out (its shadow may be). */
  cast: boolean;
}

/** How far out of view a part that casts a shadow is still drawn: a person's shadow falls up to ~1.6 m away from them under the sun. */
const SHADOW_REACH = 2;

const hex = (c: THREE.Color | undefined) => (c ? c.getHexString() : '-');
const uid = (t: THREE.Texture | null | undefined) => (t ? t.uuid : '-');

/** Everything about a material but its colour: parts whose materials say the same here can be drawn together. */
export function finishKey(m: THREE.MeshStandardMaterial): string {
  return [
    m.type,
    m.roughness,
    m.metalness,
    uid(m.map),
    uid(m.bumpMap),
    m.bumpScale,
    uid(m.normalMap),
    uid(m.roughnessMap),
    uid(m.emissiveMap),
    hex(m.emissive),
    m.emissiveIntensity,
    m.vertexColors ? 1 : 0,
    m.envMapIntensity,
    uid(m.envMap),
    m.polygonOffset ? `${m.polygonOffsetFactor}/${m.polygonOffsetUnits}` : 0,
    m.side,
    m.flatShading ? 1 : 0,
    m.toneMapped ? 1 : 0,
    m.fog ? 1 : 0,
    m.depthTest ? 1 : 0,
    m.depthWrite ? 1 : 0,
    m.colorWrite ? 1 : 0,
    m.alphaTest,
    m.visible ? 1 : 0,
  ].join('|');
}

/** Whether a mesh can be drawn as an instance of others like it (see above). */
export function batchable(o: THREE.Object3D): o is THREE.Mesh {
  if (!(o as THREE.Mesh).isMesh || (o as THREE.SkinnedMesh).isSkinnedMesh || (o as THREE.InstancedMesh).isInstancedMesh) return false;
  const mesh = o as THREE.Mesh;
  if (mesh.userData.own) return false;
  const m = mesh.material as THREE.MeshStandardMaterial;
  if (Array.isArray(mesh.material) || !m || m.type !== 'MeshStandardMaterial' || m.transparent || m.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile) return false;
  const g = mesh.geometry;
  if (!g || (g.morphAttributes.position && g.morphAttributes.position.length)) return false;
  if (mesh.customDepthMaterial || mesh.customDistanceMaterial) return false;
  return true;
}

export class PartBatcher implements Batcher {
  private parts = new Map<THREE.Mesh, Part>();
  private byRoot = new Map<THREE.Object3D, Set<Part>>();
  private groups = new Map<string, Group>();
  private holder = new THREE.Group();
  private frustum = new THREE.Frustum();
  private pv = new THREE.Matrix4();
  private sphere = new THREE.Sphere();

  private scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.holder.name = 'part-batches';
    scene.add(this.holder);
  }

  scan(root: THREE.Object3D): void {
    const had = this.byRoot.get(root) ?? new Set<Part>();
    const now = new Set<Part>();
    root.traverse((o) => {
      if (!batchable(o)) return;
      const mesh = o as THREE.Mesh;
      const material = mesh.material as THREE.MeshStandardMaterial;
      const key = `${mesh.geometry.uuid}|${finishKey(material)}|${mesh.castShadow ? 1 : 0}${mesh.receiveShadow ? 1 : 0}`;
      let part = this.parts.get(mesh);
      if (part && part.group.key !== key) {
        this.release(part);
        part = undefined;
      }
      if (!part) {
        const group = this.group(key, mesh, material);
        part = { mesh, root, group };
        group.parts.push(part);
        this.parts.set(mesh, part);
        mesh.visible = false;
      }
      now.add(part);
    });
    // Parts that are no longer there, or no longer like the others, are drawn by themselves again.
    for (const p of had) if (!now.has(p)) this.release(p);
    if (now.size) this.byRoot.set(root, now);
    else this.byRoot.delete(root);
  }

  drop(root: THREE.Object3D): void {
    for (const p of this.byRoot.get(root) ?? []) this.release(p);
    this.byRoot.delete(root);
  }

  private release(p: Part): void {
    if (this.parts.get(p.mesh) !== p) return;
    this.parts.delete(p.mesh);
    const i = p.group.parts.indexOf(p);
    if (i >= 0) p.group.parts.splice(i, 1);
    p.mesh.visible = true;
    this.byRoot.get(p.root)?.delete(p);
  }

  private group(key: string, mesh: THREE.Mesh, material: THREE.MeshStandardMaterial): Group {
    let g = this.groups.get(key);
    if (!g) {
      // A white copy: the colour comes from each instance (the person's own material's colour).
      const white = material.clone();
      white.color.setRGB(1, 1, 1);
      white.name = `${material.name || 'part'} (batched)`;
      g = { key, geometry: mesh.geometry, material: white, parts: [], mesh: null, capacity: 0, cast: mesh.castShadow };
      if (!g.geometry.boundingSphere) g.geometry.computeBoundingSphere();
      this.groups.set(key, g);
    }
    return g;
  }

  /** Room for `n` instances: a mesh twice as big as needed when it runs out (the old one let go of). */
  private sized(g: Group, n: number, cast: boolean, receive: boolean): THREE.InstancedMesh {
    if (g.mesh && g.capacity >= n) return g.mesh;
    if (g.mesh) {
      this.holder.remove(g.mesh);
      g.mesh.dispose();
    }
    const capacity = Math.max(8, n * 2);
    const im = new THREE.InstancedMesh(g.geometry, g.material, capacity);
    im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.instanceColor.setUsage(THREE.DynamicDrawUsage);
    im.castShadow = cast;
    im.receiveShadow = receive;
    im.customDepthMaterial = INSTANCED_DEPTH;
    // Where its instances are changes every frame: culled here, per instance, not by its bounds.
    im.frustumCulled = false;
    im.matrixAutoUpdate = false;
    im.matrixWorldAutoUpdate = false;
    // Clicks go to the parts themselves.
    im.raycast = () => undefined;
    im.name = `batch ${g.material.name}`;
    this.holder.add(im);
    g.mesh = im;
    g.capacity = capacity;
    return im;
  }

  /** Each frame, after the animation and the world matrices: where each part is, its colour, and whether it is in view. */
  update(camera: THREE.Camera): void {
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv);
    for (const g of this.groups.values()) {
      if (!g.parts.length) {
        if (g.mesh) g.mesh.count = 0;
        continue;
      }
      const first = g.parts[0]!.mesh;
      const im = this.sized(g, g.parts.length, first.castShadow, first.receiveShadow);
      const m = im.instanceMatrix.array as Float32Array;
      const c = im.instanceColor!.array as Float32Array;
      const bound = g.geometry.boundingSphere!;
      let n = 0;
      for (const p of g.parts) {
        if (!shown(p.mesh)) continue;
        this.sphere.copy(bound).applyMatrix4(p.mesh.matrixWorld);
        if (g.cast) this.sphere.radius += SHADOW_REACH;
        if (!this.frustum.intersectsSphere(this.sphere)) continue;
        // (A mirrored part would be drawn inside out as an instance: drawn by itself, as before.)
        if (p.mesh.matrixWorld.determinant() < 0) {
          p.mesh.visible = true;
          continue;
        }
        p.mesh.visible = false;
        m.set(p.mesh.matrixWorld.elements, n * 16);
        const col = (p.mesh.material as THREE.MeshStandardMaterial).color;
        c[n * 3] = col.r;
        c[n * 3 + 1] = col.g;
        c[n * 3 + 2] = col.b;
        n++;
      }
      im.count = n;
      im.instanceMatrix.needsUpdate = true;
      im.instanceColor!.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const p of [...this.parts.values()]) this.release(p);
    for (const g of this.groups.values()) {
      g.mesh?.dispose();
      g.material.dispose();
    }
    this.groups.clear();
    this.scene.remove(this.holder);
  }

  /** The parts drawn together (for the check that they look the same drawn by themselves). */
  batched(): THREE.Mesh[] {
    return [...this.parts.keys()];
  }

  /** For the tests and the measurements (`window.__orchScene.batches`): parts batched, draws they take. */
  stats(): { parts: number; groups: number; drawn: number } {
    let drawn = 0;
    for (const g of this.groups.values()) drawn += g.mesh?.count ?? 0;
    return { parts: this.parts.size, groups: [...this.groups.values()].filter((g) => g.parts.length).length, drawn };
  }
}

/** Whether a part would be drawn: it and everything it hangs from shown (the part's own `visible` is the batcher's). */
function shown(mesh: THREE.Object3D): boolean {
  for (let o = mesh.parent; o; o = o.parent) if (!o.visible) return false;
  return true;
}

