import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';

/**
 * The office is drawn into a picture of its own (a multisampled render target), and that picture is put on the
 * screen in one piece.
 *
 * Why (2026-11-17, the owner: "the 3D still flickers a lot"): drawn straight into the canvas with the browser's own
 * antialiasing, the edges of the picture were not the same from one frame to the next even when nothing moved — the
 * same scene drawn six times in a row gave six pictures that differed by 2 000–9 000 pixels, all on edges. Measured
 * on composited frames (what reaches the screen), standing still in the city with people and their name tags in
 * view: one frame in five came out different and back again, up to 59 000 pixels at once (every edge of the
 * building against the sky, the glass, the screens). Drawn into a render target the same scene gives the same
 * picture every time, to the pixel, with or without multisampling; the name tags over the canvas then change
 * nothing. With this: 0 such frames of 148 (at most 6 pixels). `docs/DEVELOPMENT.md`, "Flicker".
 *
 * The canvas is created without antialiasing (the multisampling is here); `samples` 0 on Low, as before.
 * The picture is kept in half floats where the GPU can draw into them (no banding in dark gradients before the
 * tone mapping), else in sRGB bytes. Tone mapping and the output colour space are applied when it is put on the
 * screen, exactly as three applies them when drawing straight to the canvas.
 */
export function StableFrame({ samples }: { samples: number }) {
  const { gl, scene, camera } = useThree();
  const target = useMemo(() => {
    const float = gl.capabilities.isWebGL2 && gl.extensions.has('EXT_color_buffer_float');
    const t = new THREE.WebGLRenderTarget(1, 1, { samples, type: float ? THREE.HalfFloatType : THREE.UnsignedByteType, depthBuffer: true });
    if (!float) t.texture.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, [gl, samples]);
  const blit = useMemo(() => {
    const material = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: 'varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'uniform sampler2D tDiffuse;\nvarying vec2 vUv;\nvoid main() {\n  gl_FragColor = texture2D(tDiffuse, vUv);\n  #include <tonemapping_fragment>\n  #include <colorspace_fragment>\n}',
      depthTest: false,
      depthWrite: false,
      toneMapped: true,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    quad.frustumCulled = false;
    const quadScene = new THREE.Scene();
    quadScene.add(quad);
    return { scene: quadScene, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), material, geometry: quad.geometry };
  }, []);
  useEffect(() => () => target.dispose(), [target]);
  useEffect(
    () => () => {
      blit.material.dispose();
      blit.geometry.dispose();
    },
    [blit],
  );
  // What a frame cost (draw calls, triangles: `window.__orchPerf`) is counted over both draws, not only the last.
  useEffect(() => {
    const was = gl.info.autoReset;
    gl.info.autoReset = false;
    return () => {
      gl.info.autoReset = was;
    };
  }, [gl]);
  const size = useMemo(() => new THREE.Vector2(), []);
  // A priority above 0: this draws the frame, instead of the canvas drawing it by itself.
  useFrame(() => {
    gl.info.reset();
    gl.getDrawingBufferSize(size);
    if (target.width !== size.x || target.height !== size.y) target.setSize(size.x, size.y);
    gl.setRenderTarget(target);
    gl.render(scene, camera);
    gl.setRenderTarget(null);
    blit.material.uniforms.tDiffuse!.value = target.texture;
    gl.render(blit.scene, blit.camera);
  }, 1);
  return null;
}
