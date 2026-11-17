/**
 * My character (`docs/CHARACTER.md`): how I look in the office. Everything about the figure is chosen here — the
 * body, the face, the hair, the clothes and what is worn on the head — with the figure itself turning in front of
 * me as I choose. Saved for me on the server: every window, every computer and every visit draws me so, and
 * everybody in the office sees me so.
 */
import { Canvas, useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { FACIAL_HAIR, HAIR_STYLES, OUTFITS, cleanAppearance, DEFAULT_LOOK, type Appearance, type FacialHair, type HairStyle, type Outfit } from '@orchestrator/contracts';
import { Character, IRIS, Model, defaultLook, filledLook, taskChair, type Motion, type PoseName } from '@orchestrator/office-3d/parts';
import { Button, Tabs, Window } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { useOffice } from '../../lib/store.ts';
import { act, ask } from '../core.tsx';
import { registerPanel } from './index.tsx';
import './character.css';

type Tab = 'body' | 'face' | 'hair' | 'clothes' | 'extras';
type Preview = 'stand' | 'walk' | 'wave' | 'sit';

const SKINS = ['#ffe0c4', '#ffdbac', '#f1c9a5', '#e8b98e', '#e0ac69', '#c68642', '#a86b3c', '#8d5524', '#6e4022', '#4a2a17'];
const HAIRS = ['#0f0f0f', '#241c17', '#2c1b10', '#4a2f1b', '#6b4423', '#a0522d', '#b5651d', '#d6b370', '#e8d5a3', '#6b6b6b', '#b8b8b8', '#f0f0f0'];
const BOLD_HAIR = ['#c2185b', '#7b4dff', '#2f6fb5', '#1aa37a', '#ff6f3c'];
const CLOTH = ['#2b3c66', '#4f8cff', '#3fd0c9', '#5ad67d', '#f5c542', '#ff8c5a', '#ff5d73', '#8f7bff', '#e6d3a3', '#f2f2f0', '#6b6f78', '#1d2027'];
const TROUSERS = ['#1d2027', '#27364a', '#2b3c66', '#3b3f5c', '#4a4238', '#5b4a35', '#6b6f78', '#c9b99a', '#e6e3dc'];
const SHOES = ['#22252c', '#4a3122', '#2b2f3a', '#7a4a2a', '#e6e3dc', '#c0392b'];
const TIES = ['#8f2738', '#a8323e', '#2f6fb5', '#3d7f5a', '#7d55b8', '#d4a017', '#1d2027'];

const HAIR_WORD: Record<HairStyle, string> = { short: 'Short', buzz: 'Buzz cut', long: 'Long', ponytail: 'Ponytail', bun: 'Bun', curly: 'Curly', afro: 'Afro', mohawk: 'Mohawk', bald: 'Bald' };
const OUTFIT_WORD: Record<Outfit, string> = { polo: 'Polo', shirt: 'Shirt', tee: 'T-shirt', sweater: 'Sweater', suit: 'Suit' };
const FACIAL_WORD: Record<FacialHair, string> = { none: 'None', stubble: 'Stubble', mustache: 'Mustache', goatee: 'Goatee', beard: 'Beard' };
const FACE_WORD = ['Soft oval', 'Round', 'Long, firm jaw'];
const BROW_WORD = ['Soft', 'Straight', 'Arched', 'Full', 'Fine'];
const HEAD_WORD: Record<'none' | 'cap' | 'headphones', string> = { none: 'Nothing', cap: 'Cap', headphones: 'Headphones' };

const pick = <T,>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!;

/** A look made up at random from what the creator offers: for "Surprise me". */
function randomLook(): Appearance {
  const outfit = pick(OUTFITS);
  return {
    skin: pick(SKINS),
    hair: Math.random() < 0.12 ? pick(BOLD_HAIR) : pick(HAIRS),
    hairStyle: pick(HAIR_STYLES),
    shirt: pick(CLOTH),
    pants: pick(TROUSERS),
    accessory: pick(['none', 'none', 'cap', 'headphones'] as const),
    glasses: Math.random() < 0.3,
    build: Math.round((0.94 + Math.random() * 0.12) * 100) / 100,
    girth: Math.round((0.95 + Math.random() * 0.11) * 100) / 100,
    outfit,
    face: Math.floor(Math.random() * 3),
    brows: Math.floor(Math.random() * 5),
    eyes: pick(IRIS),
    facialHair: Math.random() < 0.6 ? 'none' : pick(FACIAL_HAIR),
    shoes: pick(SHOES),
    tie: pick(TIES),
  };
}

// ───────────────────────────── the figure ─────────────────────────────

/** Dragged sideways, the figure turns; let go, it stays where it was turned. */
function useTurn(el: React.RefObject<HTMLDivElement | null>) {
  const state = useRef({ angle: 0.35, from: null as number | null, start: 0 });
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const down = (e: PointerEvent) => {
      state.current.from = e.clientX;
      state.current.start = state.current.angle;
      node.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (state.current.from === null) return;
      state.current.angle = state.current.start + (e.clientX - state.current.from) * 0.012;
    };
    const up = () => (state.current.from = null);
    node.addEventListener('pointerdown', down);
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', up);
    return () => {
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', up);
    };
  }, [el]);
  return state;
}

