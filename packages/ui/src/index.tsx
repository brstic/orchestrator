import { useEffect, type CSSProperties, type ReactNode } from 'react';
import type { Appearance } from '@orchestrator/contracts';

/** Small, dependency-free UI primitives shared by every panel. Styling lives in the app stylesheet. */

/**
 * A window over the office. `kit`: the calm look of docs/UI.md, for a window that has been moved to it (the styles
 * are `kit.css` in the app; the windows are moved one at a time).
 */
export function Window({ title, subtitle, onClose, children, width = 980, actions, flush = false, kit = false }: { title: ReactNode; subtitle?: ReactNode; onClose?: () => void; children: ReactNode; width?: number | string; actions?: ReactNode; flush?: boolean; kit?: boolean }) {
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => {
      // (Something that lies over the window — a picture enlarged, a menu — takes Escape first: `data-esc-first`.)
      if (e.key === 'Escape' && !(e.target as HTMLElement)?.closest?.('.xterm') && !document.querySelector('[data-esc-first]')) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="win-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={kit ? 'win win-kit' : 'win'} style={{ width, maxWidth: 'calc(100vw - 48px)' }} role="dialog" aria-label={typeof title === 'string' ? title : undefined}>
        <header className="win-head">
          <div className="win-titles">
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <div className="win-actions">
            {actions}
            {onClose && (
              <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close" title="Close (Esc)">
                ✕
              </button>
            )}
          </div>
        </header>
        <div className={`win-body ${flush ? 'win-body-flush' : ''}`}>{children}</div>
      </div>
    </div>
  );
}

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'default' | 'ghost' | 'danger' | 'success'; small?: boolean };

export function Button({ variant = 'default', small, className, ...rest }: ButtonProps) {
  return <button className={`btn btn-${variant} ${small ? 'btn-sm' : ''} ${className ?? ''}`} {...rest} />;
}

export type Tone = 'neutral' | 'info' | 'good' | 'warn' | 'bad' | 'muted' | 'accent';

export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Field({ label, hint, children, wide }: { label: ReactNode; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`field ${wide ? 'field-wide' : ''}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<{ id: T; label: ReactNode; count?: number }>; value: T; onChange: (id: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={`tab ${value === t.id ? 'tab-on' : ''}`} onClick={() => onChange(t.id)}>
          {t.label}
          {t.count != null && t.count > 0 && <span className="tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Empty({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}

export function Stat({ label, value, sub, tone }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: Tone }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ''}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {sub && <span className="stat-sub">{sub}</span>}
    </div>
  );
}

export function Progress({ value, tone = 'info' }: { value: number; tone?: Tone }) {
  return (
    <span className={`progress progress-${tone}`} role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </span>
  );
}

/** A flat portrait built from the employee's real appearance settings. */
export function Avatar({ appearance, size = 34, offline }: { appearance: Appearance; size?: number; offline?: boolean }) {
  const style: CSSProperties = { width: size, height: size, filter: offline ? 'grayscale(0.85) opacity(0.7)' : undefined };
  return (
    <span className="avatar" style={style} aria-hidden>
      <i className="avatar-shirt" style={{ background: appearance.shirt }} />
      <i className="avatar-head" style={{ background: appearance.skin }} />
      {appearance.hairStyle !== 'bald' && <i className={`avatar-hair avatar-hair-${appearance.hairStyle}`} style={{ background: appearance.hair }} />}
    </span>
  );
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** How a number was obtained. The UI always says which. */
export function Provenance({ kind }: { kind: 'measured' | 'reported' | 'unavailable' | 'estimate' }) {
  const tone: Tone = kind === 'measured' ? 'good' : kind === 'reported' ? 'warn' : 'muted';
  const tip = kind === 'measured' ? 'Measured by Orchestrator on the host' : kind === 'reported' ? "Reported by the agent; not independently verified" : kind === 'estimate' ? 'An estimate, not a measurement' : 'Not available for this session';
  return (
    <Badge tone={tone} title={tip}>
      {kind}
    </Badge>
  );
}

export { Markdown } from './markdown.tsx';
