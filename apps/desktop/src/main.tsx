import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Boundary, PageFailed } from './hud/boundary.tsx';
import './styles.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5000 } } });

/**
 * A phone is told that the office is for a computer (the server says the same before this page is ever sent; this is
 * for a phone whose browser claims to be a desktop one). Told by what it is — a small screen steered by touch.
 */
function onAPhone(): boolean {
  if (/\bMobi|\biPhone\b|\biPod\b|Windows Phone|Opera Mini/i.test(navigator.userAgent)) return true;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
  return coarse && Math.min(screen.width, screen.height) < 600;
}

/** The Rent portal (docs/RENT.md): a client's chat at the office's address — no office around it, and fine on a phone. */
const portal = /^\/(rent\/?$|r\/[A-Za-z0-9.-]+$)/.test(window.location.pathname);

if (portal) {
  void import('./rent/RentPortal.tsx').then(({ RentPortal }) =>
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <Boundary fallback={(error, again) => <PageFailed error={error} again={again} />}>
          <RentPortal />
        </Boundary>
      </StrictMode>,
    ),
  );
} else if (onAPhone()) {
  document.getElementById('root')!.innerHTML =
    '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem;text-align:center;font:16px/1.5 system-ui,sans-serif;color:#e8ecf3;background:#0d1118"><div style="max-width:26rem"><h1 style="font-size:1.25rem;margin:0 0 .75rem">The office opens on a computer</h1><p style="color:#94a0b4;margin:0">It is a 3D room with live terminals and needs a desktop or laptop computer; it cannot be entered from a phone. Open the same link on a computer — in a browser, or in the Orchestrator app.</p><p style="color:#94a0b4;margin:1rem 0 0">Talking to an AI employee the office rents you? <a href="/rent" style="color:#ffd166">The Rent portal</a> works on a phone.</p></div></div>';
} else
  // (Loaded only for the office itself: the portal does not need the 3D room and what comes with it.)
  void import('./App.tsx').then(({ App }) =>
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <Boundary fallback={(error, again) => <PageFailed error={error} again={again} />}>
          <QueryClientProvider client={queryClient}>
            <App />
          </QueryClientProvider>
        </Boundary>
      </StrictMode>,
    ),
  );
