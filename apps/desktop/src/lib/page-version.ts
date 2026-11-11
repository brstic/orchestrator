/**
 * Is this window still the office's current page?
 *
 * The page is served by the office and comes in parts that are fetched when first needed (a panel's code, for one),
 * each under a name that changes with every build. When the office is updated while a window is open, that window
 * goes on asking for parts by their old names, and the office no longer has them: "Failed to fetch dynamically
 * imported module". Nothing is broken; the window is a version behind and needs a reload. This tells that case
 * from a real network failure, so the window can say which it is.
 */

/** The paths of the scripts this page was started with (`/assets/index-AbC123.js`). */
export function entryScripts(doc: Pick<Document, 'querySelectorAll'> = document): string[] {
  return [...doc.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')]
    .map((s) => {
      if (!s.src) return '';
      try {
        return new URL(s.src, 'http://x').pathname;
      } catch {
        return '';
      }
    })
    .filter(Boolean);
}

/** Does the office's page, as it is served now, start with other scripts than this window did? */
export function servedPageDiffers(mine: string[], servedHtml: string): boolean {
  if (!mine.length || !servedHtml) return false;
  // Only something that is the office's page counts: an error page or a proxy's notice says nothing about versions.
  if (!/<script[^>]+type="module"/i.test(servedHtml)) return false;
  return !mine.some((path) => servedHtml.includes(path));
}

/** Ask the office for its page as it is now and compare. False when it cannot be asked (offline: then that is the trouble). */
export async function officeWasUpdated(): Promise<boolean> {
  try {
    const res = await fetch(`${location.origin}/?_=${Date.now()}`, { cache: 'no-store', credentials: 'omit' });
    if (!res.ok) return false;
    return servedPageDiffers(entryScripts(), await res.text());
  } catch {
    return false;
  }
}
