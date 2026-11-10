/**
 * For a picture that lies on a surface — a screen on its casing, a board in its frame, a sign on the floor.
 * The two are only millimetres apart, and seen from across the office the depth buffer can no longer tell
 * which is in front: the picture then flickers darker and lighter with every small move of the camera.
 * These material settings draw the picture as if it were a hair nearer, at any distance.
 */
export const ON_SURFACE = { polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -24 } as const;
