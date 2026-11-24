/**
 * Which files can be read in the window itself — opened over the conversation instead of being downloaded — and
 * what colour a file's chip has. By the name first (employees leave `.txt`, `.md`, `.json`, `.log`, patches), since
 * the type a file arrives with is often just "application/octet-stream".
 */

/** Larger than this, a file is downloaded: reading megabytes of text in a window helps nobody. */
export const READ_MAX_BYTES = 2 * 1024 * 1024;
/** What is drawn of a long file; the rest is said to be there, and downloaded. */
export const SHOW_MAX_CHARS = 300_000;

const MARKDOWN = new Set(['md', 'markdown', 'mdx']);
const DATA = new Set(['json', 'jsonl', 'ndjson', 'csv', 'tsv', 'yaml', 'yml', 'toml', 'xml', 'ini', 'env', 'conf', 'cfg', 'properties', 'sql']);
const CODE = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'php', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'swift', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'css', 'scss', 'less', 'html', 'htm', 'vue', 'svelte', 'patch', 'diff', 'dockerfile', 'makefile', 'gradle', 'lua', 'pl', 'r']);
const TEXT = new Set(['txt', 'text', 'log', 'out', 'err', 'rst', 'adoc', 'srt', 'vtt', 'gitignore', 'lock', 'list']);
const DOC = new Set(['pdf', 'doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp', 'pages', 'numbers', 'key']);
const ARCHIVE = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar']);
const VIDEO = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv']);
const AUDIO = new Set(['mp3', 'wav', 'm4a', 'ogg', 'oga', 'flac', 'aac', 'opus']);

export const extOf = (name: string): string => {
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return (dot > 0 ? base.slice(dot + 1) : dot === 0 ? base.slice(1) : base).toLowerCase();
};

export type Reading = 'markdown' | 'text';

/** Can this file be read in the window, and as what? null: it is downloaded. */
export function readableAs(name: string, mime: string | null | undefined, size: number | null | undefined): Reading | null {
  if (typeof size === 'number' && size > READ_MAX_BYTES) return null;
  const ext = extOf(name);
  if (DOC.has(ext) || ARCHIVE.has(ext) || VIDEO.has(ext) || AUDIO.has(ext)) return null;
  if (MARKDOWN.has(ext) || mime === 'text/markdown') return 'markdown';
  if (DATA.has(ext) || CODE.has(ext) || TEXT.has(ext)) return 'text';
  const m = (mime ?? '').toLowerCase();
  if (m.startsWith('text/') || /^application\/(json|xml|x-yaml|yaml|x-sh|javascript|x-ndjson|sql)\b/.test(m)) return 'text';
  return null;
}

/** Is this a video the window plays (`VideoViewer`) instead of downloading it? By the name, or by the type. */
export function playableVideo(name: string, mime?: string | null): boolean {
  return VIDEO.has(extOf(name)) || (mime ?? '').toLowerCase().startsWith('video/');
}

/** Is this a sound the window plays (the same viewer, without a picture) instead of downloading it? */
export function playableAudio(name: string, mime?: string | null): boolean {
  return AUDIO.has(extOf(name)) || (mime ?? '').toLowerCase().startsWith('audio/');
}

/** A video or a sound: what the window plays, and as which. */
export const playableAs = (name: string, mime?: string | null): 'video' | 'audio' | null => (playableVideo(name, mime) ? 'video' : playableAudio(name, mime) ? 'audio' : null);

export type FileFamily = 'text' | 'data' | 'code' | 'doc' | 'picture' | 'video' | 'audio' | 'archive' | 'other';

/** The colour family of a file's chip. */
export function familyOf(name: string, mime?: string | null): FileFamily {
  const ext = extOf(name);
  if (MARKDOWN.has(ext) || TEXT.has(ext)) return 'text';
  if (DATA.has(ext)) return 'data';
  if (CODE.has(ext)) return 'code';
  if (DOC.has(ext)) return 'doc';
  if (ARCHIVE.has(ext)) return 'archive';
  if (playableVideo(name, mime)) return 'video';
  if (playableAudio(name, mime)) return 'audio';
  const m = (mime ?? '').toLowerCase();
  if (m.startsWith('image/')) return 'picture';
  if (m.startsWith('text/')) return 'text';
  return 'other';
}

/** What is drawn of a file's text, and whether that is all of it. */
export function shownOf(text: string): { text: string; cut: boolean } {
  return text.length > SHOW_MAX_CHARS ? { text: text.slice(0, SHOW_MAX_CHARS), cut: true } : { text, cut: false };
}

/**
 * Is this a page — HTML, or an SVG — that the window shows as the page it is (`PageViewer`: in a sandbox of its own,
 * from a ticket the office gives for that one file; `apps/server/src/page-view.ts`)? By the name.
 */
export function isPageFile(name: string): boolean {
  return /\.(html?|svg)$/i.test(name);
}
