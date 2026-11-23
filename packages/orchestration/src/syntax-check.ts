/**
 * The office's own check of handed-in work in a project that has no verification command of its own
 * (`docs/TASKS.md`, "The office checks what it can"). Measured on the live office, 2026-11-23: of 320 hand-ins not
 * one was checked by the office — no project had a command — so "tests passed" was always the employee's word. A
 * syntax check of the files the task changed is what can be run anywhere, without knowing the project: it does not
 * say the work is right, only that what was changed still parses. It runs on the employee's machine like any
 * verification command (`verify.run`), changes nothing (no caches written into the folder: Python is parsed with
 * `ast`, not compiled), and a checker that is not installed there is skipped and said so.
 */

/** What checks a file, by its name: the tool that must be on the machine, and the command (the file is `"$1"`). */
const CHECKERS: Array<{ test: RegExp; tool: string; run: string }> = [
  { test: /\.(php|phtml|inc)$/i, tool: 'php', run: 'php -d display_errors=stderr -l "$1"' },
  { test: /\.(js|mjs|cjs)$/i, tool: 'node', run: 'node --check "$1"' },
  // Plain JSON only: a TypeScript or editor settings file is JSON with comments, which is not an error.
  { test: /^(?!.*(?:^|\/)(?:tsconfig[^/]*|jsconfig[^/]*|\.vscode\/[^/]*|devcontainer|\.devcontainer\/[^/]*)\.json$).*\.json$/i, tool: 'node', run: `node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$1"` },
  { test: /\.py$/i, tool: 'python3', run: `python3 -c 'import ast,sys; ast.parse(open(sys.argv[1],"rb").read(), sys.argv[1])' "$1"` },
  { test: /\.(sh|bash)$/i, tool: 'bash', run: 'bash -n "$1"' },
];

/** At most this many files are checked (a hand-in that changed more names how many were left out). */
export const SYNTAX_MAX_FILES = 300;

export const SYNTAX_LABEL = 'syntax check of the changed files';

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The shell script that checks these files (paths relative to the folder it runs in), or null when none of them is
 * of a kind it knows. It prints only what fails, and last a line "syntax check: N checked, F failed, S skipped …";
 * it exits non-zero when a file does not parse.
 */
export function syntaxCheckScript(files: string[]): { script: string; files: number } | null {
  const picked: Array<{ file: string; tool: string; run: string }> = [];
  for (const raw of [...new Set(files.map((f) => f.trim()).filter(Boolean))]) {
    const c = CHECKERS.find((k) => k.test.test(raw));
    if (c) picked.push({ file: raw.startsWith('-') ? `./${raw}` : raw, tool: c.tool, run: c.run });
  }
  if (!picked.length) return null;
  const over = Math.max(0, picked.length - SYNTAX_MAX_FILES);
  const lines = [
    'c=0; f=0; s=0; m=""',
    // One file: skipped when it is gone (deleted by the task) or its checker is not on this machine.
    'chk() { t="$1"; shift; [ -f "$1" ] || return 0; if ! command -v "$t" >/dev/null 2>&1; then s=$((s+1)); case " $m " in *" $t "*) ;; *) m="$m $t";; esac; return 0; fi; c=$((c+1)); o=$(sh -c "$2" sh "$1" 2>&1) || { f=$((f+1)); printf "%s does not parse:\\n%s\\n\\n" "$1" "$(printf "%s" "$o" | head -n 8)"; }; }',
  ];
  for (const p of picked.slice(0, SYNTAX_MAX_FILES)) lines.push(`chk ${p.tool} ${quote(p.file)} ${quote(p.run)}`);
  lines.push(`echo "syntax check: $c checked, $f failed, $s skipped\${m:+ (not installed here:$m)}${over ? `, ${over} more not checked` : ''}"`, '[ "$f" -eq 0 ]');
  return { script: lines.join('\n'), files: Math.min(picked.length, SYNTAX_MAX_FILES) };
}

/** How many files the script's last line says it checked (0: nothing could be checked on that machine). */
export function syntaxChecked(output: string): number {
  const m = /syntax check: (\d+) checked/.exec(output);
  return m ? Number(m[1]) : 0;
}
