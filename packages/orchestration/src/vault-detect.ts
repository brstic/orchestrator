/**
 * Finding credentials in text: passwords, tokens and keys that somebody typed into a message or that went
 * through a session. Only what is a credential by its shape or by what the sentence says is found here — a
 * provider's token format, a private key, a password inside a URL, `DB_PASSWORD=…`, "the password for X is …" —
 * because nothing on the server reads a sentence for its meaning. What needs judgement ("is this word a
 * password?") is left to the employee who reads the message: they have `vault_store`.
 *
 * (The patterns and the naming follow the owner's Ahoy project, `backend/ahoyyy/vault.py`, minus its model call.)
 */

import { stripEnd } from '@orchestrator/contracts';

export type SecretKind = 'password' | 'api_key' | 'token' | 'ssh_key' | 'other';

export interface FoundSecret {
  start: number;
  end: number;
  value: string;
  /** Which rule found it. */
  pattern: string;
  kind: SecretKind;
  /** The site, host or product it is for, when the text says so. */
  service: string;
  /** The login it goes with, when the text says so. */
  username: string;
}

/** What stands in a text where a credential was: the name it has in the vault. */
export const PLACEHOLDER = /\{\{vault:([a-z0-9][a-z0-9_.-]{0,60})\}\}/g;
export const placeholder = (name: string): string => `{{vault:${name}}}`;

const TOKENS: Array<[name: string, re: RegExp, kind: SecretKind, service: string]> = [
  ['private_key', /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,20000}?-----END [A-Z ]{0,40}PRIVATE KEY-----/g, 'ssh_key', ''],
  ['anthropic_key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g, 'api_key', 'anthropic'],
  ['openai_key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g, 'api_key', 'openai'],
  ['aws_access_key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, 'api_key', 'aws'],
  ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g, 'token', 'github'],
  ['gitlab_token', /\bglpat-[A-Za-z0-9_-]{20,}\b/g, 'token', 'gitlab'],
  ['slack_token', /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, 'token', 'slack'],
  ['google_api_key', /\bAIza[0-9A-Za-z_-]{35,}/g, 'api_key', 'google'],
  ['stripe_key', /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g, 'api_key', 'stripe'],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,8000}\.[A-Za-z0-9_-]{8,8000}\.[A-Za-z0-9_-]{8,8000}\b/g, 'token', ''],
];
const BEARER = /\b(?:bearer|basic)\s+([A-Za-z0-9._~+/-]{16,}=*)/gi;
/** scheme://user:password@host */
// (The password runs to the last `@` before the host: one that contains an `@` is not cut in two, with its tail read as the host.)
const URL_PASSWORD = /:\/\/([^/\s:@]+):([^/\s]{3,})@([^/\s:@]+)/g;
const HEADER_LINE = /^([ \t]*(?:authorization|proxy-authorization|x-api-key|api-key)[ \t]*:[ \t]*)(?:bearer[ \t]+|basic[ \t]+)?(\S.{6,})$/gim;
/**
 * DB_PASSWORD=…, "api_key": "…", token: …
 *
 * Every pattern in this file runs over text that an employee's session, a member or a page they read can shape, on
 * the office's one thread — so each must take time that grows with the length of the text, not with its square. That
 * is why a field's name starts where a word starts (the look-behind), why the parts of a name and of a token have a
 * longest length, and why no two neighbouring parts can share the same run of spaces. `vault.test.ts` times them
 * on text built to be slow.
 */
