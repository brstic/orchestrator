import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
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

if (onAPhone()) {
  document.getElementById('root')!.innerHTML =
    '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem;text-align:center;font:16px/1.5 system-ui,sans-serif;color:#e8ecf3;background:#0d1118"><div style="max-width:26rem"><h1 style="font-size:1.25rem;margin:0 0 .75rem">The office opens on a computer</h1><p style="color:#94a0b4;margin:0">It is a 3D room with live terminals and needs a desktop or laptop computer; it cannot be entered from a phone. Open the same link on a computer — in a browser, or in the Orchestrator app.</p></div></div>';
} else
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