const FLOOR_GEO = new THREE.CircleGeometry(1.25, 64);
const FLOOR = new THREE.MeshStandardMaterial({ color: '#1b2030', roughness: 0.9 });

function Figure({ look, preview, cue, turn, level }: { look: Appearance; preview: Preview; cue: number; turn: { current: { angle: number } }; level: number }) {
  const group = useRef<THREE.Group>(null);
  // Walking on the spot: the legs walk by this, the figure stays where it is.
  const motion = useRef<Motion>({ vx: 0, vz: 0, turn: 0, run: false });
  motion.current.vz = preview === 'walk' ? 1.5 : 0;
  useFrame(() => {
    if (group.current) group.current.rotation.y += (turn.current.angle - group.current.rotation.y) * 0.25;
  });
  const pose: PoseName = preview === 'sit' ? 'idle' : preview === 'wave' ? 'wave' : 'stand';
  return (
    <group ref={group}>
      {preview === 'sit' && <Model model={taskChair()} />}
      <Character appearance={look} pose={pose} cue={cue} level={level} motion={motion} phase={0.4} />
    </group>
  );
}

function Stage({ look, preview, cue, level }: { look: Appearance; preview: Preview; cue: number; level: number }) {
  const wrap = useRef<HTMLDivElement>(null);
  const turn = useTurn(wrap);
  return (
    <div ref={wrap} className="chc-canvas" role="img" aria-label="Your character — drag to turn it">
      <Canvas
        shadows
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true }}
        camera={{ position: [0, 1.05, 3.6], fov: 30, near: 0.1, far: 30 }}
        onCreated={({ gl, camera }) => {
          gl.setClearColor(0x000000, 0);
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.1;
          camera.lookAt(0, 0.92, 0);
        }}
      >
        {/* Lit as a person is lit for a portrait: a key from above to one side, a soft fill from the front, light
            coming back up from the floor — so a face reads as it is (a dark floor left every chin in a beard's shadow). */}
        <hemisphereLight args={['#e6ecff', '#6b6660', 1.05]} />
        <directionalLight position={[2.2, 4, 3]} intensity={2.1} color="#fff4e2" castShadow shadow-mapSize={[1024, 1024]} shadow-bias={-0.0004} />
        <directionalLight position={[-1.2, 1.2, 3.5]} intensity={0.9} color="#fff8ee" />
        <directionalLight position={[-2.5, 2, -2]} intensity={0.6} color="#a9c4ff" />
        <mesh geometry={FLOOR_GEO} material={FLOOR} rotation={[-Math.PI / 2, 0, 0]} receiveShadow />
        <Figure look={look} preview={preview} cue={cue} turn={turn} level={level} />
      </Canvas>
    </div>
  );
}

// ───────────────────────────── choosing ─────────────────────────────

/** A colour: the usual ones as dots, and any other with the last one. */
function Colours({ value, options, onChange, label }: { value: string; options: string[]; onChange: (hex: string) => void; label: string }) {
  const known = options.includes(value.toLowerCase());
  return (
    <div className="chc-swatches" role="radiogroup" aria-label={label}>
      {options.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={value.toLowerCase() === c} aria-label={c} className={`chc-swatch${value.toLowerCase() === c ? ' chc-on' : ''}`} style={{ background: c }} onClick={() => onChange(c)} />
      ))}
      <label className={`chc-swatch chc-any${known ? '' : ' chc-on'}`} title="Any colour" style={known ? undefined : { background: value }}>
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} aria-label={`${label}: any colour`} />
      </label>
    </div>
  );
}

