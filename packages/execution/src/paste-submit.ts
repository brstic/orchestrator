/**
 * Has a prompt that was pasted into Claude Code really been sent?
 *
 * The office pastes a prompt and presses Enter. Claude Code takes a paste in over a moment — longer when the text
 * names files, which it looks at — and an Enter that arrives during that moment is lost: the text then stands in the
 * input box, unsent, and no hook ever says so. So the Enter is pressed only once the paste is seen in the box, and
 * afterwards the box is looked at again: while what was pasted is still standing there, Enter is pressed once more.
 *
 * Enter is never pressed on a guess. The box has to be recognised for what it is (in a dialog the same sign marks a
 * choice, and Enter there would approve something), and what stands in it has to be what was pasted.
 */

/** A line that begins with the prompt sign, and what follows the sign on it. */
const PROMPT = /^\s*[❯>](?:\s(.*))?$/;
/** One of the rules Claude Code draws above and below its input box. */
const RULE = /^\s*[─━]{12,}\s*$/;
/** How a long paste stands in the box: folded into a note ("[Pasted text #1 +11 lines]"; the tests' worker: "[pasted 418 chars]"). */
const FOLDED = /\[pasted (text|\d)/i;

/**
 * What stands in the input box on this screen, or null when no input box can be made out.
 * `lines`: the visible screen as plain text, top to bottom; `cursorY`: the row the cursor is on.
 */
export function promptBox(lines: readonly string[], cursorY: number): string | null {
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (PROMPT.test(lines[i]!)) {
      at = i;
      break;
    }
  }
  if (at < 0) return null;
  const first = PROMPT.exec(lines[at]!)![1] ?? '';
  // Claude Code's box: a rule directly above the sign, and one below what was written.
  if (at > 0 && RULE.test(lines[at - 1]!)) {
    for (let j = at + 1; j < lines.length && j <= at + 40; j++) {
      if (RULE.test(lines[j]!)) return [first, ...lines.slice(at + 1, j)].map((l) => l.trim()).join('\n').trim();
    }
    return null;
  }
  // No rules: a plain prompt line is the box only while the cursor is on it (otherwise it is a line of the past).
  return cursorY === at ? first.trim() : null;
}

/** The beginning of a text as it would stand in a box: its first words, spaces evened out. */
const head = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 24);

/** Is what was pasted still standing in the box — not sent? Only "yes" when it is recognised there. */
export function stillInTheBox(box: string | null, pasted: string): boolean {
  if (!box) return false;
  const start = head(pasted);
  if (!start) return false;
  return FOLDED.test(box) || box.replace(/\s+/g, ' ').includes(start);
}
