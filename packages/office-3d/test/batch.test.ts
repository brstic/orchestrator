import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PartBatcher, batchable, finishKey } from '../src/part-batch.ts';

const person = (color: string, x: number, geo: THREE.BufferGeometry, mirror = false) => {
  const root = new THREE.Group();
  root.position.x = x;
  const hand = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.6 }));
  hand.position.y = 1;
  if (mirror) hand.scale.x = -1;
  root.add(hand);
  return { root, hand };
};

const view = () => {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 1, 10);
  camera.updateMatrixWorld();
  return camera;
};

test('the same part of different people is drawn in one draw, each in their own colour, and looks as it did', () => {
  const scene = new THREE.Scene();
  const geo = new THREE.BoxGeometry(0.1, 0.1, 0.1);
  const a = person('#ff0000', -1, geo);
  const b = person('#00ff00', 1, geo);
  scene.add(a.root, b.root);
  const batcher = new PartBatcher(scene);
  batcher.scan(a.root);
  batcher.scan(b.root);
  scene.updateMatrixWorld();
  batcher.update(view());
  assert.deepEqual(batcher.stats(), { parts: 2, groups: 1, drawn: 2 });
  assert.equal(a.hand.visible, false, 'the part itself is not drawn any more');
  const im = scene.getObjectByName('part-batches')!.children[0] as THREE.InstancedMesh;
  assert.equal(im.count, 2);
  assert.equal((im.material as THREE.MeshStandardMaterial).color.getHex(), 0xffffff, 'a white copy: the colour is the instance’s');
  const m = new THREE.Matrix4();
  im.getMatrixAt(0, m);
  assert.deepEqual(m.elements, a.hand.matrixWorld.elements, 'where the part is');
  const c = new THREE.Color();
  im.getColorAt(1, c);
  assert.equal(c.getHex(), (b.hand.material as THREE.MeshStandardMaterial).color.getHex(), 'its own colour');
  // Gone: drawn by itself again (and out of the batch).
  batcher.drop(a.root);
  batcher.update(view());
  assert.equal(a.hand.visible, true);
  assert.deepEqual(batcher.stats(), { parts: 1, groups: 1, drawn: 1 });
  batcher.dispose();
  assert.equal(b.hand.visible, true, 'let go of all, the parts are drawn as before');
  assert.equal(scene.getObjectByName('part-batches'), undefined);
});

test('out of view, hidden with what it hangs from, or mirrored: not drawn as an instance', () => {
  const scene = new THREE.Scene();
  const geo = new THREE.BoxGeometry(0.1, 0.1, 0.1);
  const near = person('#ff0000', 0, geo);
  const far = person('#ff0000', 0, geo);
  far.root.position.z = 200;
  const hidden = person('#ff0000', 0.5, geo);
  hidden.root.visible = false;
  const mirrored = person('#ff0000', -0.5, geo, true);
  scene.add(near.root, far.root, hidden.root, mirrored.root);
  const batcher = new PartBatcher(scene);
  for (const p of [near, far, hidden, mirrored]) batcher.scan(p.root);
  scene.updateMatrixWorld();
  batcher.update(view());
  assert.equal(batcher.stats().drawn, 1);
  assert.equal(mirrored.hand.visible, true, 'drawn by itself (an instance would be inside out)');
  batcher.dispose();
});

test('what can be drawn together: plain opaque meshes with one standard material, and only with the same finish', () => {
  const geo = new THREE.BoxGeometry();
  const std = (o: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial(o);
  assert.equal(batchable(new THREE.Mesh(geo, std())), true);
  assert.equal(batchable(new THREE.Mesh(geo, [std(), std()])), false, 'several materials');
  assert.equal(batchable(new THREE.Mesh(geo, std({ transparent: true }))), false);
  assert.equal(batchable(new THREE.Mesh(geo, new THREE.MeshBasicMaterial())), false);
  assert.equal(batchable(new THREE.SkinnedMesh(geo, std())), false);
  const own = new THREE.Mesh(geo, std());
  own.userData.own = true;
  assert.equal(batchable(own), false, 'shown and hidden by the character itself');
  const bent = new THREE.BoxGeometry();
  bent.morphAttributes.position = [bent.attributes.position!.clone()];
  assert.equal(batchable(new THREE.Mesh(bent, std())), false, 'bent by morph targets');
  assert.equal(finishKey(std({ color: '#ff0000', roughness: 0.5 })), finishKey(std({ color: '#0000ff', roughness: 0.5 })), 'the colour does not count');
  assert.notEqual(finishKey(std({ roughness: 0.5 })), finishKey(std({ roughness: 0.6 })));
  assert.notEqual(finishKey(std({ emissive: '#100000' })), finishKey(std()));
});
