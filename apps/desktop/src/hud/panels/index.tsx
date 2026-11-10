import { Suspense, lazy, type ComponentType, type ReactNode } from 'react';
import { Window } from '@orchestrator/ui';
import { useOffice, type PanelId } from '../../lib/store.ts';
import { QuestionBody } from '../core.tsx';

/** Panels are registered here; each lives in its own file. */
type PanelComponent = (props: { arg: string | null; onClose: () => void }) => ReactNode;

const registry: Partial<Record<PanelId, PanelComponent>> = {};

export function registerPanel(id: PanelId, component: PanelComponent): void {
  registry[id] = component;
}

type PanelProps = { arg: string | null; onClose: () => void };
type PanelType = ComponentType<PanelProps>;

/** Modules that hold panels and are loaded on first use. A module registers its panels (above) when it is evaluated. */
const loaders: Partial<Record<PanelId, () => Promise<unknown>>> = {};
const lazies: Partial<Record<PanelId, PanelType>> = {};

/** Say which module holds these panels, without loading it: `load` runs the first time one of them is opened. */
export function registerLazyPanels(ids: PanelId[], load: () => Promise<unknown>): void {
  for (const id of ids) loaders[id] = load;
}

function Unavailable({ id, why, onClose }: { id: string; why: string; onClose: () => void }) {
  return (
    <Window title={id} onClose={onClose} width={520}>
      <p className="muted">{why}</p>
    </Window>
  );
}

/**
 * The component for a panel. One that is already registered is used directly; otherwise a lazy
 * component is made once that loads the panel's module and then renders what it registered.
 * Whichever was handed out first is kept for that panel, so an open panel is never remounted.
 */
function componentFor(id: PanelId): PanelType | null {
  const made = lazies[id];
  if (made) return made;
  const ready = registry[id];
  if (ready) return ready as PanelType;
  const load = loaders[id];
  if (!load) return null;
  return (lazies[id] = lazy(async (): Promise<{ default: PanelType }> => {
    try {
      await load();
    } catch (e) {
      // A chunk that cannot be fetched (a half-updated install) must not take the office down with it.
      const why = `This panel could not be loaded: ${(e as Error).message}`;
      delete lazies[id]; // the next time it is opened, try again
      return { default: ({ onClose }) => <Unavailable id={id} why={why} onClose={onClose} /> };
    }
    const loaded = registry[id] as PanelType | undefined;
    return { default: loaded ?? (({ onClose }) => <Unavailable id={id} why="This panel is not available in this build." onClose={onClose} />) };
  }));
}

function QuestionPanel({ arg, onClose }: { arg: string | null; onClose: () => void }) {
  const q = useOffice((s) => (arg ? s.questions[arg] : undefined));
  if (!q) return null;
  return (
    <Window title={q.kind === 'permission' ? 'Approval request' : q.kind === 'trust_prompt' ? 'Claude Code needs a decision' : 'Question from your team'} onClose={onClose} width={640}>
      <QuestionBody q={q} onDone={onClose} />
    </Window>
  );
}
registerPanel('question', QuestionPanel);

export function PanelHost() {
  const panel = useOffice((s) => s.panel);
  const arg = useOffice((s) => s.panelArg);
  const close = () => useOffice.getState().openPanel(null);
  if (!panel) return null;
  const Component = componentFor(panel);
  if (!Component) return <Unavailable id={panel} why="This panel is not available in this build." onClose={close} />;
  // Nothing is shown for the few milliseconds a panel's module takes to load the first time.
  return (
    <Suspense fallback={null}>
      <Component arg={arg} onClose={close} />
    </Suspense>
  );
}
