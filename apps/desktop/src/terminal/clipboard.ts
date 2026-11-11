/**
 * What goes to the clipboard when someone copies a selection out of a terminal.
 *
 * A terminal knows rows, not paragraphs: a long address that a program printed across several rows (Claude Code's
 * sign-in link, for one) comes out of the selection with a line break after every row, and pasted into a browser it
 * is cut at the first one. When the whole selection is one web address spread over rows, it is put back together;
 * anything else is copied as it stands, without the blank space terminals leave at the end of rows.
 */
export function selectionText(raw: string): string {
  const lines = raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  while (lines.length && !lines[0]) lines.shift();
  const parts = lines.map((l) => l.trim());
  if (parts.length > 1 && /^https?:\/\/\S+$/i.test(parts[0]!) && parts.every((p) => p.length > 0 && !/\s/.test(p))) return parts.join('');
  return lines.join('\n');
}

/**
 * Put text on the clipboard. The asynchronous clipboard needs a page people can trust (https, or this computer) and
 * the window in front; where it refuses, the old way — a hidden text box and the browser's own copy — is tried.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const box = document.createElement('textarea');
    box.value = text;
    box.setAttribute('readonly', '');
    box.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(box);
    const had = document.activeElement as HTMLElement | null;
    box.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    box.remove();
    had?.focus?.();
    return ok;
  }
}
