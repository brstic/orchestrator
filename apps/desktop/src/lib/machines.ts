import type { Host, HostInfo, HostResources } from '@orchestrator/contracts';

/**
 * What the Machines window says about a machine, as plain words and numbers (docs/UI.md): one line that says what
 * the machine is, one that says how it is, and the two measurements worth a glance. Nothing here touches the page.
 */

/** A server linked over SSH, as far as the words about its machine need it. */
export interface LinkLike {
  target: string;
  status: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';
  step?: string | null;
}

const PLATFORMS: Record<string, string> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };

const gb = (bytes: number): string => {
  const n = bytes / 1024 ** 3;
  return n >= 10 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, '');
};

/** "macOS · arm64 · 10 cores · 16 GB", or null for a machine that has never said anything about itself. */
export function systemLine(info: HostInfo | null | undefined): string | null {
  if (!info?.platform) return null;
  return [PLATFORMS[info.platform] ?? info.platform, info.arch, `${info.cpus} core${info.cpus === 1 ? '' : 's'}`, `${gb(info.totalMemBytes)} GB`].filter(Boolean).join(' · ');
}

/** Whose machine this is and how it came into the office. */
export function kindOf(host: Pick<Host, 'local' | 'memberId' | 'memberName' | 'ownerName'>, link?: LinkLike | null): string {
  if (host.local) return "The office's own machine";
  if (host.ownerName) return host.memberId ? `${host.ownerName}'s server` : `${host.ownerName}'s server, shared with the office`;
  if (host.memberName) return `${host.memberName}'s computer`;
  if (link) return `Over SSH · ${link.target}`;
  return 'Joined with a token';
}

/** How the machine is, where that is not simply "online": said after what it is. Null when there is nothing to add. */
export function stateOf(host: Pick<Host, 'status' | 'lastSeenAt'>, link: LinkLike | null | undefined, ago: (iso: string) => string): string | null {
  if (host.status === 'revoked') return 'revoked';
  if (link && (link.status === 'connecting' || link.status === 'reconnecting')) return link.step ? `${link.status} — ${link.step}` : link.status;
  if (host.status === 'online') return null;
  if (link?.status === 'idle') return 'disconnected';
  return host.lastSeenAt ? `offline, last seen ${ago(host.lastSeenAt)}` : 'has never connected';
}

export type MeterTone = 'calm' | 'warn' | 'bad';

export interface Meter {
  /** 0–100. */
  percent: number;
  /** What is written beside the bar. */
  value: string;
  tone: MeterTone;
}

const toneAt = (percent: number, warn: number, bad: number): MeterTone => (percent > bad ? 'bad' : percent > warn ? 'warn' : 'calm');

/** The processor's load, or null when the machine did not measure it. */
export function cpuMeter(r: HostResources | null | undefined): Meter | null {
  if (r?.cpuPercent == null) return null;
  const percent = Math.max(0, Math.min(100, r.cpuPercent));
  return { percent, value: `${Math.round(percent)}%`, tone: toneAt(percent, 70, 90) };
}

/** Memory in use out of what there is, or null when the machine did not measure it. (A healthy machine keeps most of its memory in use: the colour comes only close to the end.) */
export function memoryMeter(r: HostResources | null | undefined): Meter | null {
  if (r?.memUsedBytes == null || !r.memTotalBytes) return null;
  const percent = Math.max(0, Math.min(100, (r.memUsedBytes / r.memTotalBytes) * 100));
  return { percent, value: `${gb(r.memUsedBytes)} / ${gb(r.memTotalBytes)} GB`, tone: toneAt(percent, 90, 96) };
}

/**
 * The line under a machine's name: what it is, how it is (unless simply online), and how many work there. A
 * machine that is named for what it is ("Mila's computer") does not say it twice.
 */
export function aboutLine(host: Pick<Host, 'name' | 'status' | 'lastSeenAt' | 'local' | 'memberId' | 'memberName' | 'ownerName'>, link: LinkLike | null | undefined, staff: number, ago: (iso: string) => string): string {
  const kind = kindOf(host, link);
  const same = kind.toLowerCase() === host.name.trim().toLowerCase();
  const people = host.status === 'online' ? (staff > 0 ? `${staff} employee${staff === 1 ? '' : 's'}` : 'nobody works here yet') : null;
  return [same ? null : kind, stateOf(host, link, ago), people].filter(Boolean).join(' · ') || kind;
}

/**
 * How long something has run, from what `ps` says (`[[dd-]hh:]mm:ss`), in the two largest parts: "2 d 6 h",
 * "3 h 12 min", "45 s". What cannot be read is given back as it came.
 */
export function elapsedWords(etime: string): string {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!m) return etime;
  const parts: Array<[number, string]> = [
    [Number(m[1] ?? 0), 'd'],
    [Number(m[2] ?? 0), 'h'],
    [Number(m[3]), 'min'],
    [Number(m[4]), 's'],
  ];
  const first = parts.findIndex(([n]) => n > 0);
  if (first < 0) return '0 s';
  return parts
    .slice(first, first + 2)
    .filter(([n]) => n > 0)
    .map(([n, unit]) => `${n} ${unit}`)
    .join(' ');
}

/** What a machine lacks to run employees at all, in words for its line. Empty for one that has not reported yet. */
export function missingOn(info: HostInfo | null | undefined): string[] {
  if (!info?.platform) return [];
  const out: string[] = [];
  if (!info.claudeVersion) out.push('Claude Code was not found on this machine');
  if (!info.tmuxVersion) out.push('tmux was not found on this machine');
  return out;
}

/** "2 online", "1 of 3 online", "No machine is online". */
export function onlineLine(hosts: Array<Pick<Host, 'status'>>): string {
  const active = hosts.filter((h) => h.status !== 'revoked');
  const online = active.filter((h) => h.status === 'online').length;
  if (active.length === 0) return 'None yet';
  if (online === 0) return active.length === 1 ? 'It is offline' : 'None is online';
  return online === active.length ? `${online} online` : `${online} of ${active.length} online`;
}