const LABEL = String.raw`(?<![A-Za-z0-9_-])(["']?[A-Za-z0-9_-]{0,64}(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_-]{0,64}["']?\s*[:=]\s*)`;
const FIELD = new RegExp(String.raw`${LABEL}(["']?)([^\s"',;&]{6,})\2`, 'gi');
/** The same with the value in quotes: everything between them, whatever it holds. */
const FIELD_QUOTED = new RegExp(String.raw`${LABEL}(["'])([^"'\n]{6,})\2`, 'gi');
/** A line of an env file: the value is the rest of the line, also when it holds a `;`, a `,` or an `&`. */
const ENV_LINE = /^([ \t]*(?:export[ \t]+)?[A-Za-z0-9_]{0,64}(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)[A-Za-z0-9_]{0,64}=)(?!["'])(\S{6,})[ \t]*$/gim;
/** "lozinka za git.example.net je Abc123!x", "password for db: x", "the token is …" */
const NATURAL =
  /\b(?:password|passwd|passcode|pass|pin|lozinka|lozinku|šifra|šifru|sifra|sifru|token|api\s*key|ključ|kljuc)(?:\s+(?:za|for|od|na|to)\s+((?!(?:je|is|glasi)\b)[^\s:=,]+(?:\s+(?!(?:je|is|glasi)\b)[^\s:=,]+)?))?(?:\s+(?:is|je|glasi))?(?:\s*[:=])?\s+([^\s"'`]{6,})/gi;
const USER_NEAR = /\b(?:user(?:name)?|korisnik|login|nalog|account)\s*[:=]?\s+([^\s,;:]{2,60})/gi;
const URL = /https?:\/\/(?:[^/\s@]+@)?([^/\s:]+)/g;

/** Letters, digits and a capital or a symbol, eight or more: a password by its shape alone. */
export function strong(value: string): boolean {
  return value.length >= 8 && /\d/.test(value) && /[A-Za-z]/.test(value) && (/[A-Z]/.test(value) || /[^A-Za-z0-9]/.test(value));
}

/** A value after `password=` that is code, not a credential: a variable, a reference, a placeholder, a plain word. */
function notAValue(value: string): boolean {
  if (/^(?:\$|<|\{|%|\*{3,}|x{3,}|\.{3,})/i.test(value)) return true; // $VAR, ${…}, <your-token>, {{…}}, ****, xxxx
  if (/^(?:true|false|null|none|undefined|changeme|change-me|example|secret|password|redacted|\[redacted\])$/i.test(value)) return true;
  if (/^[A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)+\)?;?$/.test(value)) return true; // process.env.API_KEY, config.token
  if (/[()]/.test(value)) return true; // a call: getToken(), os.getenv("X")
  if (/^[A-Za-z_]+$/.test(value)) return true; // a plain word or an identifier
  if (/^[A-Z][A-Z0-9_]+$/.test(value)) return true; // ANOTHER_VARIABLE
  return false;
}

const trim = (value: string): string => stripEnd(value, '.,;');

/** Credentials in a text, in order, without overlaps (the first and longest wins). */
export function detectSecrets(text: string): FoundSecret[] {
  if (!text) return [];
  const found: FoundSecret[] = [];
  const add = (start: number, value: string, pattern: string, kind: SecretKind, service = '', username = '') => {
    if (!value || new RegExp(PLACEHOLDER.source).test(value)) return;
    found.push({ start, end: start + value.length, value, pattern, kind, service, username });
  };
  const each = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    const g = new RegExp(re.source, re.flags);
    for (let m = g.exec(text); m; m = g.exec(text)) {
      fn(m);
      if (m[0] === '') g.lastIndex++;
    }
  };
  for (const [name, re, kind, service] of TOKENS) each(re, (m) => add(m.index, m[0], name, kind, service));
  each(BEARER, (m) => add(m.index + m[0].length - m[1]!.length, m[1]!, 'bearer', 'token'));
  each(URL_PASSWORD, (m) => {
    if (!notAValue(m[2]!)) add(m.index + 3 + m[1]!.length + 1, m[2]!, 'url_password', 'password', m[3]!, m[1]!);
  });
  each(HEADER_LINE, (m) => {
    const value = m[2]!.trim();
    if (!notAValue(value)) add(m.index + m[0].length - m[2]!.length, value, 'header', 'token');
  });
  each(FIELD, (m) => {
    const value = m[3]!;
    if (!notAValue(value) && (strong(value) || value.length >= 12)) add(m.index + m[1]!.length + m[2]!.length, value, 'field', /pass/i.test(m[1]!) ? 'password' : /key/i.test(m[1]!) ? 'api_key' : 'token');
  });
  const fieldKind = (label: string): SecretKind => (/pass/i.test(label) ? 'password' : /key/i.test(label) ? 'api_key' : 'token');
  each(FIELD_QUOTED, (m) => {
    const value = m[3]!;
    if (!notAValue(value) && (strong(value) || value.length >= 12)) add(m.index + m[1]!.length + 1, value, 'field', fieldKind(m[1]!));
  });
  each(ENV_LINE, (m) => {
    const value = m[2]!;
    if (!notAValue(value) && (strong(value) || value.length >= 12)) add(m.index + m[1]!.length, value, 'field', fieldKind(m[1]!));
  });
  each(NATURAL, (m) => {
    const value = trim(m[2]!);
    // "pass" and "pin" are also plain verbs and nouns ("pass Node22.18 tests"): they name a credential only when
    // the sentence says so — "pass is …", "pin: …".
    if (/^(?:pass|pin)\b/i.test(m[0]) && !/(?:\b(?:is|je|glasi)\s|[:=])/i.test(m[0].slice(0, m[0].length - m[2]!.length))) return;
    // "the password is strong" is a sentence; "the password is Jaka123!" is a password. In between is for a reader to judge.
    if (strong(value) && !notAValue(value)) add(m.index + m[0].length - m[2]!.length, value, 'natural', /token/i.test(m[0]) ? 'token' : /key|klju/i.test(m[0]) ? 'api_key' : 'password', trim(m[1] ?? ''));
  });

  // Where two rules found something at the same place, a format that cannot be mistaken wins over a guess from the words around it.
  const guess = (f: FoundSecret) => Number(f.pattern === 'field' || f.pattern === 'natural' || f.pattern === 'header');
  found.sort((a, b) => a.start - b.start || guess(a) - guess(b) || b.end - b.start - (a.end - a.start));
  const out: FoundSecret[] = [];
  for (const f of found) {
    if (out.length && f.start < out[out.length - 1]!.end) continue;
    out.push(f);
  }
  // A login or a site mentioned nearby says what the credential is for.
  for (const f of out) {
    if (!f.username) {
      const before = [...text.slice(Math.max(0, f.start - 160), f.start).matchAll(USER_NEAR)].pop();
      const after = new RegExp(USER_NEAR.source, 'i').exec(text.slice(f.end, f.end + 120));
      f.username = trim(stripEnd(before?.[1] ?? after?.[1] ?? '', '!?'));
      if (new RegExp(PLACEHOLDER.source).test(f.username)) f.username = '';
    }
    if (!f.service) f.service = [...text.slice(Math.max(0, f.start - 300), f.end + 200).matchAll(URL)][0]?.[1] ?? '';
  }
  return out;
}

export function slug(text: string, limit = 40): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, limit)
    .replace(/-+$/, '');
}

/** Words that say only that something is a credential, not which one. */
const GENERIC = new Set(['api', 'key', 'keys', 'token', 'tokens', 'password', 'passwords', 'pass', 'pwd', 'passwd', 'lozinka', 'sifra', 'secret', 'secrets', 'kljuc', 'access', 'auth', 'pin', 'credential', 'credentials', 'cred', 'login', 'new', 'my', 'the', 'za', 'for', 'ssh', 'private']);
export const generic = (name: string): boolean => name.split('-').filter(Boolean).every((p) => GENERIC.has(p) || /^\d+$/.test(p));

/** git.example.net → example, api.cloudflare.com → cloudflare, "Google Search Console" → google-search-console. */
export function serviceWord(service: string): string {
  const host = service.trim().toLowerCase();
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) {
    const parts = host.split('.').filter((p) => !['www', 'api', 'app', 'git'].includes(p));
    return slug(parts.length >= 2 ? parts[parts.length - 2]! : (parts[0] ?? host), 24);
  }
  return slug(service, 24);
}

