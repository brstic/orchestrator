/**
 * The Rent portal on a phone (the owner, 2026-11-20: "the Rent portal must work from a mobile phone, optimised for
 * it; only the office and its 3D are not for a phone"). What the page itself does for a phone:
 * - it can be put on the home screen as an app of its own (`/rent/manifest.webmanifest`, the icons in
 *   `public/rent/`): opened from there it has no browser bar, and it starts at the portal;
 * - it fills the screen to its edges (`viewport-fit=cover`, the safe areas padded in `rent.css`);
 * - it stays above the keyboard: a phone's keyboard covers the bottom of a page fixed to the screen without making
 *   it smaller (iOS), so the page is sized to what can be seen (`window.visualViewport`) — `--rp-vvh`, `--rp-vvtop`.
 */
export function phoneReady(office: string): () => void {
  const head = document.head;
  const meta = (name: string, content: string) => {
    let el = head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
    if (!el) {
      el = document.createElement('meta');
      el.name = name;
      head.appendChild(el);
    }
    el.content = content;
  };
  const link = (rel: string, href: string, extra: Record<string, string> = {}) => {
    if (head.querySelector(`link[rel="${rel}"]`)) return;
    const el = document.createElement('link');
    el.rel = rel;
    el.href = href;
    for (const [k, v] of Object.entries(extra)) el.setAttribute(k, v);
    head.appendChild(el);
  };
  meta('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content');
  meta('theme-color', '#0b0f17');
  meta('apple-mobile-web-app-capable', 'yes');
  meta('mobile-web-app-capable', 'yes');
  meta('apple-mobile-web-app-status-bar-style', 'black-translucent');
  meta('apple-mobile-web-app-title', office ? `${office} Rent` : 'Rent portal');
  link('manifest', '/rent/manifest.webmanifest');
  link('apple-touch-icon', '/rent/icon-180.png', { sizes: '180x180' });
  link('icon', '/rent/icon-192.png', { sizes: '192x192', type: 'image/png' });

  const vv = window.visualViewport;
  if (!vv) return () => undefined;
  const root = document.documentElement;
  const fit = () => {
    root.style.setProperty('--rp-vvh', `${Math.round(vv.height)}px`);
    root.style.setProperty('--rp-vvtop', `${Math.round(vv.offsetTop)}px`);
  };
  fit();
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
  return () => {
    vv.removeEventListener('resize', fit);
    vv.removeEventListener('scroll', fit);
  };
}
