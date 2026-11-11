import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Something in this part of the page threw while it was being drawn. Without a boundary React takes the whole page
 * away and leaves it blank — which is what one record with an unexpected shape did to every open window. With one,
 * the part that failed says so and the rest of the office stays on screen.
 *
 * It catches what is thrown while drawing, not what an event handler or a request throws (those never blanked the page).
 */
export class Boundary extends Component<{ children: ReactNode; fallback: (error: Error, again: () => void) => ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[office] a part of the page could not be drawn:', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return this.props.fallback(error, () => this.setState({ error: null }));
  }
}

/** What went wrong, short enough to read and to pass on. Never more than a line of somebody else's text. */
export function errorLine(error: Error): string {
  const text = `${error.name}: ${error.message}`.replace(/\s+/g, ' ').trim();
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** The whole page failed to draw. The office and everybody's work are untouched; this window needs another go. */
export function PageFailed({ error, again }: { error: Error; again: () => void }) {
  return (
    <div className="login">
      <div className="glass login-card col" style={{ gap: 10, maxWidth: 520 }}>
        <h1>ORCHESTRATOR</h1>
        <p>This window ran into a problem and could not be drawn. The office itself is running and nobody's work is affected.</p>
        <p className="muted" style={{ overflowWrap: 'anywhere' }}>
          {errorLine(error)}
        </p>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            Reload this window
          </button>
          <button className="btn btn-ghost" onClick={again}>
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}