/** One of a few, each a word. */
function Choice<T extends string | number>({ value, options, onChange, label }: { value: T; options: Array<{ id: T; word: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="chc-choices" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.id)} type="button" role="radio" aria-checked={value === o.id} className={`chc-choice${value === o.id ? ' chc-on' : ''}`} onClick={() => onChange(o.id)}>
          {o.word}
        </button>
      ))}
    </div>
  );
}

function Part({ label, note, children }: { label: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="chc-part">
      <div className="k-label">{label}</div>
      {children}
      {note && <div className="k-sub chc-note">{note}</div>}
    </section>
  );
}

function CharacterPanel({ onClose }: { arg: string | null; onClose: () => void }) {
  const me = useOffice((s) => s.me);
  const level = me?.role === 'owner' ? (me.id === 'owner' ? 10 : 9) : 1;
  // What I wear now — what I made, or what the office gives me — with everything written out.
  const office = useMemo(() => filledLook(defaultLook(me?.hue ?? 0, me?.role, me?.id ?? (me?.kind === 'owner' ? 'owner' : null)), level), [me?.hue, me?.role, me?.id, me?.kind, level]);
  const saved = useMemo(() => (me?.look ? filledLook(me.look, level) : null), [me?.look, level]);
  const [look, setLook] = useState<Appearance>(() => saved ?? office);
  const [tab, setTab] = useState<Tab>('body');
  const [preview, setPreview] = useState<Preview>('stand');
  const [cue, setCue] = useState(0);
  const [busy, setBusy] = useState(false);
  const base = saved ?? office;
  const dirty = JSON.stringify(look) !== JSON.stringify(base);
  const set = <K extends keyof Appearance>(key: K, value: Appearance[K]) => setLook((l) => ({ ...l, [key]: value }));
  const head = look.accessory === 'glasses' ? 'none' : look.accessory;

  const save = async () => {
    setBusy(true);
    const res = await act(() => api<{ look: Appearance }>('PUT', '/me/character', { look: cleanAppearance(look, DEFAULT_LOOK) }), 'Your character is saved — everybody sees you so');
    setBusy(false);
    if (res) useOffice.setState((s) => (s.me ? { me: { ...s.me, look: res.look } } : {}));
  };
  const reset = async () => {
    if (!(await ask({ title: 'Back to the look the office gives you?', body: 'What you made here is forgotten; you look as you did before you made it.', ok: 'Go back' }))) return;
    setBusy(true);
    const res = await act(() => api<{ look: null }>('DELETE', '/me/character'), 'Back to the office’s look');
    setBusy(false);
    if (res) {
      useOffice.setState((s) => (s.me ? { me: { ...s.me, look: null } } : {}));
      setLook(office);
    }
  };

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'body', label: 'Body' },
    { id: 'face', label: 'Face' },
    { id: 'hair', label: 'Hair' },
    { id: 'clothes', label: 'Clothes' },
    { id: 'extras', label: 'Extras' },
  ];

  return (
    <Window kit flush title="My character" subtitle="How you look in the office — to everybody, every time you come in" onClose={onClose} width={980}>
      <div className="chc" data-character-creator>
        <div className="chc-stage">
          <Stage look={look} preview={preview} cue={cue} level={level} />
          <div className="chc-previews k-filters" role="group" aria-label="See it">
            {(['stand', 'walk', 'wave', 'sit'] as const).map((p) => (
              <button
                key={p}
                type="button"
                className={preview === p ? 'k-filter-on' : ''}
                onClick={() => {
                  setPreview(p);
                  if (p === 'wave') setCue(Date.now());
                }}
              >
                {p === 'stand' ? 'Standing' : p === 'walk' ? 'Walking' : p === 'wave' ? 'Waving' : 'Sitting'}
              </button>
            ))}
          </div>
          <div className="k-sub chc-hint">Drag the figure to turn it.</div>
        </div>
        <div className="chc-side">
          <Tabs<Tab> value={tab} onChange={setTab} tabs={tabs} />
          <div className="k-body chc-body" data-character-tab={tab}>
            {tab === 'body' && (
              <>
                <Part label="Skin">
                  <Colours label="Skin" value={look.skin} options={SKINS} onChange={(c) => set('skin', c)} />
                </Part>
                <Part label="Height" note={`${Math.round(look.build * 100)}% of the usual — everything about you is this much larger or smaller.`}>
                  <input className="chc-range" type="range" min={0.9} max={1.1} step={0.01} value={look.build} aria-label="Height" onChange={(e) => set('build', Number(e.target.value))} />
                </Part>
                <Part label="Build" note={(look.girth ?? 1) < 0.98 ? 'Slim' : (look.girth ?? 1) > 1.04 ? 'Broad' : 'Medium'}>
                  <input className="chc-range" type="range" min={0.94} max={1.08} step={0.01} value={look.girth ?? 1} aria-label="Build" onChange={(e) => set('girth', Number(e.target.value))} />
                </Part>
              </>
            )}
            {tab === 'face' && (
              <>
                <Part label="Face">
                  <Choice label="Face" value={look.face ?? 0} options={FACE_WORD.map((word, id) => ({ id, word }))} onChange={(v) => set('face', v)} />
                </Part>
                <Part label="Eyes">
                  <Colours label="Eyes" value={look.eyes ?? IRIS[0]!} options={[...IRIS]} onChange={(c) => set('eyes', c)} />
                </Part>
                <Part label="Brows">
                  <Choice label="Brows" value={look.brows ?? 0} options={BROW_WORD.map((word, id) => ({ id, word }))} onChange={(v) => set('brows', v)} />
                </Part>
                <Part label="Facial hair" note={look.facialHair && look.facialHair !== 'none' ? 'In the colour of your hair.' : undefined}>
                  <Choice label="Facial hair" value={look.facialHair ?? 'none'} options={FACIAL_HAIR.map((id) => ({ id, word: FACIAL_WORD[id] }))} onChange={(v) => set('facialHair', v)} />
                </Part>
              </>
            )}
            {tab === 'hair' && (
              <>
                <Part label="Style">
                  <Choice label="Hair style" value={look.hairStyle} options={HAIR_STYLES.map((id) => ({ id, word: HAIR_WORD[id] }))} onChange={(v) => set('hairStyle', v)} />
                </Part>
                <Part label="Colour">
                  <Colours label="Hair colour" value={look.hair} options={[...HAIRS, ...BOLD_HAIR]} onChange={(c) => set('hair', c)} />
                </Part>
              </>
            )}
            {tab === 'clothes' && (
              <>
                <Part label="What you wear">
                  <Choice label="Outfit" value={look.outfit ?? 'polo'} options={OUTFITS.map((id) => ({ id, word: OUTFIT_WORD[id] }))} onChange={(v) => set('outfit', v)} />
                </Part>
                <Part label={look.outfit === 'suit' ? 'Suit' : 'Top'}>
                  <Colours label="Top" value={look.shirt} options={CLOTH} onChange={(c) => set('shirt', c)} />
                </Part>
                <Part label="Trousers">
                  <Colours label="Trousers" value={look.pants} options={TROUSERS} onChange={(c) => set('pants', c)} />
                </Part>
                <Part label="Shoes">
                  <Colours label="Shoes" value={look.shoes ?? SHOES[0]!} options={SHOES} onChange={(c) => set('shoes', c)} />
                </Part>
                {look.outfit === 'suit' && (
                  <Part label="Tie">
                    <Colours label="Tie" value={look.tie ?? TIES[0]!} options={TIES} onChange={(c) => set('tie', c)} />
                  </Part>
                )}
              </>
            )}
            {tab === 'extras' && (
              <>
                <Part label="On your head">
                  <Choice label="On your head" value={head} options={(['none', 'cap', 'headphones'] as const).map((id) => ({ id, word: HEAD_WORD[id] }))} onChange={(v) => set('accessory', v)} />
                </Part>
                <Part label="Glasses">
                  <Choice label="Glasses" value={look.glasses ? 'yes' : 'no'} options={[{ id: 'no', word: 'No glasses' }, { id: 'yes', word: 'Glasses' }]} onChange={(v) => set('glasses', v === 'yes')} />
                </Part>
              </>
            )}
          </div>
          <div className="chc-save">
            <Button variant="ghost" className="k-quiet" disabled={busy} onClick={() => setLook({ ...randomLook() })} data-character-random>
              Surprise me
            </Button>
            {dirty && (
              <Button variant="ghost" className="k-quiet" disabled={busy} onClick={() => setLook(base)}>
                Undo changes
              </Button>
            )}
            {me?.look && (
              <Button variant="ghost" className="k-quiet" disabled={busy} onClick={() => void reset()} data-character-reset>
                The office’s look
              </Button>
            )}
            <span className="chc-grow" />
            <Button variant="primary" disabled={busy || (!dirty && !!me?.look)} onClick={() => void save()} data-character-save>
              {me?.look ? 'Save' : 'Save my character'}
            </Button>
          </div>
        </div>
      </div>
    </Window>
  );
}

registerPanel('character', CharacterPanel);
