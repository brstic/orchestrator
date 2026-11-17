/**
 * The office's own figure and furniture, without the office: for a page that wants to show them outside the scene
 * (the entrance page a browser gets before anybody is signed in — `apps/desktop/src/entrance/`, `docs/ENTRANCE-PAGE.md`).
 * Nothing here knows about sessions, tasks or the server; these are the same models and the same moving body the
 * office draws, so whatever changes there changes here.
 */
export { Character, type Motion, type PoseName } from './Character.tsx';
export { CEO_LOOK, defaultLook, filledLook } from './looks.ts';
export { IRIS } from './character/head.ts';
export { Model } from './models/Model.tsx';
export { DESK_TOP, desk, divider, lampDome, taskChair } from './models/workplace.ts';
export { arcade, coffeeTable, deskPlant, floorLamp, mug, notebook, plant, rug, sofa, trophyCase } from './models/decor.ts';
export { hifi } from './models/rooms.ts';