const KIND_WORD: Record<SecretKind, string> = { password: 'password', api_key: 'api-key', token: 'token', ssh_key: 'ssh-key', other: 'secret' };

/** A name for something that was found: what it opens, whose login, what kind — e.g. `github-token`, `example-branko-password`. */
export function nameFor(f: Pick<FoundSecret, 'kind' | 'service' | 'username'>, hints: string[] = []): string {
  const parts = [serviceWord(f.service), slug(f.username.split('@')[0] ?? '', 16), KIND_WORD[f.kind]].filter(Boolean);
  const name = slug(parts.join('-'), 60);
  if (!generic(name)) return name;
  const lead = hints.map((h) => slug(h, 24)).find((h) => h && !generic(h));
  return slug([lead, name].filter(Boolean).join('-'), 60) || 'secret';
}

/** A name no other credential has: a qualifier it lacks is added before a number is. */
export function uniqueName(wanted: string, taken: Set<string>, qualifiers: string[] = []): string {
  const name = slug(wanted, 60) || 'secret';
  if (!taken.has(name)) return name;
  for (const q of qualifiers.map((x) => slug(x, 24)).filter((x) => x && !generic(x) && !name.split('-').includes(x))) {
    const candidate = slug(`${name}-${q}`, 60);
    if (!taken.has(candidate)) return candidate;
  }
  let n = 2;
  while (taken.has(`${name}-${n}`)) n++;
  return `${name}-${n}`;
}
