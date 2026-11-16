import path from 'node:path';
import type {
  AccountInfo,
  AccountLogin,
  AccountUsage,
  MemberRoomPrefs,
  AgentSession,
  AgentSessionReport,
  Appearance,
  Employee,
  Host,
  HostInfo,
  HostResources,
  LaunchSpec,
  SessionUsage,
  TerminalScreen,
  ActivityState,
} from '@orchestrator/contracts';
import { AUTONOMY_LEVELS, EFFORT_CHOICES, HOOKS_VERSION, isAutonomyLevel, memberSeatOf, modelFamily, ROLE_CATALOGUE, matchRole, newId, nowIso, roleByKey, directsOthers, LEAD_ROLE, LEAD_MODEL, LEAD_EFFORT, sanitizeMemberRoom, slugify, truncate, type EffortLevel, stripEnd } from '@orchestrator/contracts';
import { generateToken } from '@orchestrator/database';
import { inputBox, menuKeys, permissionPrompt, plainScreen, trustPromptKeys } from './comms.ts';
import { EngineError, within } from './core.ts';
import type { Engine } from './engine.ts';
import { DEFAULT_HIGH_RISK_PATTERNS, asksHighRisk, permissionsFor, systemPromptFor } from './prompts.ts';

const SKINS = ['#f1c9a5', '#e0ac69', '#c68642', '#8d5524', '#ffdbac', '#a9745a'];
const HAIRS = ['#2b1d0e', '#4a2f1b', '#0f0f0f', '#b5651d', '#d9b380', '#6b6b6b', '#7a3b1d'];
const SHIRTS = ['#4f8cff', '#ff8c5a', '#5ad67d', '#c58cff', '#f5c542', '#ff5d73', '#3fd0c9', '#9aa7b8', '#e6d3a3', '#7fd1ff'];
const PANTS = ['#2d3748', '#1f2937', '#3b3f5c', '#4a4238', '#27364a'];
const HAIR_STYLES: Appearance['hairStyle'][] = ['short', 'long', 'bun', 'curly', 'short', 'bald'];
const ACCESSORIES: Appearance['accessory'][] = ['none', 'glasses', 'headphones', 'none', 'cap', 'none'];

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A stable default look derived from the employee's name; fully editable afterwards. */
export function defaultAppearance(name: string, roleColor?: string): Appearance {
  const h = hashString(name);
  return {
    skin: SKINS[h % SKINS.length]!,
    hair: HAIRS[(h >>> 3) % HAIRS.length]!,
    hairStyle: HAIR_STYLES[(h >>> 6) % HAIR_STYLES.length]!,
    shirt: roleColor ?? SHIRTS[(h >>> 9) % SHIRTS.length]!,
    pants: PANTS[(h >>> 12) % PANTS.length]!,
    accessory: ACCESSORIES[(h >>> 15) % ACCESSORIES.length]!,
    build: 0.94 + ((h >>> 18) % 13) / 100,
  };
}

// ───────────────────────────── Hosts ─────────────────────────────

/** How long a host must stay above the limit before it counts as exhausted (ORCH_RESOURCE_PRESSURE_MS, for tests). */
const resourcePressureMs = (): number => Number(process.env.ORCH_RESOURCE_PRESSURE_MS) || 30_000;

/** How often, at most, a session's terminal output is summarised as an event. */
const TERMINAL_OUTPUT_EVERY_MS = 60_000;

/** The pod a desk belongs to: desks are named `<pod>-a` … `<pod>-d`. */
const podOf = (deskId: string): string => deskId.replace(/-[a-z]$/, '');

/** The folder of a Claude account as an employee's record keeps it: null for the machine's default login; refused when it is not a path. */
function accountDirOf(raw: unknown): string | null {
  const dir = stripEnd(String(raw ?? '').trim(), '/');
  if (dir && (!/^(~\/|\/)[A-Za-z0-9._ \/@+-]+$/.test(dir) || dir.includes('..'))) throw new EngineError('the Claude account folder must be a path like ~/.claude-work');
  return dir || null;
}

/** What somebody who names a level that is not one is told. */
const notALevel = (value: unknown): string => `"${truncate(String(value), 40)}" is not a level: it is one of ${AUTONOMY_LEVELS.join(', ')}`;

export class HostRegistry {
  private eng: Engine;
  private lastResourcePersist = new Map<string, number>();

  constructor(eng: Engine) {
    this.eng = eng;
  }

  private get core() {
    return this.eng.core;
  }

  /** One-time token an operator pastes into `orchestrator-agent login`. Stored only as a hash. */
  createEnrollmentToken(label: string, ttlMs = 60 * 60_000, actor = 'owner'): { token: string; expiresAt: string } {
    const token = generateToken('orch_enroll');
    this.core.store.addCredential('enrollment', token, { label, ttlMs });
    this.core.audit(actor, 'host.enrollment_token_created', label, { ttlMs });
    return { token, expiresAt: new Date(Date.now() + ttlMs).toISOString() };
  }

  /**
   * A one-time enrollment for a member's own computer. The host that enrolls with it is theirs: what runs on it is
   * personal, and it is the only kind of host that may connect from outside (through the door).
   */
  createMemberEnrollment(member: { id: string; name: string }, ttlMs = 10 * 60_000): { token: string; expiresAt: string } {
    return this.createEnrollmentToken(`member:${member.id}:${member.name}`, ttlMs, `member:${member.name}`);
  }

  /**
   * A one-time enrollment for a server a member brings into the office themselves. The host that enrolls with it is
   * theirs like their own computer — personal, and allowed to connect from outside — and stays theirs to share.
   */
  createMemberServerEnrollment(member: { id: string; name: string }, serverName: string, ttlMs = 10 * 60_000): { token: string; expiresAt: string } {
    const name = serverName.replace(/[\x00-\x1f:]+/g, ' ').trim().slice(0, 40) || 'server';
    return this.createEnrollmentToken(`member-server:${member.id}:${member.name}:${name}`, ttlMs, `member:${member.name}`);
  }

  /** The servers a member brought into the office, private and shared alike. */
  serversOf(memberId: string): Host[] {
    return this.core.hosts.filter((h) => h.ownerId === memberId && h.status !== 'revoked');
  }

  /**
   * A member shares a server of theirs with the office, or takes it back. Shared, it is a machine like the office's
   * own: everything on it is the office's, colleagues work on it, and it stands with the other machines. Private, it
   * is the member's alone again — with what is on it.
   */
  shareMemberServer(hostId: string, shared: boolean, actor: string): Host {
    const host = this.core.hosts.require(hostId);
    if (!host.ownerId || host.status === 'revoked') throw new EngineError('that is not a server a member brought into the office', 404);
    if (shared === !host.memberId) return host;
    if (!shared) {
      // Work does not cross between the shared office and a member's computers: what is in progress here for a
      // project on another machine would be cut off from it.
      const busy = this.core.tasks.find((t) => t.status === 'IN_PROGRESS' && this.core.employees.get(t.assigneeId ?? '')?.hostId === host.id && this.core.projects.get(t.projectId)?.hostId !== host.id);
      if (busy) throw new EngineError(`${busy.key} is in progress on this server for a project that lives on another machine. Take the server back when that is finished.`, 409);
    }
    host.memberId = shared ? null : host.ownerId;
    host.memberName = shared ? null : (host.ownerName ?? null);
    host.room = shared ? null : this.memberRoom(host.ownerId);
    this.core.put('host', host);
    this.core.audit(actor, shared ? 'host.shared' : 'host.unshared', host.id, { name: host.name, owner: host.ownerId });
    this.core.event({ type: shared ? 'host.shared' : 'host.unshared', source: 'server', summary: shared ? `${host.ownerName ?? 'A member'} shared the server "${host.name}" with the office` : `${host.ownerName ?? 'A member'} took the server "${host.name}" back`, hostId: host.id, data: { ownerId: host.ownerId } });
    return host;
  }

  /** Has this member closed their room? Then what is on their computers is theirs alone. */
  isClosed(memberId: string | null | undefined): boolean {
    return !!memberId && this.memberRoom(memberId)?.locked === true;
  }

  /** Every member whose room is closed. */
  closedMembers(): string[] {
    return Object.entries(this.core.store.kvGet<Record<string, MemberRoomPrefs>>('memberRooms', {}))
      .filter(([, prefs]) => prefs?.locked === true)
      .map(([id]) => id);
  }

  /** A member arranges their room: remembered for them, and shown on every computer of theirs. */
  setMemberRoom(memberId: string, input: unknown, actor: string): MemberRoomPrefs {
    const prefs = sanitizeMemberRoom(input);
    const all = this.core.store.kvGet<Record<string, MemberRoomPrefs>>('memberRooms', {});
    all[memberId] = prefs;
    this.core.store.kvSet('memberRooms', all);
    for (const h of this.ofMember(memberId)) {
      h.room = prefs;
      this.core.put('host', h);
    }
    this.core.audit(actor, 'member.room_changed', memberId, { ...prefs });
    return prefs;
  }

  memberRoom(memberId: string): MemberRoomPrefs | null {
    return this.core.store.kvGet<Record<string, MemberRoomPrefs>>('memberRooms', {})[memberId] ?? null;
  }

  /** The hosts that are a member's own computers. */
  ofMember(memberId: string): Host[] {
    return this.core.hosts.filter((h) => h.memberId === memberId && h.status !== 'revoked');
  }

  /**
   * Every machine a member brought into the office: their own computers, and the servers they linked — also the
   * ones they have since shared with everybody (those are no longer "theirs" to the rest of the office, but they
   * still came in on this member's word and connect from outside on it).
   */
  broughtBy(memberId: string): Host[] {
    return this.core.hosts.filter((h) => (h.memberId === memberId || h.ownerId === memberId) && h.status !== 'revoked');
  }

  /**
   * Is this member still somebody whose machines may connect? Set by the server, which keeps the members; here
   * everybody is, by default (an office with no members has no such machines).
   */
  memberInGoodStanding: (memberId: string) => boolean = () => true;

  /** The member whose own computer this host is, or null for a shared machine. */
  memberOfHost(hostId: string | null | undefined): string | null {
    return hostId ? (this.core.hosts.get(hostId)?.memberId ?? null) : null;
  }

  private uniqueName(wanted: string): string {
    const base = wanted.trim() || 'host';
    let name = base;
    for (let i = 2; this.core.hosts.find((h) => h.name === name && h.status !== 'revoked'); i++) name = `${base}-${i}`;
    return name;
  }

  /** Authenticate a connecting agent: an existing credential, or a fresh enrollment. */
  authenticate(hello: { hostId?: string | null; credential?: string | null; enrollmentToken?: string | null; name?: string | null; info: HostInfo }, local = false, outside = false): { host: Host; credential?: string } | { error: string } {
    // From outside (through the door) only a member's own computer may connect; shared machines are enrolled from the inside.
    const refused = { error: 'only a member\'s own computer can connect to this office from outside' };
    if (hello.credential && hello.hostId) {
      const cred = this.core.store.checkCredential('host', hello.credential);
      const host = this.core.hosts.get(hello.hostId);
      if (!cred || cred.refId !== hello.hostId || !host) return { error: 'unknown or revoked host credential; enroll this machine again' };
      if (host.status === 'revoked') return { error: 'this host has been revoked' };
      // A member's own computer, or a server they brought in (also once they have shared it).
      if (outside && !host.memberId && !host.ownerId) return refused;
      const of = host.memberId ?? host.ownerId;
      if (of && !this.memberInGoodStanding(of)) return { error: 'the member this machine came in with is no longer in this office' };
      return { host };
    }
    if (hello.enrollmentToken) {
      const cred = this.core.store.checkCredential('enrollment', hello.enrollmentToken);
      if (!cred) return { error: 'invalid or expired enrollment token' };
      if (cred.usedAt) return { error: 'this enrollment token was already used' };
      // `member:<id>:<name>` is the member's own computer; `member-server:<id>:<name>:<server>` a server they bring in.
      const server = /^member-server:([^:]+):([^:]*):(.*)$/.exec(cred.label ?? '');
      const member = server ?? /^member:([^:]+):(.*)$/.exec(cred.label ?? '');
      if (outside && !member) return refused;
      // (A token given to a member who has since been removed, or made a visitor, enrols nothing.)
      if (member && !this.memberInGoodStanding(member[1]!)) {
        this.core.store.revokeCredential(hello.enrollmentToken);
        return { error: 'the member this enrollment was made for is no longer in this office' };
      }
      this.core.store.markCredentialUsed(hello.enrollmentToken);
      this.core.store.revokeCredential(hello.enrollmentToken);
      const host: Host = {
        id: newId(),
        name: this.uniqueName(server ? server[3]! : member ? `${member[2]}'s computer` : hello.name || hello.info.hostname.replace(/\.local$/, '')),
        status: 'offline',
        info: hello.info,
        resources: null,
        enrolledAt: nowIso(),
        lastSeenAt: null,
        revokedAt: null,
        // A machine linked over SSH arrives through a tunnel that ends on this computer's loopback; it is still a remote machine.
        local: !member && ((local && !cred.label?.startsWith('ssh:')) || cred.label === 'local'),
        memberId: member?.[1] ?? null,
        memberName: member?.[2] ?? null,
        room: member ? this.memberRoom(member[1]!) : null,
        ...(server ? { ownerId: server[1]!, ownerName: server[2]! } : {}),
      };
      const credential = generateToken('orch_host');
      this.core.store.addCredential('host', credential, { refId: host.id, label: host.name });
      this.core.put('host', host);
      this.core.audit('system', 'host.enrolled', host.id, { name: host.name, hostname: hello.info.hostname });
      this.core.event({ type: 'host.enrolled', source: 'server', summary: `Host "${host.name}" was enrolled`, hostId: host.id, data: { hostname: hello.info.hostname, platform: hello.info.platform } });
      return { host, credential };
    }
    return { error: 'no credential presented; run `orchestrator-agent login` first' };
  }

  connected(hostId: string, info: HostInfo): void {
    const host = this.core.hosts.require(hostId);
    host.status = 'online';
    host.info = info;
    host.lastSeenAt = nowIso();
    this.core.put('host', host);
    this.core.event({ type: 'worker.connected', source: 'host', summary: `Host "${host.name}" connected`, hostId, data: { claude: info.claudeVersion, tmux: info.tmuxVersion } });
    this.eng.comms.resolveNotifications((n) => n.kind === 'host_disconnected' && n.hostId === hostId);
    // Who is signed in to its Claude accounts: asked now, so that each is known by its name.
    // (A moment after it has been welcomed, and once more if it did not answer: a machine that has just connected is
    // still starting.)
    const ask = (again: boolean): void => {
      const t = setTimeout(() => {
        if (this.core.hosts.get(hostId)?.status !== 'online') return;
        void this.eng.sessions.learnAccounts(hostId).catch((e) => (again ? ask(false) : this.core.log('info', `asking ${host.name} about its Claude accounts: ${(e as Error).message}`)));
      }, again ? 300 : 4000);
      t.unref?.();
    };
    ask(true);
  }

  disconnected(hostId: string): void {
    const host = this.core.hosts.get(hostId);
    if (!host) return;
    if (host.status !== 'revoked') host.status = 'offline';
    host.lastSeenAt = nowIso();
    this.core.put('host', host);
    const sessions = this.core.sessions.filter((s) => s.hostId === hostId && (s.status === 'running' || s.status === 'starting'));
    for (const s of sessions) this.eng.sessions.hostWentOffline(s);
    this.core.company.hostDisconnects++;
    this.core.saveCompany();
    this.core.event({ type: 'worker.disconnected', source: 'server', summary: `Host "${host.name}" disconnected`, hostId, data: { sessions: sessions.length } });
    // A member's own computer goes when they do: that is not a fault to report. (A server they shared is the office's to miss.)
    if (sessions.length && host.status !== 'revoked' && !host.memberId) {
      this.eng.comms.notify({
        kind: 'host_disconnected',
        severity: 'critical',
        title: `Host "${host.name}" is offline`,
        body: `${sessions.length} session${sessions.length === 1 ? '' : 's'} on it cannot be observed right now. They keep running in tmux and will reappear when the host reconnects.`,
        hostId,
      });
    }
  }

  resources(hostId: string, r: HostResources): void {
    const host = this.core.hosts.get(hostId);
    if (!host) return;
    host.resources = r;
    host.lastSeenAt = r.ts;
    this.checkPressure(host, r);
    const last = this.lastResourcePersist.get(hostId) ?? 0;
    if (Date.now() - last > 60_000) {
      this.lastResourcePersist.set(hostId, Date.now());
      this.core.put('host', host);
    } else this.core.broadcast('host', host);
  }

  private pressure = new Map<string, { since: number; what: string; warned: boolean }>();

  /** Why this host should not be given more work right now (it has been out of memory or CPU for a while), or null. */
  exhausted(hostId: string | null | undefined): string | null {
    const p = hostId ? this.pressure.get(hostId) : undefined;
    return p?.warned ? p.what : null;
  }

  /**
   * A host that stays above 95% memory or CPU for half a minute is exhausted: the owner is warned,
   * and no new work is started there until it recovers. What is already running is left alone.
   */
  private checkPressure(host: Host, r: HostResources): void {
    const mem = r.memUsedBytes != null && r.memTotalBytes ? r.memUsedBytes / r.memTotalBytes : null;
    const what = mem != null && mem >= 0.95 ? `memory is ${Math.round(mem * 100)}% used` : r.cpuPercent != null && r.cpuPercent >= 95 ? `CPU is at ${Math.round(r.cpuPercent)}%` : null;
    const p = this.pressure.get(host.id);
    if (!what) {
      if (p?.warned) {
        this.core.event({ type: 'host.resource_warning', source: 'host', summary: `Host "${host.name}" has recovered`, hostId: host.id, data: { recovered: true } });
        this.eng.comms.resolveNotifications((n) => n.kind === 'host_resources' && n.hostId === host.id);
        this.pressure.delete(host.id);
        this.eng.tasks.schedule(); // work that was held back can start now
        return;
      }
      this.pressure.delete(host.id);
      return;
    }
    if (!p) return void this.pressure.set(host.id, { since: Date.now(), what, warned: false });
    p.what = what;
    if (p.warned || Date.now() - p.since < resourcePressureMs()) return;
    p.warned = true;
    this.core.event({ type: 'host.resource_warning', source: 'host', summary: `Host "${host.name}" is running out of resources: ${what}`, hostId: host.id, data: { memUsed: mem, cpuPercent: r.cpuPercent, loadAvg1: r.loadAvg1, sessions: r.sessionCount } });
    this.eng.comms.notify({ kind: 'host_resources', severity: 'warning', title: `Host "${host.name}" is running out of resources`, body: `Its ${what}. No new work will be started on it until it recovers; the ${r.sessionCount} session${r.sessionCount === 1 ? '' : 's'} already running there are left alone.`, hostId: host.id });
  }

  revoke(hostId: string, actor = 'owner'): void {
    const host = this.core.hosts.require(hostId);
    this.core.store.revokeCredentialsFor('host', hostId);
    // What its sessions were given to call the office's tools with ends too: those tokens lie in files on that
    // machine, and would otherwise open the office's tools (the vault among them) for as long as nobody restarts them.
    for (const s of this.core.sessions.filter((x) => x.hostId === hostId)) this.core.store.revokeCredentialsFor('mcp', s.id);
    host.status = 'revoked';
    host.revokedAt = nowIso();
    this.core.put('host', host);
    this.core.audit(actor, 'host.revoked', hostId, { name: host.name });
    this.core.event({ type: 'host.revoked', source: 'owner', summary: `Host "${host.name}" was revoked`, hostId, data: {} });
    this.core.agents.disconnect(hostId, 'this host has been revoked');
  }

  rename(hostId: string, name: string): Host {
    const host = this.core.hosts.require(hostId);
    host.name = this.uniqueName(name);
    return this.core.put('host', host);
  }

  remove(hostId: string): void {
    const host = this.core.hosts.require(hostId);
    if (host.status === 'online') throw new EngineError('revoke the host before removing it');
    if (this.core.employees.find((e) => e.hostId === hostId && !e.archived)) throw new EngineError('employees are still assigned to this host');
    for (const s of this.core.sessions.filter((x) => x.hostId === hostId)) this.core.remove('session', s.id);
    this.core.remove('host', hostId);
  }
}

// ─────────────────────────── Employees ───────────────────────────

/** A model as the owner chose it: an alias or a full model name — never something that could be read as another option of the CLI. */
function cleanModel(model: string | null | undefined): string | null {
  const m = String(model ?? '').trim();
  if (!m) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:\[\]@/-]{0,99}$/.test(m)) throw new EngineError('a model is an alias such as "opus" or a model\'s full name');
  return m;
}

function cleanEffort(effort: string | null | undefined): EffortLevel | null {
  const v = String(effort ?? '').trim().toLowerCase();
  if (!v) return null;
  if (!EFFORT_CHOICES.some((c) => c.value === v)) throw new EngineError(`effort is one of: ${EFFORT_CHOICES.map((c) => c.value).join(', ')}`);
  return v as EffortLevel;
}

/** The most characters (for lists: entries) an employee's fields may have. */
const EMPLOYEE_SIZES: Record<string, number> = { name: 80, title: 160, department: 80, roleKey: 80, specialization: 4000, instructions: 50_000, model: 120, effort: 40, workingDir: 1024, claudeConfigDir: 1024, skills: 100, allowedTools: 200, disallowedTools: 200, alsoProjectIds: 100 };

export interface EmployeeInput {
  name: string;
  claudeConfigDir?: string | null;
  alsoProjectIds?: string[];
  roleKey?: string | null;
  title?: string;
  department?: string;
  specialization?: string;
  skills?: string[];
  appearance?: Partial<Appearance>;
  style?: Employee['style'];
  hostId?: string | null;
  model?: string | null;
  effort?: string | null;
  projectId?: string | null;
  workingDir?: string | null;
  instructions?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  autonomy?: Employee['autonomy'];
  executionMode?: Employee['executionMode'];
  schedule?: Employee['schedule'];
  deskId?: string | null;
  selfDriven?: boolean;
  /** A team lead only: `office` to direct the shared employees too. */
  leadScope?: Employee['leadScope'];
}

export class EmployeeRegistry {
  private eng: Engine;

  constructor(eng: Engine) {
    this.eng = eng;
  }

  private get core() {
    return this.eng.core;
  }

  /**
   * Is this seat in the room of the member whose machine `hostId` is? A room is a member's, not a machine's: whoever
   * works on that member's computer or on a server they keep to themselves sits in the one room, so a seat named
   * after any of those machines will do.
   */
  private sameRoom(seatHostId: string | null | undefined, hostId: string | null | undefined): boolean {
    const member = this.eng.hosts.memberOfHost(hostId);
    return !!member && !!seatHostId && this.eng.hosts.memberOfHost(seatHostId) === member;
  }

  freeDesk(preferZone?: string): string | null {
    const taken = new Set(this.core.employees.filter((e) => !e.archived && !!e.deskId).map((e) => e.deskId));
    const desks = this.core.layout.desks.filter((d) => !taken.has(d.id));
    return (preferZone ? desks.find((d) => d.zone === preferZone) : undefined)?.id ?? desks[0]?.id ?? null;
  }

  /**
   * A desk for someone on a project: next to their project colleagues if there is room, otherwise
   * in a part of the floor nobody else has claimed, so each project gathers in its own area.
   */
  deskFor(projectId: string | null | undefined, exceptEmployeeId?: string): string | null {
    if (!projectId) return this.freeDesk();
    const seated = this.core.employees.filter((e) => !e.archived && !!e.deskId && e.id !== exceptEmployeeId);
    const taken = new Set(seated.map((e) => e.deskId));
    const byId = new Map(this.core.layout.desks.map((d) => [d.id, d]));
    const free = this.core.layout.desks.filter((d) => !taken.has(d.id) && d.kind !== 'executive');
    if (!free.length) return null;
    const colleagues = seated.filter((e) => e.projectId === projectId).map((e) => byId.get(e.deskId!)).filter((d): d is NonNullable<typeof d> => !!d);
    // How many people of other projects already sit in each pod.
    const strangers = new Map<string, number>();
    for (const e of seated) {
      const d = byId.get(e.deskId!);
      if (d && e.projectId !== projectId) strangers.set(podOf(d.id), (strangers.get(podOf(d.id)) ?? 0) + 1);
    }
    const cx = colleagues.length ? colleagues.reduce((n, d) => n + d.x, 0) / colleagues.length : 0;
    const cz = colleagues.length ? colleagues.reduce((n, d) => n + d.z, 0) / colleagues.length : 0;
    // With colleagues: as close to them as possible, and rather not in another project's pod.
    // Without: the pod with the fewest other people (an empty one first), in layout order.
    const cost = (d: { id: string; x: number; z: number }): number => (colleagues.length ? Math.hypot(d.x - cx, d.z - cz) : 0) + (strangers.get(podOf(d.id)) ?? 0) * 4;
    return free.map((d, i) => ({ d, c: cost(d), i })).sort((a, b) => a.c - b.c || a.i - b.i)[0]!.d.id;
  }

  /**
   * What is on a member's own computer stays there: a personal employee works on projects on that same computer, and
   * a shared employee is not put on a project that lives on someone's computer.
   */
  private assertSameComputer(hostId: string | null, projectIds: Array<string | null | undefined>): void {
    const mine = this.eng.hosts.memberOfHost(hostId);
    for (const pid of projectIds) {
      const p = pid ? this.core.projects.get(pid) : undefined;
      if (!p) continue;
      const theirs = this.eng.hosts.memberOfHost(p.hostId);
      if ((mine || theirs) && p.hostId !== hostId) throw new EngineError(mine ? `"${p.name}" is not on this computer. An employee on a member's own computer works on projects on that computer.` : `"${p.name}" is on a member's own computer; only employees on that computer can work on it.`);
    }
  }

  /**
   * The foreman is one for the whole office, runs on one of the office's own machines, and has no desk.
   * Throws when making `self` (or a new employee) the foreman would break that.
   */
  private assertCanBeForeman(hostId: string | null | undefined, selfId: string | null): void {
    const other = this.core.employees.find((e) => !e.archived && e.roleKey === 'foreman' && e.id !== selfId);
    if (other) throw new EngineError(`the office already has a foreman (${other.name}). There is one foreman, and it looks after the whole office: the shared floor and every member's room.`);
    if (this.eng.hosts.memberOfHost(hostId)) throw new EngineError("the foreman runs on one of the office's own machines, not on a member's own computer: it looks after the whole office from there.");
  }

  /**
   * A team lead is a member's: it sits on that member's own computer (or a server they keep to themselves), and a
   * member has one. Throws when making `self` (or a new employee) a lead would break that.
   */
  private assertCanBeLead(hostId: string | null | undefined, selfId: string | null): void {
    const member = this.eng.hosts.memberOfHost(hostId);
    if (!member) throw new EngineError("a team lead works for one member and sits on that member's own computer or server, not on a shared machine of the office. (The whole office has the foreman.)");
    const other = this.eng.lead.leadOf(member, selfId);
    if (other) throw new EngineError(`${this.core.hosts.get(hostId ?? '')?.memberName ?? 'this member'} already has a team lead (${other.name}). A member has one.`);
  }

  /**
   * A member takes a shared employee among their own, or gives them back (`member` null). It changes where the employee
   * is listed and whose team lead may direct them — not who may see or use them. One member at a time: somebody
   * else's is taken over only by an owner (`force`).
   */
  keep(id: string, member: { id: string; name: string } | null, actor = 'owner', force = false): Employee {
    const e = this.core.employees.require(id);
    if (e.archived) throw new EngineError(`${e.name} no longer works here`);
    if (directsOthers(e.roleKey)) throw new EngineError(`${e.name} is ${e.roleKey === 'foreman' ? "the office's foreman" : "a member's team lead"}, not somebody to take among one's own.`);
    if (this.eng.hosts.memberOfHost(e.hostId)) throw new EngineError(`${e.name} is on a member's own computer: they are that member's already.`);
    const now = e.keptBy ?? null;
    if (member && now && now.id !== member.id && !force) throw new EngineError(`${e.name} is looked after by ${now.name}. They give them back first, or an owner of the office moves them.`);
    if ((now?.id ?? null) === (member?.id ?? null)) return e;
    if (member) e.keptBy = { id: member.id, name: member.name };
    else delete e.keptBy;
    this.core.put('employee', e);
    this.core.audit(actor, member ? 'employee.kept' : 'employee.given_back', id, { name: e.name, by: member?.name ?? now?.name ?? null });
    this.core.event({ type: 'employee.updated', source: 'owner', summary: member ? `${member.name} looks after ${e.name} now` : `${e.name} is nobody's in particular again`, employeeId: id, data: { fields: ['keptBy'], quiet: true } });
    return e;
  }

  /** Offices from before the foreman walked the floor: whoever has that role gives up their desk. */
  unseatForemen(): void {
    for (const e of this.core.employees.filter((x) => x.roleKey === 'foreman' && !!x.deskId)) {
      e.deskId = null;
      this.core.put('employee', e);
    }
  }

  create(input: EmployeeInput, actor = 'owner', by: { hiredBy?: string | null } = {}): Employee {
    within(input as unknown as Record<string, unknown>, EMPLOYEE_SIZES);
    const name = input.name?.trim();
    if (!name) throw new EngineError('an employee needs a name');
    if (this.core.employees.find((e) => !e.archived && e.name.toLowerCase() === name.toLowerCase())) throw new EngineError(`an employee named "${name}" already exists`);
    const role = input.roleKey ? (roleByKey(input.roleKey) ?? matchRole(input.roleKey)) : undefined;
    if (input.autonomy != null && !isAutonomyLevel(input.autonomy)) throw new EngineError(notALevel(input.autonomy));
    if (input.hostId && !this.core.hosts.get(input.hostId)) throw new EngineError('unknown host');
    if (input.projectId && !this.core.projects.get(input.projectId)) throw new EngineError('unknown project');
    // On a member's own computer: they sit in that member's room (at a seat of their choice there, or the next free
    // one), never at a desk of the shared office.
    const personal = !!this.eng.hosts.memberOfHost(input.hostId);
    const foreman = role?.key === 'foreman';
    if (foreman) {
      this.assertCanBeForeman(input.hostId, null);
      if (input.deskId) throw new EngineError('a foreman has no desk: it walks the floor');
    }
    const lead = role?.key === LEAD_ROLE;
    if (lead) this.assertCanBeLead(input.hostId, null);
    if (lead && input.autonomy === 'unrestricted') throw new EngineError('a team lead hands work on and hires; it does not run without permission checks');
    const seat = memberSeatOf(input.deskId);
    if (input.deskId && !personal && !this.core.layout.desks.find((d) => d.id === input.deskId)) throw new EngineError('unknown desk');
    if (input.deskId && personal && !this.sameRoom(seat?.hostId, input.hostId)) throw new EngineError('that seat is not in this member\'s room');
    if (input.deskId && this.core.employees.find((e) => !e.archived && e.deskId === input.deskId)) throw new EngineError('that desk is taken');
    this.assertSameComputer(input.hostId ?? null, [input.projectId, ...(input.alsoProjectIds ?? [])]);
    const employee: Employee = {
      id: newId(),
      name,
      title: input.title?.trim() || role?.title || 'Engineer',
      department: input.department?.trim() || role?.department || 'Engineering',
      roleKey: role?.key ?? 'custom',
      specialization: input.specialization ?? role?.specialization ?? '',
      skills: input.skills ?? role?.skills ?? [],
      appearance: { ...defaultAppearance(name, role?.color), ...(input.appearance ?? {}) },
      style: input.style ?? 'concise',
      hostId: input.hostId ?? this.core.hosts.find((h) => h.local && h.status !== 'revoked')?.id ?? null,
      // A lead reads and hands on: unless something else is asked for, the lightest model, working lightly.
      model: cleanModel(input.model) ?? (lead ? LEAD_MODEL : null),
      effort: cleanEffort(input.effort) ?? (lead ? LEAD_EFFORT : null),
      projectId: input.projectId ?? null,
      workingDir: input.workingDir ?? null,
      instructions: input.instructions ?? '',
      allowedTools: input.allowedTools ?? [],
      disallowedTools: input.disallowedTools ?? role?.disallowedTools ?? [],
      autonomy: input.autonomy ?? 'standard',
      executionMode: input.executionMode ?? 'interactive_cli',
      schedule: input.schedule ?? { available: true },
      alsoProjectIds: [...new Set((input.alsoProjectIds ?? []).map(String))].filter((p) => p !== input.projectId && !!this.core.projects.get(p)),
      deskId: foreman ? null : personal ? (seat ? input.deskId! : null) : (input.deskId ?? this.deskFor(input.projectId)),
      xp: 0,
      level: 1,
      badges: [],
      stats: { tasksCompleted: 0, testsPassed: 0, bugsFixed: 0, reviewsCompleted: 0, assists: 0, deliverablesAccepted: 0 },
      createdAt: nowIso(),
      archived: false,
      ...(by.hiredBy ? { hiredBy: by.hiredBy } : {}),
      ...(lead ? { leadScope: input.leadScope === 'office' ? ('office' as const) : ('own' as const) } : {}),
      ...(input.selfDriven ? { selfDriven: true } : {}),
      // Which Claude account of their machine they run on, when the hire names one (else the machine's default login).
      ...(accountDirOf(input.claudeConfigDir) ? { claudeConfigDir: accountDirOf(input.claudeConfigDir) } : {}),
    };
    this.core.put('employee', employee);
    this.core.audit(actor, 'employee.created', employee.id, { name, role: employee.roleKey });
    this.core.event({ type: 'employee.created', source: actor.startsWith('owner') ? 'owner' : 'server', summary: `${name} joined as ${employee.title}`, employeeId: employee.id, projectId: employee.projectId, data: { role: employee.roleKey } });
    // Hiring a foreman is asking for its rounds.
    if (foreman) this.eng.foreman.onHired();
    return employee;
  }

  update(id: string, patch: Partial<EmployeeInput> & { archived?: boolean }, actor = 'owner'): Employee {
    within(patch as unknown as Record<string, unknown>, EMPLOYEE_SIZES);
    // Worked out on a copy and stored at the end: a change that is refused half-way leaves the employee as they were.
    const e = structuredClone(this.core.employees.require(id));
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new EngineError('name cannot be empty');
      if (this.core.employees.find((x) => x.id !== id && !x.archived && x.name.toLowerCase() === name.toLowerCase())) throw new EngineError(`an employee named "${name}" already exists`);
      e.name = name;
    }
    if (patch.roleKey !== undefined && patch.roleKey) {
      const role = roleByKey(patch.roleKey);
      e.roleKey = role?.key ?? 'custom';
      if (role && patch.title === undefined) e.title = role.title;
      if (role && patch.department === undefined) e.department = role.department;
      if (role && patch.skills === undefined) e.skills = role.skills;
      if (role && patch.specialization === undefined) e.specialization = role.specialization;
    }
    if (patch.deskId && e.roleKey === 'foreman') throw new EngineError('a foreman has no desk: it walks the floor');
    if (patch.deskId !== undefined && patch.deskId !== e.deskId) {
      // A desk of the shared office, or — for someone on a member's own computer — a seat in that member's room.
      const seat = memberSeatOf(patch.deskId);
      const mine = !!this.eng.hosts.memberOfHost(e.hostId);
      if (patch.deskId && (mine ? !this.sameRoom(seat?.hostId, e.hostId) : !this.core.layout.desks.find((d) => d.id === patch.deskId))) throw new EngineError(mine ? 'that seat is not in this member\'s room' : 'unknown desk');
      const occupant = patch.deskId ? this.core.employees.find((x) => x.id !== id && !x.archived && x.deskId === patch.deskId) : undefined;
      if (occupant) {
        // Changing workstation with someone sitting there: they swap desks.
        occupant.deskId = e.deskId;
        this.core.put('employee', occupant);
      }
      e.deskId = patch.deskId ?? null;
    }
    if (patch.hostId !== undefined && patch.hostId !== e.hostId) {
      if (patch.hostId && !this.core.hosts.get(patch.hostId)) throw new EngineError('unknown host');
      if (this.core.runningSessionOf(id)) throw new EngineError('stop the running session before moving this employee to another machine');
      e.hostId = patch.hostId;
    }
    if (patch.projectId !== undefined) {
      if (patch.projectId && !this.core.projects.get(patch.projectId)) throw new EngineError('unknown project');
      const moved = patch.projectId !== e.projectId;
      e.projectId = patch.projectId;
      // Moved to another project by the owner: sit with the new colleagues, unless a desk was chosen by hand.
      if (moved && patch.projectId && patch.deskId === undefined && e.deskId) {
        const pods = new Set(this.core.employees.filter((x) => !x.archived && x.id !== id && x.projectId === patch.projectId && !!x.deskId).map((x) => podOf(x.deskId!)));
        const taken = new Set(this.core.employees.filter((x) => !x.archived && !!x.deskId).map((x) => x.deskId));
        const seat = pods.has(podOf(e.deskId)) ? undefined : this.core.layout.desks.find((d) => pods.has(podOf(d.id)) && !taken.has(d.id) && d.kind !== 'executive');
        if (seat) e.deskId = seat.id;
      }
    }
    if (patch.model !== undefined) patch = { ...patch, model: cleanModel(patch.model) };
    if (patch.effort !== undefined) e.effort = cleanEffort(patch.effort);
    if (patch.autonomy !== undefined && !isAutonomyLevel(patch.autonomy)) throw new EngineError(notALevel(patch.autonomy));
    for (const key of ['title', 'department', 'specialization', 'skills', 'style', 'model', 'workingDir', 'instructions', 'allowedTools', 'disallowedTools', 'autonomy', 'executionMode', 'schedule'] as const) {
      if (patch[key] !== undefined) (e as any)[key] = patch[key];
    }
    if (patch.claudeConfigDir !== undefined) {
      const dir = accountDirOf(patch.claudeConfigDir) ?? '';
      const other = (dir || null) !== (e.claudeConfigDir ?? null);
      e.claudeConfigDir = dir || null;
      // A folder the office may not have asked about yet: asked now, so that the account has its name at once.
      if (other && dir && e.hostId) void this.eng.sessions.learnAccounts(e.hostId, [dir]).catch(() => undefined);
    }
    if (patch.alsoProjectIds !== undefined) {
      const ids = [...new Set((Array.isArray(patch.alsoProjectIds) ? patch.alsoProjectIds : []).map(String))].filter((p) => p !== e.projectId);
      for (const p of ids) if (!this.core.projects.get(p)) throw new EngineError('unknown project in the additional assignments');
      e.alsoProjectIds = ids;
    } else if (e.alsoProjectIds?.includes(e.projectId ?? '')) e.alsoProjectIds = e.alsoProjectIds.filter((p) => p !== e.projectId);
    // Permission rules are typed by the owner: keep only short, single-line strings.
    const rules = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter((x) => x && x.length <= 200 && !/[\r\n]/.test(x)))].slice(0, 100) : []);
    if (patch.allowedTools !== undefined) e.allowedTools = rules(patch.allowedTools);
    if (patch.disallowedTools !== undefined) e.disallowedTools = rules(patch.disallowedTools);
    if (patch.appearance) e.appearance = { ...e.appearance, ...patch.appearance };
    if (patch.archived !== undefined) {
      if (patch.archived && this.core.runningSessionOf(id)) throw new EngineError('stop the running session before archiving this employee');
      e.archived = patch.archived;
      if (e.archived) e.deskId = null;
      else if (!e.deskId) e.deskId = this.freeDesk();
    }
    // A lead: its member's, one for each, never Unrestricted; whose employees it directs is the member's to say.
    if (e.roleKey === LEAD_ROLE && !e.archived) {
      const was = this.core.employees.require(id);
      if (was.roleKey !== LEAD_ROLE || patch.hostId !== undefined || (patch.archived === false && was.archived)) this.assertCanBeLead(e.hostId, id);
      if (e.autonomy === 'unrestricted') throw new EngineError('a team lead hands work on and hires; it does not run without permission checks');
      if (patch.leadScope !== undefined || !e.leadScope) e.leadScope = (patch.leadScope ?? e.leadScope) === 'office' ? 'office' : 'own';
    } else if (e.leadScope) delete e.leadScope;
    // No longer the foreman: back at a desk like everyone else.
    if (e.roleKey !== 'foreman' && this.core.employees.require(id).roleKey === 'foreman' && !e.archived && !e.deskId && !this.eng.hosts.memberOfHost(e.hostId)) e.deskId = this.freeDesk();
    const becameForeman = e.roleKey === 'foreman' && (this.core.employees.require(id).roleKey !== 'foreman' || (patch.archived === false && this.core.employees.require(id).archived));
    if (e.roleKey === 'foreman' && !e.archived) {
      if (becameForeman || patch.hostId !== undefined) this.assertCanBeForeman(e.hostId, id);
      e.deskId = null;
    }
    this.assertSameComputer(e.hostId, [e.projectId, ...(e.alsoProjectIds ?? [])]);
    if (this.eng.hosts.memberOfHost(e.hostId) && !this.sameRoom(memberSeatOf(e.deskId)?.hostId, e.hostId)) e.deskId = null;
    else if (!this.eng.hosts.memberOfHost(e.hostId) && memberSeatOf(e.deskId)) e.deskId = this.freeDesk();
    // What a running session was started with and cannot change while it runs: how far it is trusted, which Claude
    // account it uses, which model and effort. A change of any of them starts the session again — at once if it is
    // idle, at the end of its turn if not — so that nobody goes on working "on the old one".
    const was = this.core.employees.require(id);
    const LEVEL: Record<string, string> = { standard: 'Standard', auto: 'Auto', unrestricted: 'Unrestricted' };
    const changed = [
      was.autonomy !== e.autonomy ? `your level is now ${LEVEL[e.autonomy] ?? e.autonomy}` : '',
      (was.claudeConfigDir ?? null) !== (e.claudeConfigDir ?? null) ? 'you were put on another Claude account' : '',
      (was.model ?? null) !== (e.model ?? null) || (was.effort ?? null) !== (e.effort ?? null) ? 'your model or effort was changed' : '',
    ].filter(Boolean);
    this.core.put('employee', e);
    if (changed.length && !e.archived) this.eng.sessions.restartForChange(id, changed.join(', and '));
    // What an employee may do without asking is on the record in full, not just as a field name.
    this.core.audit(actor, 'employee.updated', id, { fields: Object.keys(patch), ...(patch.allowedTools !== undefined ? { allowedTools: e.allowedTools } : {}), ...(patch.disallowedTools !== undefined ? { disallowedTools: e.disallowedTools } : {}) });
    this.core.event({ type: 'employee.updated', source: 'owner', summary: `${e.name}'s profile was updated`, employeeId: id, data: { fields: Object.keys(patch), quiet: true } });
    if (becameForeman && !e.archived) this.eng.foreman.onHired();
    return e;
  }

  /** Find by name, or create with the given role (used when attaching sessions from the CLI). */
  findOrCreate(name: string, roleRef: string | null | undefined, hostId: string): { employee: Employee; created: boolean } {
    const existing = this.core.employeeByName(name);
    if (existing) return { employee: existing, created: false };
    const role = roleRef ? (roleByKey(roleRef) ?? matchRole(roleRef)) : undefined;
    if (roleRef && !role) throw new EngineError(`unknown role "${roleRef}". Known roles: ${ROLE_CATALOGUE.map((r) => r.key).join(', ')}`);
    return { employee: this.create({ name, roleKey: role?.key ?? null, hostId }, 'system'), created: true };
  }
}

// ─────────────────────────── Sessions ────────────────────────────

/**
 * Has Claude Code given a sign of life since this session was last started? The prompts it shows before it starts
 * working (trust this folder, the bypass warning) come before any; a session that continues an earlier conversation
 * still carries the time of its last sign from the run before, which must not be mistaken for one.
 */
/**
 * Is this screen one of Claude Code's own questions at the start of a session? Before anything has been heard from
 * the session it may be (it used to be that no hook fires before them; a newer Claude Code may run one first).
 * Afterwards only when Claude Code's input box is not on the screen and a list of answers is — a session that is at
 * work shows the box, and words of such a question in its conversation are not the question.
 */
function atStartDialog(s: AgentSession, screen: TerminalScreen): boolean {
  if (!heardFromSinceStart(s)) return true;
  // Later: the box is not there, and a list of answers with "Yes" among them is — the shape of the question itself.
  return !inputBox(screen.lines) && !!trustPromptKeys(screen.lines);
}

function heardFromSinceStart(s: AgentSession): boolean {
  if (!s.lastEventAt) return false;
  return !s.startedAt || Date.parse(s.lastEventAt) >= Date.parse(s.startedAt);
}

/** How long after losing sight of a session what it was doing is still taken as what it is doing. */
const RESUME_KNOWN_MS = 3 * 60_000;
/** States in which a session waits for something from outside and does nothing by itself. */
const BETWEEN_TURNS = new Set<string>(['idle', 'waiting_input', 'waiting_answer', 'blocked', 'task_complete', 'paused', 'waiting_command']);

/**
 * How large a session's terminal is when it starts. Wide (it was 120 by 34 until 2026-11-13): people watch these on
 * wide screens, and Claude Code's own layout — diffs, tables, long paths — has room. Somebody at the keyboard can
 * still fit it to their window.
 */
export const SESSION_COLS = 160;
export const SESSION_ROWS = 44;

/** Claude Code's warning at the first start in bypass mode (its wording, as in the installed program). */
const BYPASS_WARNING = /Bypass Permissions mode/i;
const TRUST_PROMPT = /(do you trust the files in this folder|trust this folder|is this a project you (created|trust)|accessing workspace)/i;

export class SessionRegistry {
  private eng: Engine;
  private trustAsked = new Set<string>();
  private bypassAsked = new Set<string>();

  /**
   * The first time a Claude account is used in bypass mode, Claude Code shows a warning and asks whoever is at the
   * keyboard to accept responsibility for what runs without checks ("Yes, I accept" / "No, exit"). Nobody is at the
   * keyboard: the owner is asked in the office, once — Claude Code remembers the answer for that account. It is the
   * owner's to accept — and since 2026-11-13 the owner has accepted it once for all (`acceptStartPrompts`): on the
   * office's own machines the office answers "Yes, I accept" for an Unrestricted employee itself. Asked as before
   * when that is switched off, on a member's own computer, or when the warning's options cannot be read.
   */
  private bypassWarningOnScreen(sessionId: string, screen: TerminalScreen): void {
    if (this.bypassAsked.has(sessionId)) return;
    const s = this.core.sessions.get(sessionId);
    if (!s || s.status !== 'running' || s.origin !== 'managed' || s.mode !== 'interactive_cli' || !atStartDialog(s, screen)) return;
    const text = screen.lines.join('\n').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    if (!BYPASS_WARNING.test(text) || !/Yes, I accept/.test(text)) return;
    this.bypassAsked.add(sessionId);
    const employee = this.core.employees.get(s.employeeId) ?? null;
    const host = this.core.hosts.get(s.hostId);
    // The owner's standing word (Settings → Employees, on unless switched off): for somebody an owner put on
    // Unrestricted, on one of the office's own machines, the office chooses "Yes, I accept" itself — on the record.
    // On a member's own computer the warning is about that member's machine and is never accepted for them.
    if (this.core.settings.acceptStartPrompts !== false && employee?.autonomy === 'unrestricted' && !this.eng.hosts.memberOfHost(s.hostId)) {
      const keys = trustPromptKeys(screen.lines);
      if (keys) {
        void this.core.agents
          .rpc(s.hostId, { method: 'session.keys', params: { sessionId: s.id, keys } })
          .then(() => {
            this.core.audit('system', 'bypass.auto_accepted', s.id, { employee: employee.name, host: host?.name ?? s.hostId, account: employee.claudeConfigDir ?? 'default' });
            this.core.event({ type: 'session.started', source: 'server', summary: `${employee.name} is on Unrestricted: Claude Code's warning about running without permission checks was accepted for them on ${host?.name ?? 'that machine'}, as the owner asked (Settings → Employees)`, sessionId: s.id, employeeId: employee.id, hostId: s.hostId, data: { bypassWarning: 'auto' } });
          })
          .catch(() => this.bypassAsked.delete(sessionId));
        return;
      }
    }
    this.setActivity(s, 'needs_approval', 'Claude Code asks you to accept running without permission checks');
    this.eng.comms.createQuestion({
      kind: 'trust_prompt',
      channel: 'terminal',
      employee,
      session: s,
      text: `Claude Code asks you to accept responsibility before ${employee?.name ?? 'this session'} can run without permission checks on ${host?.name ?? 'that machine'}.`,
      context: 'Claude Code\'s own warning, shown once per Claude account: "In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands. This mode should only be used in a sandboxed container/VM that has restricted internet access and can easily be restored if damaged. By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode."',
      why: `${employee?.name ?? 'The employee'} is set to Unrestricted. The session waits at this warning; "No" ends it (put the employee on Auto instead).`,
      tool: { name: 'bypass_warning', input: { hostId: s.hostId, account: employee?.claudeConfigDir ?? null } },
      options: [
        { label: 'Yes, I accept', description: 'Choose "Yes, I accept" on the warning', consequence: 'The session starts in bypass mode; Claude Code does not ask again for this account on this machine.' },
        { label: 'Decide in the terminal', description: 'Leave the warning for you to answer at the workstation' },
      ],
    });
  }
  /** Sessions whose screen shows a permission prompt nobody is asking about yet, and the timer that asks once it has stood a moment. */
  private promptTimers = new Map<string, NodeJS.Timeout>();

  /**
   * A permission prompt that stands in a session's terminal with nobody in the office asked about it — because the
   * wait for an answer ran out, or the office was restarted while it waited. The employee sits there until someone
   * answers, so the office asks again: an ordinary approval request, answered from the office with the keys the
   * prompt itself shows. `now`: ask at once (the office knows the hook has just given up); otherwise only after the
   * prompt has stood for a moment, so that a request still on its way through the hook is not asked twice.
   * Returns whether a request is (now) open for it.
   */
  promptOnScreen(sessionId: string, now = false, screen: TerminalScreen | undefined = this.core.gateway.screens.get(sessionId)): boolean {
    const s = this.core.sessions.get(sessionId);
    if (!s || s.status !== 'running' || s.origin !== 'managed' || s.mode !== 'interactive_cli') return false;
    const open = this.core.questions.find((q) => q.sessionId === s.id && q.status === 'open' && q.kind === 'permission');
    const prompt = screen ? permissionPrompt(screen.lines) : null;
    const clear = () => {
      const t = this.promptTimers.get(s.id);
      if (t) clearTimeout(t);
      this.promptTimers.delete(s.id);
    };
    if (!prompt) {
      clear();
      // Gone from the screen while the office was still asking: somebody answered it at the terminal.
      if (open?.channel === 'terminal') this.eng.comms.supersede(open.id, 'The prompt was answered in the terminal.');
      return false;
    }
    if (open) return true;
    if (!now) {
      if (!this.promptTimers.has(s.id)) {
        const t = setTimeout(() => {
          this.promptTimers.delete(s.id);
          this.promptOnScreen(s.id, true);
        }, this.core.timings.terminalPromptMs ?? 5000);
        t.unref?.();
        this.promptTimers.set(s.id, t);
      }
      return false;
    }
    clear();
    const employee = this.core.employees.get(s.employeeId) ?? null;
    this.setActivity(s, 'needs_approval', 'Waiting at a permission prompt in the terminal');
    this.eng.comms.createQuestion({
      kind: 'permission',
      channel: 'terminal',
      employee,
      session: s,
      text: `${employee?.name ?? 'This session'} is waiting at a permission prompt in the terminal: ${truncate(prompt.what.replace(/\s+/g, ' '), 300) || 'see the terminal'}`,
      context: prompt.what,
      why: 'Claude Code is showing its own prompt in the terminal and the session does nothing until it is answered. Your answer is given there for you (the plain "Yes" or "No" of the prompt).',
      options: [
        { label: 'Allow', description: 'Choose "Yes" on the prompt: this one action runs' },
        { label: 'Deny', description: 'Choose "No" on the prompt: the agent is told and continues without it' },
      ],
    });
    return true;
  }
  private starting = new Map<string, Promise<AgentSession>>();

  constructor(eng: Engine) {
    this.eng = eng;
  }

  private get core() {
    return this.eng.core;
  }

  /** Re-derive state after a server restart: nothing is assumed to be running until a host says so. */
  restore(): void {
    for (const s of this.core.sessions.all()) {
      if (s.status === 'running' || s.status === 'starting') {
        s.status = 'host_offline';
        this.rememberActivity(s);
        s.activity = 'unknown';
        s.activityDetail = 'Waiting for the host to reconnect';
        // (What runs in its background its machine says again when it is back.)
        s.background = null;
        s.control = 'DISCONNECTED';
        s.controllerId = null;
        this.core.sessions.put(s);
      }
    }
  }

  setActivity(session: AgentSession, state: ActivityState, detail: string | null, opts: { silent?: boolean } = {}): void {
    // Between turns with nothing else going on while a command runs in the background: waiting for it (`Background`).
    [state, detail] = this.eng.background.instead(session, state, detail);
    if (session.activity === state && session.activityDetail === detail) return;
    const changed = session.activity !== state;
    session.activity = state;
    session.activityDetail = detail;
    if (changed) session.activitySince = nowIso();
    this.core.put('session', session);
    if (changed && !opts.silent) {
      const emp = this.core.employees.get(session.employeeId);
      this.core.event({
        type: 'session.activity',
        source: 'server',
        summary: `${emp?.name ?? 'Session'} → ${state}`,
        sessionId: session.id,
        employeeId: session.employeeId,
        hostId: session.hostId,
        data: { state, detail, quiet: true },
      });
    }
  }

  /** Kept for the moment sight of the session comes back (see `AgentSession.activityBefore`). */
  private rememberActivity(s: AgentSession): void {
    if (s.activity !== 'unknown' && s.activity !== 'offline') s.activityBefore = { state: s.activity, detail: s.activityDetail ?? null, at: nowIso() };
  }

  hostWentOffline(s: AgentSession): void {
    s.status = 'host_offline';
    this.rememberActivity(s);
    s.activity = 'unknown';
    s.activityDetail = 'Host is offline — the tmux session keeps running';
    s.activitySince = nowIso();
    s.background = null;
    this.eng.background.forget(s.id);
    this.core.put('session', s);
    this.core.gateway.refresh(s.id);
  }

  private fromReport(hostId: string, r: AgentSessionReport, existing?: AgentSession): AgentSession {
    const now = nowIso();
    const base: AgentSession =
      existing ??
      ({
        id: r.sessionId,
        employeeId: null,
        hostId,
        origin: r.origin,
        mode: r.mode,
        tmuxSession: r.tmuxSession,
        tmuxPane: r.tmuxPane,
        cwd: r.cwd,
        repoRoot: r.repoRoot,
        branch: r.branch,
        claudeSessionId: r.claudeSessionId,
        status: 'starting',
        activity: 'unknown',
        activityDetail: null,
        activitySince: now,
        inTurn: null,
        control: 'AGENT_CONTROLLED',
        controllerId: null,
        capabilities: r.capabilities,
        permissionMode: r.permissionMode,
        ...(typeof r.hooksVersion === 'number' ? { hooksVersion: r.hooksVersion } : {}),
        model: r.model,
        cols: r.cols,
        rows: r.rows,
        pid: r.pid,
        usage: null,
        startedAt: r.startedAt,
        endedAt: null,
        lastEventAt: null,
        exitReason: null,
      } satisfies AgentSession);
    return base;
  }

  /** A host reported the state of one of its sessions. */
  onReport(hostId: string, r: AgentSessionReport): AgentSession {
    const existing = this.core.sessions.get(r.sessionId);
    if (existing && existing.hostId !== hostId) throw new EngineError('session belongs to another host');
    // A report about a launch that has since been replaced (stop followed by start) says nothing about the current one.
    if (existing?.launchId && r.launchId && r.launchId !== existing.launchId) return existing;
    // Put to sleep by the office and not started since: the host saying that it has ended is not news.
    if (existing?.asleepSince && !r.alive && existing.status === 'exited') return existing;
    const s = this.fromReport(hostId, r, existing);
    const wasRunning = existing && (existing.status === 'running' || existing.status === 'starting');
    const sizeChanged = !!existing && (existing.cols !== r.cols || existing.rows !== r.rows);
    const wasOffline = existing?.status === 'host_offline';
    s.tmuxSession = r.tmuxSession;
    s.tmuxPane = r.tmuxPane;
    s.cwd = r.cwd;
    s.repoRoot = r.repoRoot;
    s.branch = r.branch;
    s.pid = r.pid;
    s.cols = r.cols;
    s.rows = r.rows;
    s.capabilities = r.capabilities;
    s.mode = r.mode;
    s.permissionMode = r.permissionMode ?? s.permissionMode;
    if (typeof r.hooksVersion === 'number') s.hooksVersion = r.hooksVersion;
    s.model = r.model ?? s.model;
    s.claudeSessionId = r.claudeSessionId ?? s.claudeSessionId;
    s.startedAt = r.startedAt;
    const employee = this.core.employees.get(s.employeeId);
    if (r.alive) {
      const wasDead = !existing || existing.status === 'exited' || existing.status === 'lost';
      s.status = 'running';
      s.endedAt = null;
      s.exitReason = null;
      if (wasDead || wasOffline || s.activity === 'offline') {
        // We just (re)gained sight of this session; do not guess what it is doing — except after a short absence
        // (a restart of the office, a blip of the link) of a session that was between turns: nothing types into a
        // session but the office, so it is still where it was. (One that was in a turn says so itself in a moment:
        // its hooks waited for the office, or come from the agent's outbox.)
        const before = s.activityBefore;
        const still = !!before && wasOffline && !wasDead && s.capabilities.hooks && s.inTurn === false && Date.now() - Date.parse(before.at) < RESUME_KNOWN_MS && BETWEEN_TURNS.has(before.state);
        if (still) {
          s.activity = before!.state;
          s.activityDetail = before!.detail;
        } else {
          s.activity = 'unknown';
          s.activityDetail = s.capabilities.hooks ? 'Waiting for the next signal from Claude Code' : 'No hooks on this session — activity cannot be observed, only the terminal';
          s.activitySince = nowIso();
        }
      }
      s.activityBefore = null;
      if (!existing && r.origin === 'attached') {
        this.core.event({ type: 'session.attached', source: 'host', summary: `Existing tmux session "${r.tmuxSession}" was connected`, hostId, sessionId: s.id, employeeId: s.employeeId, data: { tmuxSession: r.tmuxSession, cwd: r.cwd } });
      }
    } else {
      s.status = 'exited';
      s.exitReason = r.exitReason ?? 'process exited';
      s.endedAt = s.endedAt ?? nowIso();
      s.activity = 'offline';
      s.activityDetail = s.exitReason;
      s.background = null;
      this.eng.background.forget(s.id);
      if (wasRunning) this.sessionDied(s, employee, s.exitReason);
    }
    this.core.put('session', s);
    this.core.gateway.refresh(s.id);
    if (sizeChanged || wasOffline) void this.core.gateway.resync(s.id);
    if (r.alive && employee) this.eng.comms.schedulePump(employee.id);
    return s;
  }

  /** Full sync after a host (re)connects: anything it no longer reports is gone. */
  onSync(hostId: string, reports: AgentSessionReport[]): void {
    const seen = new Set(reports.map((r) => r.sessionId));
    for (const r of reports) {
      try {
        this.onReport(hostId, r);
      } catch (e) {
        this.core.log('warn', `session report rejected: ${(e as Error).message}`);
      }
    }
    for (const s of this.core.sessions.filter((x) => x.hostId === hostId && !seen.has(x.id) && (x.status === 'running' || x.status === 'starting' || x.status === 'host_offline'))) {
      this.onGone(hostId, s.id, 'the host no longer has this session');
    }
    void this.core.gateway.hostReconnected([...seen]);
    // Whoever on this machine has something waiting and no session is looked at again now that it is back.
    this.eng.comms.hostBack(hostId);
    this.eng.tasks.schedule();
    // (A little later: the machine has just come back, and its sessions have just been seen again.)
    setTimeout(() => this.restartIdleOn(hostId), 1500).unref?.();
    // Approved work that could not be merged while this machine was away is merged now.
    setTimeout(() => this.eng.tasks.mergeWaiting(hostId), 2000).unref?.();
  }

  /**
   * A host says one of its sessions ended. Such a report can be about a previous incarnation
   * (the employee was stopped and started again in the meantime), so it only counts when it is
   * about the launch the office currently knows, and never while a start is in flight —
   * the start's own result says what is running.
   */
  onHostReportedGone(hostId: string, sessionId: string, reason: string, launchId?: string | null): void {
    const s = this.core.sessions.get(sessionId);
    if (!s || s.hostId !== hostId) return;
    if (s.employeeId && this.starting.has(s.employeeId)) return;
    if (launchId && s.launchId && launchId !== s.launchId) return;
    this.onGone(hostId, sessionId, reason);
  }

  /** Sessions that are being stopped on purpose right now, with why (see `stop`). */
  private onPurpose = new Map<string, string>();

  onGone(hostId: string, sessionId: string, reason: string): void {
    const s = this.core.sessions.get(sessionId);
    if (!s || s.hostId !== hostId) return;
    const meant = this.onPurpose.get(sessionId);
    if (meant) reason = meant;
    const wasRunning = s.status === 'running' || s.status === 'starting' || s.status === 'host_offline';
    // The office put this one to sleep itself: the host confirming that it is gone changes nothing about why.
    if (s.asleepSince && !wasRunning) return;
    s.status = 'lost';
    s.exitReason = reason;
    s.endedAt = nowIso();
    s.activity = 'offline';
    s.activityDetail = reason;
    s.activitySince = nowIso();
    s.background = null;
    this.eng.background.forget(s.id);
    this.core.put('session', s);
    this.core.gateway.sessionClosed(sessionId, reason);
    if (wasRunning) this.sessionDied(s, this.core.employees.get(s.employeeId), reason, !!meant);
  }

  /** A session the office stopped because it sat idle: ended cleanly, nothing lost, nobody alerted. */
  private fellAsleep(s: AgentSession, employee: Employee, reason: string): void {
    const now = nowIso();
    s.status = 'exited';
    s.exitReason = reason;
    s.endedAt = now;
    s.asleepSince = now;
    s.activity = 'offline';
    s.activityDetail = reason;
    s.activitySince = now;
    s.inTurn = null;
    s.background = null;
    this.eng.background.forget(s.id);
    this.resumeProbes.delete(s.id);
    this.core.put('session', s);
    this.core.gateway.sessionClosed(s.id, reason);
    this.eng.comms.sessionEnded(s.id);
    this.eng.comms.employeeSessionGone(employee.id);
    this.core.event({ type: 'session.asleep', source: 'server', summary: `${employee.name} is ${reason}: the session was stopped to free memory and starts again, where it left off, when they are needed`, hostId: s.hostId, sessionId: s.id, employeeId: employee.id, data: { reason } });
  }

  private outputSeen = new Map<string, { since: number; bytes: number; chunks: number }>();

  /**
   * Terminal output passed through for a session. Its content is never stored; at most once a
   * minute per session the office records how much there was, as a `terminal.output` event.
   */
  noteOutput(sessionId: string, bytes: number): void {
    const now = Date.now();
    let o = this.outputSeen.get(sessionId);
    if (!o) this.outputSeen.set(sessionId, (o = { since: now - TERMINAL_OUTPUT_EVERY_MS, bytes: 0, chunks: 0 }));
    o.bytes += bytes;
    o.chunks++;
    if (now - o.since < TERMINAL_OUTPUT_EVERY_MS) return;
    const s = this.core.sessions.get(sessionId);
    if (!s) return void this.outputSeen.delete(sessionId);
    const who = this.core.employees.get(s.employeeId)?.name ?? s.tmuxSession;
    this.core.event({ type: 'terminal.output', source: 'host', summary: `${who}'s terminal printed ${o.bytes} bytes`, hostId: s.hostId, sessionId, employeeId: s.employeeId ?? null, data: { bytes: o.bytes, chunks: o.chunks, sinceMs: now - o.since, quiet: true } });
    this.outputSeen.set(sessionId, { since: now, bytes: 0, chunks: 0 });
  }

  /**
   * Sessions started as a continuation of an earlier conversation, with the last sign of life they had shown before
   * the start. One that ends without any new sign never got going: Claude Code could not continue that conversation.
   */
  private resumeProbes = new Map<string, string | null>();
  /** Sessions that have had a turn since their last start (a prompt reached them, or a tool ran). */
  private turnSince = new Set<string>();

  /** A prompt or a tool call was seen in this session: its conversation is real. */
  noteTurn(sessionId: string): void {
    this.turnSince.add(sessionId);
  }

  /**
   * A session has ended. `onPurpose`: somebody stopped it, or the office did in order to start it again — that is
   * recorded as a stop, not as a loss: nobody is told that the employee "went offline", and it does not count
   * against how reliable the machines are.
   */
  private sessionDied(s: AgentSession, employee: Employee | undefined, reason: string, onPurpose = false): void {
    if (this.resumeProbes.has(s.id)) {
      const before = this.resumeProbes.get(s.id) ?? null;
      this.resumeProbes.delete(s.id);
      // Never got going: no sign of life since the start — or Claude Code said outright that it has no such
      // conversation. (It still reports the end of that attempt through a hook: a sign of life, but not of a
      // conversation — which is why the first test alone let the same failing start be repeated for ever.)
      const refused = /no conversation found/i.test(reason) && !this.turnSince.has(s.id);
      if (s.lastEventAt === before || refused) {
        // Not tried again with the same conversation: the next start begins a new one, and says so.
        s.lastEventAt = null;
        this.core.put('session', s);
        this.core.event({ type: 'session.stopped', source: 'server', summary: `${employee?.name ?? 'A session'}'s earlier conversation could not be continued (Claude Code ended before it started: ${reason}). The next start begins a new conversation.`, hostId: s.hostId, sessionId: s.id, employeeId: s.employeeId, data: { resumeFailed: true, reason } });
        // Whatever they were woken for is still waiting: one more try, from a clean start.
        if (employee) this.eng.comms.schedulePump(employee.id, 300);
      }
    }
    if (!onPurpose) {
      this.core.company.sessionsLost++;
      this.core.saveCompany();
    }
    this.core.event({
      type: onPurpose ? 'session.stopped' : 'session.lost',
      source: onPurpose ? 'server' : 'host',
      summary: `${employee?.name ?? `Session ${s.tmuxSession}`}'s session ${onPurpose ? 'was stopped' : 'stopped'} (${reason})`,
      hostId: s.hostId,
      sessionId: s.id,
      employeeId: s.employeeId,
      data: { reason, origin: s.origin },
    });
    this.eng.comms.sessionEnded(s.id);
    if (employee) this.eng.comms.employeeSessionGone(employee.id);
    if (employee && !onPurpose) {
      const task = this.eng.tasks.currentTask(employee.id);
      this.eng.comms.notify({
        kind: 'session_lost',
        severity: task ? 'critical' : 'warning',
        title: `${employee.name} went offline`,
        body: task ? `Their session stopped while working on ${task.key} (${reason}). Restart the session to resume the same conversation.` : `Their session stopped (${reason}).`,
        employeeId: employee.id,
        sessionId: s.id,
        taskId: task?.id ?? null,
      });
    }
  }

  /** Claude accounts and what Claude Code last said about their limits, by `<host>|<config folder>`. */
  private accounts = new Map<string, AccountUsage>();
  /** Which model a refused turn said an employee thinks with, when their own setting does not say ("the account's default"). */
  private refusedFamily = new Map<string, string>();
  private accountsLoaded = false;

  private loadAccounts(): void {
    if (this.accountsLoaded) return;
    this.accountsLoaded = true;
    for (const a of this.core.store.kvGet<AccountUsage[]>('accounts', [])) this.accounts.set(a.key, a);
  }

  /** A session's status line reported its account's rate limits. */
  onLimits(hostId: string, msg: { sessionId: string; configDir: string | null; email: string | null; organization: string | null; fiveHour: AccountUsage['fiveHour']; sevenDay: AccountUsage['sevenDay']; windows?: Record<string, { usedPercent: number; resetsAt: string | null }> }): void {
    const s = this.core.sessions.get(msg.sessionId);
    if (!s || s.hostId !== hostId) return;
    this.loadAccounts();
    const key = `${hostId}|${msg.configDir ?? 'default'}`;
    const had = this.accounts.get(key);
    // A model's own week: what a refused turn taught stands until its time; what Claude Code reports itself
    // (`seven_day_<model>`, where it gives one) is the figure from then on.
    const weeks: NonNullable<AccountUsage['modelWeeks']> = {};
    for (const [family, w] of Object.entries(had?.modelWeeks ?? {})) if (w.from === 'refused' && weekFull(w)) weeks[family] = w;
    for (const [name, w] of Object.entries(msg.windows ?? {})) {
      const m = /^(?:seven_day|weekly|week)_([a-z0-9_]+)$/.exec(name);
      const family = m ? modelFamily(m[1]) || m[1]!.replace(/_/g, '-') : '';
      if (family && w && typeof w.usedPercent === 'number') weeks[family] = { usedPercent: w.usedPercent, resetsAt: w.resetsAt ?? null, from: 'reported' };
    }
    this.accounts.set(key, { key, hostId, configDir: msg.configDir, email: msg.email, organization: msg.organization, fiveHour: msg.fiveHour ?? had?.fiveHour ?? null, sevenDay: msg.sevenDay ?? had?.sevenDay ?? null, ...(Object.keys(weeks).length ? { modelWeeks: weeks } : {}), reportedAt: nowIso(), reportedBy: s.employeeId ?? null, employeeIds: [], spentUntil: had?.spentUntil ?? null, provider: had?.provider ?? null, endpoint: had?.endpoint ?? null });
    this.core.store.kvSet('accounts', [...this.accounts.values()]);
    // An account that has just run out — or a model's week on it: its people go to another one, if the machine has one with room.
    for (const [family, w] of Object.entries(weeks)) if (w.from === 'reported' && weekFull(w) && !(had?.modelWeeks?.[family] && weekFull(had.modelWeeks[family]!))) this.switchModels(key, family, w.resetsAt);
    if (exhausted({ fiveHour: msg.fiveHour, sevenDay: msg.sevenDay }) || Object.values(weeks).some(weekFull)) void this.failover();
  }

  /** When each session's last refused turn was taken in (a refusal comes by the hook and again on the screen: once is enough). */
  private refusedAt = new Map<string, number>();
  /** Employees whose last turn was refused, to be told to go on when their session is started again on another model. */
  private refusedTurn = new Set<string>();

  /**
   * A turn ended because Claude refused it for a limit (Claude Code's StopFailure, error "rate_limit"; or its menu
   * "What do you want to do?" on the screen). What the refusal says decides what is done:
   *  - **one model's limit** ("You've hit your Fable limit · resets Nov 19, 1pm (UTC)"): that model counts as used up
   *    on this account until then — not the account. Everybody on this account who thinks with that model goes on,
   *    with the same conversation, with the next model that has room here (`modelFor`: Fable → Opus → Sonnet →
   *    Haiku). Only somebody for whom no model has room here is moved to another account (`failover`). The owner's
   *    order, 2026-11-13: another model first, another organisation only when no other model can.
   *  - **the account's limit**: it counts as used up until the time it names, else its nearest known reset, else an
   *    hour; its people go to another account (`failover`).
   */
  onLimitHit(session: AgentSession, error: string): void {
    const e = this.core.employees.get(session.employeeId ?? '');
    if (!e || !e.hostId) return;
    const last = this.refusedAt.get(session.id);
    if (last && Date.now() - last < 60_000) return;
    this.refusedAt.set(session.id, Date.now());
    this.refusedTurn.add(e.id);
    this.loadAccounts();
    // The account the refused process runs on — which, right after a move, is not the one its employee is on now.
    const dir = session.claudeConfigDir !== undefined ? session.claudeConfigDir : (e.claudeConfigDir ?? null);
    const key = `${e.hostId}|${dir ?? 'default'}`;
    const a = this.accounts.get(key) ?? { key, hostId: e.hostId, configDir: dir, email: null, organization: null, fiveHour: null, sevenDay: null, reportedAt: null, reportedBy: null, employeeIds: [] };
    const read = limitIn(error) ?? { family: '', resetsAt: null };
    // (A refusal that names no model, of a session that runs one: the account is meant.)
    const family = read.family;
    if (family) {
      const week = a.sevenDay?.resetsAt && Date.parse(a.sevenDay.resetsAt) > Date.now() ? a.sevenDay.resetsAt : null;
      // (Until the time it names; else until the week for all models turns; else for a day, and then it is tried again.)
      const until = read.resetsAt ?? week ?? new Date(Date.now() + 24 * 3600_000).toISOString();
      a.modelWeeks = { ...(a.modelWeeks ?? {}), [family]: { usedPercent: 100, resetsAt: until, from: 'refused' } };
      // Their own model may be "whatever the account uses": the refusal says which that is.
      if (!modelFamily(e.model)) this.refusedFamily.set(e.id, family);
      this.accounts.set(key, a);
      this.core.store.kvSet('accounts', [...this.accounts.values()]);
      this.core.log('info', `${e.name}'s turn was refused for the limit of ${family} (${truncate(error, 160)}); on ${a.email ?? a.configDir ?? 'the default account'} ${family} counts as used up until ${until}`);
      this.switchModels(key, family, until);
      void this.failover();
      return;
    }
    const resets = [a.fiveHour, a.sevenDay].filter((w) => !!w && w.usedPercent >= 90 && !!w.resetsAt && Date.parse(w.resetsAt) > Date.now()).map((w) => w!.resetsAt!).sort();
    a.spentUntil = read.resetsAt ?? resets[0] ?? new Date(Date.now() + 60 * 60_000).toISOString();
    this.accounts.set(key, a);
    this.core.store.kvSet('accounts', [...this.accounts.values()]);
    this.core.log('info', `${e.name}'s turn was refused for the account's limit (${truncate(error, 160)}); ${a.email ?? a.configDir ?? 'the default account'} counts as used up until ${a.spentUntil}`);
    void this.failover();
  }

  /**
   * The model a session of this employee is started with on that account: their own — unless that model's limit is
   * reached there, and then the next weaker one that has room there (`MODEL_FALLBACK`). Their own setting is not
   * changed: when the limit lifts, their next start is on their own model again. `instead`: what was passed over.
   */
  modelFor(e: Pick<Employee, 'id' | 'model'>, hostId: string, configDir: string | null): { model: string | null; instead?: { family: string; until: string | null } } {
    const family = modelFamily(e.model) || this.refusedFamily.get(e.id) || '';
    if (!family) return { model: e.model };
    this.loadAccounts();
    const weeks = this.accounts.get(`${hostId}|${configDir ?? 'default'}`)?.modelWeeks ?? {};
    const full = (f: string) => !!weeks[f] && weekFull(weeks[f]!);
    if (!full(family)) return { model: e.model };
    for (const next of MODEL_FALLBACK[family] ?? []) if (!full(next)) return { model: next, instead: { family, until: weeks[family]!.resetsAt } };
    // No model has room here: they are moved to another account (`failover`), or wait where they are.
    return { model: e.model };
  }

  /**
   * One model's limit is reached on an account: every session there that runs that model is started again on the
   * model it goes on with (`modelFor`) — at once when it is between turns, at the end of its turn otherwise — with
   * the same conversation.
   */
  private switchModels(key: string, family: string, until: string | null): void {
    const [hostId] = key.split('|');
    const when = until ? new Date(until).toUTCString().replace(/:00 GMT$/, ' UTC').replace(/^\w+, /, '') : 'it resets';
    for (const s of this.core.sessions.filter((x) => x.hostId === hostId && x.status === 'running' && x.origin === 'managed')) {
      const e = this.core.employees.get(s.employeeId ?? '');
      if (!e || e.archived) continue;
      const dir = s.claudeConfigDir !== undefined ? s.claudeConfigDir : (e.claudeConfigDir ?? null);
      if (`${hostId}|${dir ?? 'default'}` !== key) continue;
      const runs = modelFamily(s.model) || this.refusedFamily.get(e.id) || '';
      if (runs !== family) continue;
      const next = this.modelFor(e, hostId!, dir).model;
      if (!next || modelFamily(next) === family) continue;
      const Name = (f: string) => f.charAt(0).toUpperCase() + f.slice(1);
      this.core.event({ type: 'employee.updated', source: 'server', summary: `${e.name} goes on with ${Name(modelFamily(next) || next)}: ${Name(family)}'s limit is reached on their Claude account until ${when}`, employeeId: e.id, sessionId: s.id, hostId, data: { modelFallback: { from: family, to: next, until } } });
      this.restartForChange(e.id, `${Name(family)}'s limit is reached on your Claude account until ${when}, so you go on with ${Name(modelFamily(next) || next)}`);
    }
  }

  /**
   * Claude Code's own menu after a refused turn — "What do you want to do? 1. Stop and wait for limit to reset /
   * 2. Wait here, then continue automatically at … / 3. Switch to usage credits" — stands in the terminal and the
   * session waits there for ever. The office reads the refusal from the screen (when the hook has not already told
   * it) and acts on it (`onLimitHit`); a session it starts again on another model or account leaves the menu behind
   * with its process. Otherwise it chooses "Stop and wait", which puts Claude Code back at its prompt: never "usage
   * credits" (that spends money — the owner's to decide), never days of waiting inside a turn.
   */
  private limitMenus = new Map<string, number>();
  private limitMenuOnScreen(sessionId: string, screen: TerminalScreen): void {
    const s = this.core.sessions.get(sessionId);
    if (!s || s.status !== 'running' || s.origin !== 'managed' || s.mode !== 'interactive_cli') return;
    const lines = plainScreen(screen.lines);
    const text = lines.join('\n');
    if (!/Stop and wait for (the )?limit to reset/i.test(text) || !/What do you want to do\?/i.test(text)) return;
    const seen = this.limitMenus.get(sessionId);
    if (seen && Date.now() - seen < 20_000) return;
    this.limitMenus.set(sessionId, Date.now());
    // The turn is over: Claude Code waits at its own question.
    s.inTurn = false;
    this.setActivity(s, 'blocked', 'A Claude limit was reached');
    this.core.put('session', s);
    const said = lines.filter((l) => /hit\s+(your|the)\b.*limit|limit.*reset|rate.?limit/i.test(l)).join(' ').trim();
    this.onLimitHit(s, said || 'rate_limit');
    const e = this.core.employees.get(s.employeeId ?? '');
    if (e && (this.restartWhy.has(e.id) || this.restarting.has(e.id))) return void this.restartNow(e.id);
    const keys = menuKeys(screen.lines, (label) => /^Stop and wait/i.test(label));
    if (!keys) return;
    void this.core.agents
      .rpc(s.hostId, { method: 'session.keys', params: { sessionId: s.id, keys } })
      .then(() => this.core.audit('system', 'limit_menu.answered', s.id, { employee: e?.name ?? null, chose: 'Stop and wait for limit to reset' }))
      .catch(() => this.limitMenus.delete(sessionId));
  }

  /**
   * Every Claude account the office's employees use, with the last figures Claude Code reported for
   * each. An account nobody has run a session on yet is listed without figures, not left out.
   */
  accountUsage(): AccountUsage[] {
    this.loadAccounts();
    const out = new Map<string, AccountUsage>();
    for (const e of this.core.employees.filter((x) => !x.archived && !!x.hostId)) {
      const key = `${e.hostId}|${e.claudeConfigDir ?? 'default'}`;
      const known = this.accounts.get(key);
      const row = out.get(key) ?? { ...(known ?? { key, hostId: e.hostId!, configDir: e.claudeConfigDir ?? null, email: null, organization: null, fiveHour: null, sevenDay: null, reportedAt: null, reportedBy: null }), employeeIds: [] };
      row.employeeIds.push(e.id);
      out.set(key, row);
    }
    // A machine nobody has been placed on yet still has its own Claude login: listed too, so its clock hangs on the
    // wall from the start (the office's own machines always; a member's computer while it is connected).
    for (const h of this.core.hosts.filter((x) => x.status !== 'revoked' && (!x.memberId || x.status === 'online'))) {
      const key = `${h.id}|default`;
      if (out.has(key)) continue;
      const known = this.accounts.get(key);
      out.set(key, { ...(known ?? { key, hostId: h.id, configDir: null, email: null, organization: null, fiveHour: null, sevenDay: null, reportedAt: null, reportedBy: null }), employeeIds: [] });
    }
    // The accounts the owner added to a machine, whether or not anybody is on them yet.
    for (const h of this.core.hosts.filter((x) => x.status !== 'revoked')) {
      for (const dir of h.claudeAccounts ?? []) {
        const key = `${h.id}|${dir}`;
        if (out.has(key)) continue;
        const known = this.accounts.get(key);
        out.set(key, { ...(known ?? { key, hostId: h.id, configDir: dir, email: null, organization: null, fiveHour: null, sevenDay: null, reportedAt: null, reportedBy: null }), employeeIds: [] });
      }
    }
    // A window whose reset time has passed is no longer what the figure says.
    const now = Date.now();
    for (const row of out.values()) {
      for (const k of ['fiveHour', 'sevenDay'] as const) if (row[k]?.resetsAt && Date.parse(row[k]!.resetsAt!) < now) row[k] = { usedPercent: 0, resetsAt: null };
      if (row.modelWeeks) {
        const still = Object.fromEntries(Object.entries(row.modelWeeks).filter(([, w]) => !w.resetsAt || Date.parse(w.resetsAt) > now));
        if (Object.keys(still).length) row.modelWeeks = still;
        else delete row.modelWeeks;
      }
      row.exhausted = exhausted(row);
      const login = this.logins.get(row.key);
      row.loggedIn = login ? login.loggedIn : row.email ? true : null;
      if (login?.email && !row.email) row.email = login.email;
    }
    return [...out.values()].sort((a, b) => (b.sevenDay?.usedPercent ?? -1) - (a.sevenDay?.usedPercent ?? -1));
  }

  /** Tell a session's machine to let one exact tool call through, once, in the next ten minutes (the owner allowed it after Claude Code refused it). False: that machine's agent does not know how (an older one). */
  async grantOnce(session: AgentSession, tool: string, input: unknown): Promise<boolean> {
    try {
      await this.core.agents.rpc(session.hostId, { method: 'session.grant', params: { sessionId: session.id, tool, input, ttlMs: 10 * 60_000 } }, 8000);
      this.core.audit('owner', 'approval.granted_once', session.id, { employee: this.core.employees.get(session.employeeId)?.name, tool });
      return true;
    } catch (e) {
      this.core.log('info', `granting a refused call once: ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * The owner's decision of 2026-11-13: there are three levels — Standard, Auto, Unrestricted. Whoever is recorded
   * with anything else (Restricted, Supervised and Autonomous existed until then) is on Standard from now on: the
   * least of the three, so that nobody is given more than a person gave them where that can be avoided. A session
   * that is running goes on as it was started; the level takes effect at its next start. Run at every start: it
   * finds nothing once it has been done.
   */
  adoptThreeLevels(): number {
    const moved = this.core.employees.filter((e) => !isAutonomyLevel(e.autonomy));
    for (const e of moved) {
      e.autonomy = 'standard';
      this.core.put('employee', e);
    }
    if (moved.length) {
      this.core.audit('office', 'autonomy.three_levels', 'employees', { count: moved.length, employees: moved.map((e) => e.name) });
      const here = moved.filter((e) => !e.archived);
      if (here.length) this.core.event({ type: 'employee.updated', source: 'server', summary: `${here.map((e) => e.name).join(', ')} ${here.length === 1 ? 'was' : 'were'} on a level that no longer exists and ${here.length === 1 ? 'is' : 'are'} on Standard now; it takes effect when their session next starts`, data: { count: here.length } });
    }
    return moved.length;
  }

  /**
   * The owner's decision of 2026-11-11: everybody runs Unrestricted (bypass) unless the owner puts them back on Auto.
   * Done once, for employees who were on Auto on the office's own machines — a member's own computer is that member's
   * to decide (the profile has the choice). Afterwards an employee put back on Auto stays there.
   */
  adoptUnrestrictedDefault(): number {
    if (this.core.store.kvGet<number>('autonomy.unrestrictedDefault', 0) >= 1) return 0;
    let n = 0;
    for (const e of this.core.employees.filter((x) => !x.archived && x.autonomy === 'auto' && x.roleKey !== 'foreman')) {
      if (this.eng.hosts.memberOfHost(e.hostId)) continue;
      e.autonomy = 'unrestricted';
      this.core.put('employee', e);
      // Whoever has a session running gets a new one in the new mode (idle ones as soon as their machine is back, the others when their turn ends).
      this.restartWhy.set(e.id, 'your level is now Unrestricted');
      n++;
    }
    this.core.store.kvSet('autonomy.unrestrictedDefault', 1);
    if (n) {
      this.core.audit('office', 'autonomy.unrestricted_default', 'employees', { count: n });
      this.core.event({ type: 'employee.updated', source: 'server', summary: `${n} employee${n === 1 ? '' : 's'} on the office's own machines ${n === 1 ? 'is' : 'are'} on Unrestricted now (the owner's default); each takes effect when their session next starts`, data: { count: n } });
    }
    return n;
  }

  /** Employees whose running session has to be started again because what it was started with has changed, and why. */
  private restartWhy = new Map<string, string>();

  /**
   * Something a session is started with has changed for this employee (their level, their Claude account, their
   * model): the session is started again with the same conversation — now if it is between turns, otherwise as soon
   * as its turn ends. Nothing to do when no session runs: the next start has the change anyway.
   */
  restartForChange(employeeId: string, why: string): void {
    const s = this.core.runningSessionOf(employeeId);
    if (!s || s.origin !== 'managed') return;
    const earlier = this.restartWhy.get(employeeId);
    this.restartWhy.set(employeeId, earlier && !earlier.includes(why) ? `${earlier}, and ${why}` : why);
    if (s.inTurn === true) return; // at the end of the turn (see the hook receiver)
    void this.restartNow(employeeId);
  }

  /**
   * The owner switched the hold on high-risk commands for a level (Settings → Employees). Switching it **off** needs
   * nothing here: the office answers what a running session's machine still holds (`HookReceiver`), and the next
   * start has no list. Switching it **on** does: a session that was started without the list has nothing in front
   * of it until it is started again — so it is, between turns, like for any other change of what it runs with.
   */
  highRiskSwitched(): void {
    for (const s of this.core.sessions.filter((x) => x.status === 'running' && x.origin === 'managed')) {
      const e = s.employeeId ? this.core.employees.get(s.employeeId) : undefined;
      if (!e) continue;
      if (s.highRiskHeld === false && asksHighRisk(this.core.settings, e.autonomy)) this.restartForChange(e.id, 'the boss wants to be asked before high-risk commands again');
      // Switched off, and nothing else takes the list away from this session (see `restartDue`): now if it is between turns.
      else if (this.restartDue(s.id) && s.inTurn !== true) void this.restartNow(e.id);
    }
  }

  /** Is this session waiting to be started again for a change (so it is not told to go on meanwhile)? */
  restartDue(sessionId: string): boolean {
    const s = this.core.sessions.get(sessionId);
    if (!s?.employeeId) return false;
    if (this.restartWhy.has(s.employeeId)) return true;
    // Not noted (the office itself was started again since the change), but plain to see: the session runs with or
    // without Claude Code's checks while its employee's level says the opposite.
    const e = this.core.employees.get(s.employeeId);
    if (!e || s.status !== 'running' || s.origin !== 'managed' || s.mode !== 'interactive_cli' || !s.permissionMode) return false;
    const wantsBypass = e.autonomy === 'unrestricted';
    const hasBypass = s.permissionMode === 'bypassPermissions';
    if (wantsBypass !== hasBypass) {
      this.restartWhy.set(s.employeeId, `your level is now ${wantsBypass ? 'Unrestricted' : e.autonomy === 'auto' ? 'Auto' : e.autonomy}`);
      return true;
    }
    // A session that was started with the high-risk list in front of it, whose employee the owner no longer wants to
    // be asked about (the switches in Settings → Employees). Where nothing else takes the list away — the office
    // answering for it at once, which needs a session in bypass mode on a machine whose agent says what it holds a
    // command for — the session keeps asking until it is started again. So it is: once, between turns.
    // (A session from before the office recorded this is taken as started with the list.)
    if (s.highRiskHeld !== false && !asksHighRisk(this.core.settings, e.autonomy) && !(hasBypass && this.core.hosts.get(s.hostId)?.info?.saysHeldFor === true)) {
      this.restartWhy.set(s.employeeId, 'the boss no longer wants to be asked before high-risk commands');
      return true;
    }
    // A session in bypass mode whose hooks are older than what this office relies on: a command of it that waits for
    // the owner would be run if the machine's agent were restarted meanwhile (see `HOOKS_VERSION`). Its machine's
    // agent says which hooks it has — one that does not say is too old to start it with newer ones, and is left alone.
    // (And only up to what that machine's agent can write: one that is itself behind this office would start the
    // session with the same hooks again, and be asked to restart it for ever. An agent that reports sessions'
    // versions but not its own writes version 2.)
    const canWrite = Math.min(HOOKS_VERSION, this.core.hosts.get(s.hostId)?.info?.hooksVersion ?? 2);
    if (hasBypass && typeof s.hooksVersion === 'number' && s.hooksVersion < canWrite) {
      this.restartWhy.set(s.employeeId, 'the office was updated, and your session has to be started again to work with it');
      return true;
    }
    return false;
  }

  private restarting = new Set<string>();

  async restartNow(employeeId: string): Promise<void> {
    const why = this.restartWhy.get(employeeId);
    const e = this.core.employees.get(employeeId);
    if (!why || !e || this.restarting.has(employeeId)) return;
    const s = this.core.runningSessionOf(employeeId);
    if (!s) return void this.restartWhy.delete(employeeId);
    this.restarting.add(employeeId);
    this.restartWhy.delete(employeeId);
    try {
      this.core.audit('office', 'session.restarted_for_change', s.id, { employee: e.name, why });
      this.core.event({ type: 'session.started', source: 'server', summary: `${e.name}'s session is being started again: ${why.replace(/\byour\b/g, 'their').replace(/\byou were\b/g, 'they were')}`, employeeId, sessionId: s.id, hostId: s.hostId, data: { restartedFor: why } });
      await this.stop(employeeId, { actor: 'office', reason: 'started again for a change of settings' });
      await this.wake(employeeId, 'a change of their settings');
      // Somebody in the middle of a task is told to go on; somebody idle needs no message (it would only cost a turn).
      const task = this.eng.tasks.currentTask(employeeId);
      const refused = this.refusedTurn.delete(employeeId);
      if (!task && refused) this.eng.comms.sendMessage({ from: { kind: 'system', id: null, name: 'the office' }, toEmployeeId: employeeId, kind: 'system', taskId: null, body: `Your session was started again because ${why}. Your last turn was refused for that limit: go on with what you were asked before it, from where you were.` });
      if (task) this.eng.comms.sendMessage({ from: { kind: 'system', id: null, name: 'the office' }, toEmployeeId: employeeId, kind: 'system', taskId: task.id, body: `Your session was started again because ${why}. Go on with ${task.key} "${truncate(task.title, 80)}" from where you were.` });
    } catch (err) {
      this.core.log('warn', `restarting ${e.name} for a change of settings: ${(err as Error).message}`);
    } finally {
      this.restarting.delete(employeeId);
    }
  }

  /** After a machine has reported its sessions: those of its employees that wait for a new start and are between turns get it now. */
  private restartIdleOn(hostId: string): void {
    // (Asking each running session of this machine also notices one whose mode no longer fits its employee's level.)
    for (const s of this.core.sessions.filter((x) => x.hostId === hostId && x.status === 'running')) this.restartDue(s.id);
    for (const id of [...this.restartWhy.keys()]) {
      const s = this.core.runningSessionOf(id);
      if (s && s.hostId === hostId && s.inTurn !== true) void this.restartNow(id);
    }
  }

  /** Sessions that could not reach the office's own tools (their Claude Code reports the connection gone). */
  private unreachable = new Set<string>();
  /** When each employee's session was last started again for that, most recent last. */
  private reconnects = new Map<string, number[]>();

  /** A tool of the office failed in this session because the office could not be reached from it. */
  onOfficeUnreachable(session: AgentSession): void {
    if (session.status !== 'running' || this.unreachable.has(session.id)) return;
    this.unreachable.add(session.id);
    this.core.log('warn', `${this.core.employees.get(session.employeeId)?.name ?? 'A session'} cannot reach the office's tools from its session; it is started again when the turn ends`);
  }

  cutOff(sessionId: string): boolean {
    return this.unreachable.has(sessionId);
  }

  /**
   * Start again the session of an employee who was cut off from the office's tools: the same conversation, with the
   * connection made anew (the address and token a session uses are given to it at start). At most twice an hour per
   * employee; after that the owner is told, because something on that machine needs a person.
   */
  async reconnect(employeeId: string): Promise<void> {
    const e = this.core.employees.get(employeeId);
    const s = this.core.runningSessionOf(employeeId);
    if (!e || !s || !this.unreachable.has(s.id)) return;
    this.unreachable.delete(s.id);
    const host = this.core.hosts.get(s.hostId);
    const recent = (this.reconnects.get(employeeId) ?? []).filter((t) => Date.now() - t < 60 * 60_000);
    if (recent.length >= 2) {
      if (recent.length === 2) {
        this.reconnects.set(employeeId, [...recent, Date.now()]);
        this.core.event({ type: 'session.cut_off', source: 'server', summary: `${e.name}'s session still cannot reach the office's tools after being started again twice`, employeeId, sessionId: s.id, hostId: s.hostId, data: { gaveUp: true } });
        this.eng.comms.notify({ kind: 'blocked', severity: 'warning', employeeId, hostId: s.hostId, title: `${e.name} cannot reach the office from ${host?.name ?? 'their machine'}`, body: `Their session was started again twice and its Claude Code still reports the office's tools as not connected, so they cannot finish, ask or report anything. Look at ${host?.name ?? 'that machine'}: is the office reachable from it, and (a member's computer) is the desktop app open and up to date?` });
      }
      return;
    }
    this.reconnects.set(employeeId, [...recent, Date.now()]);
    this.core.audit('office', 'session.reconnected', s.id, { employee: e.name });
    this.core.event({ type: 'session.cut_off', source: 'server', summary: `${e.name}'s session lost its connection to the office's tools; it is being started again with the same conversation`, employeeId, sessionId: s.id, hostId: s.hostId, data: { gaveUp: false } });
    try {
      await this.stop(employeeId, { actor: 'office', reason: 'cut off from the office; starting again' });
      await this.wake(employeeId, 'a new connection to the office');
      const task = this.eng.tasks.currentTask(employeeId);
      this.eng.comms.sendMessage({ from: { kind: 'system', id: null, name: 'the office' }, toEmployeeId: employeeId, kind: 'system', taskId: task?.id ?? null, body: `Your session had lost its connection to the office (its tools and the vault did not answer), so it was started again. They work now.${task ? ` Go on with ${task.key} "${truncate(task.title, 80)}" from where you were: finish what was waiting for the office, then complete_task.` : ''}` });
    } catch (err) {
      this.core.log('warn', `reconnecting ${e.name}: ${(err as Error).message}`);
    }
  }

  /** What each machine last said about who is logged in to which account folder. */
  private logins = new Map<string, { loggedIn: boolean; email: string | null; login: string; at: number }>();
  private movedAt = new Map<string, number>();
  private failingOver = false;

  /**
   * What a machine has just said about an account is kept: for the list and for choosing (in memory), and — who is
   * signed in and whose models it talks to — with the account's record, so that it is known by its e-mail address
   * and not by its folder after a restart too, before any session on it has reported.
   */
  private noteAccount(hostId: string, a: AccountInfo): void {
    const key = `${hostId}|${a.dir ?? 'default'}`;
    this.logins.set(key, { loggedIn: a.loggedIn, email: a.email, login: a.login, at: Date.now() });
    if (a.error) return;
    this.loadAccounts();
    const row = this.accounts.get(key) ?? { key, hostId, configDir: a.dir ?? null, email: null, organization: null, fiveHour: null, sevenDay: null, reportedAt: null, reportedBy: null, employeeIds: [] };
    const provider = a.provider ?? 'anthropic';
    const next = { ...row, email: a.email ?? (a.loggedIn ? row.email : null), organization: a.organization ?? (a.loggedIn ? row.organization : null), provider, endpoint: a.endpoint ?? null };
    if (next.email === row.email && next.organization === row.organization && next.provider === (row.provider ?? null) && (next.endpoint ?? null) === (row.endpoint ?? null) && this.accounts.has(key)) return;
    this.accounts.set(key, next);
    this.core.store.kvSet('accounts', [...this.accounts.values()]);
  }

  /** Ask a machine about its account folders (`prepare`: make the ones that are missing). Remembered for the list and for choosing. */
  async checkAccounts(hostId: string, dirs: Array<string | null>, prepare = false): Promise<AccountInfo[]> {
    const res = await this.core.agents.rpc<{ accounts: AccountInfo[] }>(hostId, { method: 'claude.accounts', params: { dirs, prepare } }, 10_000);
    for (const a of res.accounts) this.noteAccount(hostId, a);
    return res.accounts;
  }

  /**
   * Who is signed in to each account of a machine, asked when the machine comes into the office: its default login,
   * the accounts on its list and whatever folder an employee there is on. So that every account has its name from
   * the start.
   */
  async learnAccounts(hostId: string, also: string[] = []): Promise<void> {
    const host = this.core.hosts.get(hostId);
    if (!host || !this.core.agents.isOnline(hostId)) return;
    const dirs = new Set<string | null>([null, ...(host.claudeAccounts ?? []), ...also]);
    for (const e of this.core.employees.filter((x) => !x.archived && x.hostId === hostId && !!x.claudeConfigDir)) dirs.add(e.claudeConfigDir!);
    await this.checkAccounts(hostId, [...dirs]);
  }

  /** The folder of an account an owner names (`~/.claude-2`), or the next free one of that kind when they name none. */
  private accountFolder(host: Host, rawDir: string | null | undefined, stem: string | null = '~/.claude'): string {
    let dir = stripEnd(String(rawDir ?? '').trim(), '/');
    // (`stem` null: the folder has to be named.)
    if (!dir && stem) {
      const taken = new Set<string>([...(host.claudeAccounts ?? []), ...this.core.employees.filter((e) => e.hostId === host.id && !!e.claudeConfigDir).map((e) => e.claudeConfigDir!)]);
      // (`~/.claude` itself is the default login: an account of Anthropic's starts at `-2`, another service's at its own name.)
      for (let i = stem === '~/.claude' ? 2 : 1; ; i++) {
        dir = i === 1 ? stem : `${stem}-${i}`;
        if (!taken.has(dir)) break;
      }
    }
    if (!/^~\/[A-Za-z0-9._@+-]+$/.test(dir)) throw new EngineError('an account folder is a folder in the home of the machine\'s user, like ~/.claude-2');
    if (dir === '~/.claude') throw new EngineError('~/.claude is the machine\'s default account; it is there already');
    if (!this.core.agents.isOnline(host.id)) throw new EngineError(`${host.name} is offline`);
    return dir;
  }

  private listAccount(host: Host, dir: string, actor: string, how: Record<string, unknown> = {}): void {
    if ((host.claudeAccounts ?? []).includes(dir)) return;
    host.claudeAccounts = [...(host.claudeAccounts ?? []), dir];
    this.core.put('host', host);
    this.core.audit(actor, 'account.added', host.id, { dir, ...how });
  }

  /**
   * Add a Claude account to a machine: a config folder of its own (`~/.claude-2`). The folder is made there, sharing
   * the conversations of the default account; somebody then signs in to it once — from the office (`accountLogin`),
   * or on that machine (the answer says with which command). From then on employees can be put on it, and are
   * moved to it when theirs runs out.
   */
  async addAccount(hostId: string, rawDir: string, actor = 'owner'): Promise<{ dir: string; loggedIn: boolean; email: string | null; login: string }> {
    const host = this.core.hosts.require(hostId);
    const dir = this.accountFolder(host, rawDir, null);
    const [a] = await this.checkAccounts(hostId, [dir], true);
    if (!a || a.error) throw new EngineError(a?.error ?? `${host.name} did not answer`);
    this.listAccount(host, dir, actor);
    return { dir, loggedIn: a.loggedIn, email: a.email, login: a.login };
  }

  /**
   * Signing in to a Claude account without leaving the office. `start` (with no folder: a new account, in the next
   * free folder) has the machine run Claude Code's own sign-in in a terminal of its own; `screen` says what that
   * terminal shows; `input` types a line (the code the sign-in page gives) or presses a key there; `stop` ends it.
   * The office passes on what the owner types and what the terminal shows, and keeps neither.
   */
  async accountLogin(hostId: string, p: { op: 'start' | 'screen' | 'input' | 'stop'; dir?: string | null; fresh?: boolean; text?: string; key?: string; email?: string }, actor = 'owner'): Promise<AccountLogin> {
    const host = this.core.hosts.require(hostId);
    if (!this.core.agents.isOnline(hostId)) throw new EngineError(`${host.name} is offline`);
    // null: the machine's default login. A new account: `fresh`, in the folder named or the next free one.
    let dir: string | null = p.dir ? stripEnd(String(p.dir).trim(), '/') : null;
    if (p.op === 'start' && (p.fresh || dir)) {
      dir = this.accountFolder(host, dir);
      if (dir && !(host.claudeAccounts ?? []).includes(dir)) this.listAccount(host, dir, actor, { signIn: 'from the office' });
    }
    let res: AccountLogin;
    try {
      res = await this.core.agents.rpc<AccountLogin>(hostId, { method: 'claude.login', params: { op: p.op, dir, ...(p.text !== undefined ? { text: String(p.text).slice(0, 4096) } : {}), ...(p.key ? { key: String(p.key) } : {}), ...(p.email ? { email: String(p.email).slice(0, 200) } : {}) } }, 15_000);
    } catch (e) {
      if (/unknown|unsupported|not implemented/i.test((e as Error).message)) throw new EngineError(`${host.name} runs an older agent that cannot sign in from the office: update it, or sign in on that machine`);
      throw e;
    }
    this.noteAccount(hostId, res.account);
    if (p.op === 'start') this.core.audit(actor, 'account.login_started', hostId, { dir: dir ?? 'default' });
    return res;
  }

  /**
   * An account of another service that speaks Claude Code's protocol — Z.AI's GLM Coding Plan: a config folder whose
   * own settings name the service and hold its API key. The key goes from the owner to that machine and is written
   * there; the office does not keep it, log it or send it to anybody.
   */
  async addProviderAccount(hostId: string, p: { dir?: string | null; provider: 'zai' | 'custom'; token: string; baseUrl?: string; models?: { opus?: string; sonnet?: string; haiku?: string } }, actor = 'owner'): Promise<AccountInfo> {
    const host = this.core.hosts.require(hostId);
    if (p.provider !== 'zai' && p.provider !== 'custom') throw new EngineError('unknown kind of account');
    const token = String(p.token ?? '').trim();
    if (!token) throw new EngineError('the API key is missing');
    if (/\s/.test(token) || token.length > 512) throw new EngineError('that does not look like an API key');
    if (p.provider === 'custom' && !/^https:\/\/[^\s]+$/.test(String(p.baseUrl ?? '').trim())) throw new EngineError('the address of the service must begin with https://');
    const dir = this.accountFolder(host, p.dir, p.provider === 'zai' ? '~/.claude-zai' : '~/.claude-other');
    let res: { account: AccountInfo };
    try {
      res = await this.core.agents.rpc<{ account: AccountInfo }>(hostId, { method: 'claude.provider', params: { dir, provider: p.provider, token, ...(p.baseUrl ? { baseUrl: String(p.baseUrl) } : {}), ...(p.models ? { models: p.models } : {}) } }, 15_000);
    } catch (e) {
      if (/unknown|unsupported|not implemented/i.test((e as Error).message)) throw new EngineError(`${host.name} runs an older agent that cannot set up such an account: update it first`);
      throw e;
    }
    if (res.account.error) throw new EngineError(res.account.error);
    this.noteAccount(hostId, res.account);
    this.listAccount(host, dir, actor, { provider: p.provider });
    return res.account;
  }

  /** Take an account off a machine's list. Nobody may be on it. Nothing on the machine is deleted. */
  removeAccount(hostId: string, dir: string, actor = 'owner'): void {
    const host = this.core.hosts.require(hostId);
    const on = this.core.employees.filter((e) => !e.archived && e.hostId === hostId && (e.claudeConfigDir ?? null) === dir);
    if (on.length) throw new EngineError(`${on.map((e) => e.name).join(', ')} ${on.length === 1 ? 'is' : 'are'} on that account; put them on another first`);
    host.claudeAccounts = (host.claudeAccounts ?? []).filter((d) => d !== dir);
    this.core.put('host', host);
    this.core.audit(actor, 'account.removed', hostId, { dir });
  }

  /**
   * Employees whose Claude account has used up its allowance are put on another account of the same machine that
   * has room and somebody logged in, and their session is started again there — continuing the conversation where
   * the two accounts share their conversations (accounts added through the office do). Nobody is moved twice within
   * ten minutes, and nobody is moved back by this when the first account resets.
   */
  async failover(force?: { key: string; actor: string }): Promise<number> {
    if (this.failingOver) return 0;
    if (!force && this.core.settings.accountFailover === false) return 0;
    this.failingOver = true;
    let moved = 0;
    try {
      const accounts = this.accountUsage();
      // Asked for by an owner ("move them now"): that one account, whatever its figures say.
      // (Also an account on which only one model's week is used up: those who think with that model move, the rest stay.)
      const fullFor = (a: AccountUsage, family: string) => !!family && !!a.modelWeeks?.[family] && weekFull(a.modelWeeks[family]!);
      const spent = accounts.filter((a) => (force ? a.key === force.key : a.exhausted || Object.values(a.modelWeeks ?? {}).some(weekFull)) && a.employeeIds.length > 0);
      for (const from of spent) {
        if (!this.core.agents.isOnline(from.hostId)) continue;
        // The same service only: nobody is taken from Claude to another service's models (or back) by the office itself.
        const others = accounts.filter((a) => a.hostId === from.hostId && a.key !== from.key && !a.exhausted && (a.provider ?? 'anthropic') === (from.provider ?? 'anthropic'));
        if (!others.length) continue;
        // Who is really logged in, asked now (a folder that was added and never logged in to cannot take anybody).
        const fresh = await this.checkAccounts(from.hostId, others.map((a) => a.configDir)).catch(() => []);
        const ready = others.filter((a) => fresh.find((f) => (f.dir ?? null) === a.configDir)?.loggedIn);
        if (!ready.length) continue;
        const load = new Map(ready.map((a) => [a.key, a.employeeIds.length]));
        const used = (a: AccountUsage) => Math.max(a.fiveHour?.usedPercent ?? 0, a.sevenDay?.usedPercent ?? 0);
        for (const id of from.employeeIds) {
          const e = this.core.employees.get(id);
          if (!e || e.archived || (!force && Date.now() - (this.movedAt.get(id) ?? 0) < 10 * 60_000)) continue;
          // A session somebody started themselves and the office only looks at is theirs: it is not stopped, and no
          // second Claude is started beside it. (The same for an employee the office gives no work of its own accord.)
          const theirs = this.core.runningSessionOf(id);
          if ((theirs && theirs.origin !== 'managed') || e.selfDriven) continue;
          // What they think with: their own setting, what their session runs, or what a refused turn said it was.
          const family = modelFamily(e.model) || modelFamily(theirs?.model) || this.refusedFamily.get(id) || '';
          // Only a model's limit is reached here: they go on with another model on this same account (`modelFor`) —
          // moved only when theirs is reached and no other model has room here either.
          const noModelHere = fullFor(from, family) && !this.modelFor(e, from.hostId, from.configDir).instead;
          if (!force && !from.exhausted && !noModelHere) continue;
          // Onto an account where their model has room, or another one does.
          const fit = ready.filter((a) => !fullFor(a, family) || !!this.modelFor(e, a.hostId, a.configDir).instead);
          if (!fit.length) continue;
          // The account with the most room, counting whom this round already put there.
          const to = [...fit].sort((a, b) => used(a) + (load.get(a.key) ?? 0) * 3 - (used(b) + (load.get(b.key) ?? 0) * 3))[0]!;
          load.set(to.key, (load.get(to.key) ?? 0) + 1);
          this.movedAt.set(id, Date.now());
          e.claudeConfigDir = to.configDir;
          this.core.put('employee', e);
          const name = (a: AccountUsage) => a.email ?? a.configDir ?? 'the default account';
          const until = [from.fiveHour, from.sevenDay, fullFor(from, family) ? from.modelWeeks![family]! : null].filter((w) => w && w.usedPercent >= 99 && w.resetsAt).map((w) => w!.resetsAt!).sort().pop() ?? (from.spentUntil && Date.parse(from.spentUntil) > Date.now() ? from.spentUntil : undefined);
          this.core.audit(force?.actor ?? 'office', 'account.switched', id, { from: from.configDir, to: to.configDir });
          this.core.event({ type: 'account.switched', source: force ? 'owner' : 'server', summary: force ? `${e.name} was put on another Claude account (${name(to)}) by ${force.actor === 'owner' ? 'the boss' : force.actor}` : `${e.name} was put on another Claude account (${name(to)}): ${name(from)} has used up its allowance${until ? ` until ${until.slice(11, 16)} UTC` : ''}`, employeeId: id, hostId: from.hostId, data: { from: from.configDir, to: to.configDir, resetsAt: until ?? null } });
          moved++;
          const running = this.core.runningSessionOf(id);
          if (running) {
            // The same conversation, on the other account.
            await this.stop(id, { actor: 'office', reason: 'moved to another Claude account' }).catch(() => undefined);
            const started = await this.wake(id, 'another Claude account, because theirs ran out').catch((err) => {
              this.core.log('warn', `account failover: ${e.name} could not be started on the other account: ${(err as Error).message}`);
              return null;
            });
            // What they were in the middle of was cut off; they are told to go on with it.
            const task = started ? this.eng.tasks.currentTask(id) : null;
            if (task) this.eng.comms.sendMessage({ from: { kind: 'system', id: null, name: 'the office' }, toEmployeeId: id, body: `Your session was started again on another Claude account, because the one you were on ran out. Go on with ${task.key} "${task.title}" from where you were.`, kind: 'system', taskId: task.id });
          }
        }
      }
    } catch (e) {
      this.core.log('warn', `account failover: ${(e as Error).message}`);
    } finally {
      this.failingOver = false;
    }
    if (moved) this.eng.tasks.schedule();
    return moved;
  }

  onUsage(hostId: string, sessionId: string, usage: SessionUsage): void {
    const s = this.core.sessions.get(sessionId);
    if (!s || s.hostId !== hostId) return;
    s.usage = usage;
    this.core.put('session', s);
  }

  /**
   * Monitor frames double as a way to notice Claude Code's workspace-trust
   * prompt, which appears before any hook can fire.
   */
  onScreen(sessionId: string, screen: TerminalScreen): void {
    this.promptOnScreen(sessionId, false, screen);
    this.bypassWarningOnScreen(sessionId, screen);
    this.limitMenuOnScreen(sessionId, screen);
    if (this.trustAsked.has(sessionId)) return;
    const s = this.core.sessions.get(sessionId);
    // Only the interactive CLI shows a trust prompt; an SDK-managed worker's pane is a transcript.
    // (Also a session that continues an earlier conversation: started in another folder than before — its own
    // subfolder, say — Claude Code asks about that folder too, before anything else happens.)
    if (!s || s.status !== 'running' || s.origin !== 'managed' || s.mode !== 'interactive_cli' || !atStartDialog(s, screen)) return;
    const text = screen.lines.join('\n').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    if (!TRUST_PROMPT.test(text)) return;
    this.trustAsked.add(sessionId);
    const employee = this.core.employees.get(s.employeeId) ?? null;
    // Whoever put this employee in this folder chose the folder: the office answers "yes" for them, on the record —
    // at every level since 2026-11-13 (the owner: "say yes and trust the folder by itself, instead of getting stuck");
    // with that switched off, only for those on Auto and Unrestricted, as before.
    if (employee && (this.core.settings.acceptStartPrompts !== false || employee.autonomy === 'auto' || employee.autonomy === 'unrestricted')) {
      const keys = trustPromptKeys(screen.lines);
      if (keys) {
        void this.core.agents
          .rpc(s.hostId, { method: 'session.keys', params: { sessionId: s.id, keys } })
          .then(() => {
            this.core.audit('system', 'trust.auto_accepted', s.id, { employee: employee.name, cwd: s.cwd });
            this.core.event({ type: 'session.started', source: 'server', summary: `The folder ${s.cwd} was trusted for Claude Code without asking you (${employee.name} was put there)`, sessionId: s.id, employeeId: employee.id, hostId: s.hostId, data: { trust: 'auto', cwd: s.cwd } });
          })
          .catch(() => this.trustAsked.delete(sessionId));
        return;
      }
    }
    this.setActivity(s, 'needs_approval', 'Claude Code is asking whether to trust this folder');
    this.eng.comms.createQuestion({
      kind: 'trust_prompt',
      channel: 'terminal',
      employee,
      session: s,
      text: `Claude Code is asking whether to trust the folder ${s.cwd} before ${employee?.name ?? 'this session'} can start.`,
      context: 'This prompt comes from Claude Code itself and appears once per folder. Trusting lets Claude Code read project settings and run in that directory.',
      why: 'The session cannot start working until it is answered.',
      options: [
        { label: 'Trust this folder', description: 'Press Enter on the prompt', consequence: 'Claude Code starts in this directory.' },
        { label: 'Decide in the terminal', description: 'Leave the prompt for you to answer at the workstation' },
      ],
    });
  }

  // ───────────── launching ─────────────

  private newSessionRecord(employee: Employee, hostId: string, cwd: string): AgentSession {
    const now = nowIso();
    return {
      id: newId(),
      employeeId: employee.id,
      hostId,
      origin: 'managed',
      mode: 'interactive_cli',
      tmuxSession: '',
      tmuxPane: null,
      cwd,
      repoRoot: null,
      branch: null,
      claudeSessionId: newId(),
      status: 'starting',
      activity: 'unknown',
      activityDetail: 'Starting Claude Code',
      activitySince: now,
      inTurn: null,
      control: 'AGENT_CONTROLLED',
      controllerId: null,
      capabilities: { terminal: true, hooks: true, mcp: true, structuredApproval: true, structuredMessaging: true, usage: false },
      permissionMode: null,
      model: this.modelFor(employee, hostId, employee.claudeConfigDir ?? null).model,
      effort: employee.effort ?? null,
      cols: SESSION_COLS,
      rows: SESSION_ROWS,
      pid: null,
      usage: null,
      startedAt: now,
      endedAt: null,
      lastEventAt: null,
      exitReason: null,
    };
  }

  buildSpec(employee: Employee, session: AgentSession, cwd: string, resume: boolean, mcpToken: string, mode: Employee['executionMode'] = 'interactive_cli'): LaunchSpec {
    const project = this.core.projects.get(employee.projectId);
    const host = this.core.hosts.get(session.hostId);
    // An SDK-managed worker is not run in bypass mode (the SDK asks for a separate, explicit switch for it): it gets Auto.
    const perms = permissionsFor(employee.autonomy === 'unrestricted' && mode === 'managed_sdk' ? 'auto' : employee.autonomy, project, employee, host?.info?.claudeVersion ?? null);
    return {
      displayName: employee.name,
      cwd,
      mode,
      // Their own model — or, where its limit is reached on their account, the one they go on with (`modelFor`).
      model: this.modelFor(employee, session.hostId, employee.claudeConfigDir ?? null).model,
      // Only an effort that machine's Claude Code has (its agent says which); otherwise Claude Code's own default.
      effort: employee.effort && host?.info?.claudeEffortLevels?.includes(employee.effort) ? employee.effort : null,
      permissionMode: perms.permissionMode,
      // A rented employee: the tools the owner did not allow are not there at all (rent.ts; the fence below does the rest).
      permissions: { allow: perms.allow, deny: [...perms.deny, ...this.eng.rent.denyRulesFor(employee)], ask: perms.ask },
      allowedTools: [],
      disallowedTools: [],
      appendSystemPrompt: systemPromptFor(employee, project, this.core.settings.companyName, true, this.eng.improver.playbookBlock(employee, project?.id ?? null, false), this.core.settings.employeesManageBoard !== false, this.eng.memory.available(), this.eng.attachments.available(), this.core.settings.employeesBrowser !== false && !!this.core.hosts.get(session.hostId)?.info?.browser, asksHighRisk(this.core.settings, employee.autonomy)),
      mcp: { url: `${this.core.publicUrl}/mcp`, token: mcpToken },
      browser: this.core.settings.employeesBrowser !== false && !!this.core.hosts.get(session.hostId)?.info?.browser,
      strictMcp: !this.core.settings.workersInheritMcp,
      // On `auto` the owner can choose to leave even these to Claude Code's auto mode, and on `unrestricted` to
      // have nothing held at all (`asksHighRisk`).
      // (A rented employee whom the owner let never wait for the office is not held by it either — rent.ts.)
      highRiskPatterns: (session.highRiskHeld = asksHighRisk(this.core.settings, employee.autonomy) && !this.eng.rent.autonomous(employee.id)) ? [...DEFAULT_HIGH_RISK_PATTERNS, ...(project?.policy.highRiskPatterns ?? [])] : [],
      claudeSessionId: session.claudeSessionId!,
      resume,
      // A project's other repositories, when they are on the machine this employee works on.
      addDirs: [...new Set([...(project && (!project.hostId || project.hostId === session.hostId) ? (project.extraRepos ?? []).map((x) => x.path) : []), ...this.eng.rent.extraDirsFor(employee)])].filter((p) => p !== cwd),
      // Rented: the folders they may reach and what they may do there, enforced on their machine (rent.ts).
      fence: this.eng.rent.fenceFor(employee, cwd),
      env: {
        ORCH_EMPLOYEE: slugify(employee.name),
        // Their own Claude login, if they were given one.
        ...(employee.claudeConfigDir ? { CLAUDE_CONFIG_DIR: employee.claudeConfigDir } : {}),
        // Let ask_boss hold a tool call open while the owner decides, and a wait for a colleague while they work.
        CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: String(Math.max(600_000, Math.max(this.core.timings.askBossWaitMs, this.core.timings.colleagueWaitMs) * 2)),
        MCP_TOOL_TIMEOUT: String(Math.max(900_000, Math.max(this.core.timings.askBossWaitMs, this.core.timings.colleagueWaitMs) * 3)),
      },
      cols: SESSION_COLS,
      rows: SESSION_ROWS,
    };
  }

  /**
   * Start (or restart) the real Claude Code process for an employee. Restarting
   * an exited session resumes the same Claude conversation in the same tmux
   * session; a different working directory starts a fresh one.
   */
  start(employeeId: string, opts: { cwd?: string | null; resume?: boolean; continueLast?: boolean; actor?: string } = {}): Promise<AgentSession> {
    const inFlight = this.starting.get(employeeId);
    // Two things that need the same employee at once share one start. One that needs a particular folder (the
    // folder of a task) looks again once that start is through: the session is moved there if it came up elsewhere.
    if (inFlight) return opts.cwd ? inFlight.then(() => undefined, () => undefined).then(() => this.start(employeeId, opts)) : inFlight;
    const p = this.doStart(employeeId, opts).finally(() => this.starting.delete(employeeId));
    this.starting.set(employeeId, p);
    return p;
  }

  private async doStart(employeeId: string, opts: { cwd?: string | null; resume?: boolean; continueLast?: boolean; actor?: string }): Promise<AgentSession> {
    const employee = this.core.employees.require(employeeId);
    if (employee.archived) throw new EngineError(`${employee.name} is archived`);
    const hostId = employee.hostId;
    if (!hostId) throw new EngineError(`${employee.name} is not assigned to a machine`);
    const host = this.core.hosts.require(hostId);
    if (!this.core.agents.isOnline(hostId)) throw new EngineError(`host "${host.name}" is offline`);
    const project = this.core.projects.get(employee.projectId);
    const cwd = opts.cwd ?? employee.workingDir ?? project?.repoPath ?? null;
    if (!cwd) throw new EngineError(`${employee.name} has no working directory: assign a project with a repository, or set a working directory`);

    const current = this.core.runningSessionOf(employeeId);
    if (current) {
      if (path.resolve(current.cwd) === path.resolve(cwd)) return current;
      if (current.origin !== 'managed') throw new EngineError(`${employee.name} is attached to an existing session in ${current.cwd}; detach it before starting a managed one elsewhere`);
      await this.stop(employeeId, { actor: opts.actor ?? 'system', reason: 'moving to another working directory' });
    }
    const previous = this.core.sessions
      .filter((s) => s.employeeId === employeeId && s.origin === 'managed' && s.hostId === hostId && (s.status === 'exited' || s.status === 'lost') && path.resolve(s.cwd) === path.resolve(cwd))
      .sort((a, b) => (b.startedAt > a.startedAt ? 1 : -1))[0];
    const resume = opts.resume !== false && !!previous && !!previous.claudeSessionId && !!previous.lastEventAt;
    // A previous attempt that never got as far as a first event (it exited right away) is retried in the
    // same record and the same tmux session, with a fresh Claude session id — not piled up as new ones.
    const retry = !resume && !!previous && !previous.lastEventAt;
    if (retry) previous!.claudeSessionId = this.newSessionRecord(employee, hostId, cwd).claudeSessionId;
    const session = resume || retry ? previous! : this.newSessionRecord(employee, hostId, cwd);
    // Capability detection with an explicit fallback: a host without the Agent SDK only provides
    // the interactive CLI runtime, so the employee runs as one — and the office says so.
    const mode: Employee['executionMode'] = employee.executionMode === 'managed_sdk' && host.info?.runtimes?.includes('managed_sdk') ? 'managed_sdk' : 'interactive_cli';
    if (employee.executionMode === 'managed_sdk' && mode !== 'managed_sdk') {
      this.core.event({ type: 'session.started', source: 'server', summary: `${employee.name} is configured for the SDK-managed runtime, which host "${host.name}" does not provide; starting as an interactive Claude Code worker instead`, employeeId, hostId, data: { requested: 'managed_sdk', actual: 'interactive_cli', fallback: true } });
      this.eng.comms.notify({ kind: 'info', severity: 'warning', title: `${employee.name}: runtime fallback`, body: `The SDK-managed runtime is not available on "${host.name}" (install it there with \`orchestrator-agent sdk install\` and restart the agent). ${employee.name} was started as an interactive Claude Code worker (full terminal takeover; approvals and messages go through hooks and the terminal).`, employeeId, hostId });
    }
    session.status = 'starting';
    session.activity = 'unknown';
    session.mode = mode;
    session.activityDetail = mode === 'managed_sdk' ? (resume ? 'Resuming the SDK-managed worker' : 'Starting the SDK-managed worker') : resume ? 'Resuming Claude Code session' : 'Starting Claude Code';
    session.activitySince = nowIso();
    session.inTurn = null;
    session.claudeConfigDir = employee.claudeConfigDir ?? null;
    session.endedAt = null;
    session.exitReason = null;
    session.lastEventAt = resume ? session.lastEventAt : null;
    session.asleepSince = null;
    session.resumed = resume;
    this.turnSince.delete(session.id);
    this.trustAsked.delete(session.id);
    this.bypassAsked.delete(session.id);
    if (resume) this.resumeProbes.set(session.id, session.lastEventAt);
    else this.resumeProbes.delete(session.id);
    this.trustAsked.delete(session.id);

    // A fresh bearer token per launch; older tokens for this session stop working.
    this.core.store.revokeCredentialsFor('mcp', session.id);
    const mcpToken = generateToken('orch_mcp');
    this.core.store.addCredential('mcp', mcpToken, { refId: session.id, label: employee.name });
    const spec = this.buildSpec(employee, session, cwd, resume, mcpToken, mode);
    // Asked to pick up the conversation Claude Code already has in this folder (one begun outside the office).
    if (opts.continueLast && !resume && mode === 'interactive_cli') spec.continueLast = true;
    session.launchId = spec.launchId = newId();
    // What this launch runs on (the profile may have changed since the session was last started).
    session.model = spec.model;
    session.effort = spec.effort ?? null;
    this.core.put('session', session);
    try {
      const report = await this.core.agents.rpc<AgentSessionReport>(hostId, { method: 'session.create', params: { sessionId: session.id, spec } }, 45000);
      const s = this.onReport(hostId, report);
      // They are back: earlier "went offline" notices about this employee are no longer something to act on.
      this.eng.comms.resolveNotifications((n) => n.kind === 'session_lost' && n.employeeId === employee.id);
      this.core.company.sessionsStarted++;
      this.core.saveCompany();
      this.core.audit(opts.actor ?? 'owner', resume ? 'session.resumed' : 'session.started', s.id, { employee: employee.name, cwd, host: host.name, permissionMode: spec.permissionMode, runtime: mode });
      return s;
    } catch (e) {
      session.status = 'exited';
      session.activity = 'offline';
      session.exitReason = (e as Error).message;
      session.activityDetail = session.exitReason;
      session.endedAt = nowIso();
      this.core.put('session', session);
      throw new EngineError(`could not start ${employee.name}'s session on ${host.name}: ${(e as Error).message}`, 502);
    }
  }

  async stop(employeeId: string, opts: { actor?: string; reason?: string; asleep?: boolean } = {}): Promise<void> {
    const employee = this.core.employees.require(employeeId);
    const s = this.core.runningSessionOf(employeeId);
    if (!s) return;
    if (!this.core.agents.isOnline(s.hostId)) throw new EngineError('the host is offline; the session cannot be stopped from here');
    if (opts.asleep && s.origin !== 'managed') throw new EngineError('only a session the office started can be put to sleep');
    this.core.audit(opts.actor ?? 'owner', opts.asleep ? 'session.asleep' : s.origin === 'managed' ? 'session.stopped' : 'session.detached', s.id, { employee: employee.name, reason: opts.reason ?? null });
    if (s.origin === 'managed') {
      // Stopped on purpose — by a person, or by the office to start it again. Noted before the machine is asked, as
      // the machine's own report that the session is gone may come first, with its own words for why.
      const why = opts.reason ?? 'stopped by the owner';
      if (!opts.asleep) this.onPurpose.set(s.id, why);
      try {
        await this.core.agents.rpc(s.hostId, { method: 'session.kill', params: { sessionId: s.id } });
        if (opts.asleep) this.fellAsleep(s, employee, opts.reason ?? 'asleep');
        else this.onGone(s.hostId, s.id, why);
      } finally {
        this.onPurpose.delete(s.id);
      }
    } else {
      // Sessions we did not start are only ever detached, never killed.
      await this.core.agents.rpc(s.hostId, { method: 'session.detach', params: { sessionId: s.id } });
      this.onGone(s.hostId, s.id, 'detached from the office (the tmux session is still running)');
    }
  }

  /** Asleep: their last session was stopped by the office for sitting idle, and nothing has started them since. */
  asleep(employeeId: string | null | undefined): boolean {
    const s = this.core.sessionOf(employeeId);
    return !!s && !!s.asleepSince && s.status !== 'running' && s.status !== 'starting';
  }

  /** Why this employee's session cannot be started right now, in words; null when it can. */
  cannotStart(employee: Employee | undefined): string | null {
    if (!employee || employee.archived) return 'they are no longer employed here';
    if (!employee.hostId) return `${employee.name} is not assigned to a machine`;
    const host = this.core.hosts.get(employee.hostId);
    if (!host || !this.core.agents.isOnline(employee.hostId)) return `${host?.name ?? 'their machine'} is offline`;
    // A session that was running when its machine dropped off is still running there: it is reported again in a
    // moment, and a second one must not be started beside it meanwhile.
    if (this.core.sessions.find((x) => x.employeeId === employee.id && x.status === 'host_offline')) return `${employee.name}'s session is still running on ${host.name}, which is reconnecting`;
    const pressure = this.eng.hosts.exhausted(employee.hostId);
    if (pressure) return `${host.name} is out of resources (${pressure})`;
    if (!employee.workingDir && !this.core.projects.get(employee.projectId)?.repoPath && !this.wakeCwd(employee)) return `${employee.name} has no folder to work in`;
    return null;
  }

  /** At their desk, or asleep and able to be woken: someone who can be given something right now. */
  present(employeeId: string): boolean {
    if (this.core.runningSessionOf(employeeId)) return true;
    return this.asleep(employeeId) && !this.cannotStart(this.core.employees.get(employeeId));
  }

  /**
   * Where a woken employee continues: the folder of the task they have in hand, else the folder they last worked in
   * if it is still theirs (their own folder, their project's, or the folder of a task of theirs in that project).
   * Null: wherever a fresh start would put them.
   */
  private wakeCwd(employee: Employee): string | null {
    const inHand = this.eng.tasks.currentTask(employee.id);
    if (inHand?.worktree) return inHand.worktree;
    const last = this.core.sessions
      .filter((x) => x.employeeId === employee.id && x.origin === 'managed' && x.hostId === employee.hostId && (x.status === 'exited' || x.status === 'lost'))
      .sort((a, b) => ((b.endedAt ?? b.startedAt) > (a.endedAt ?? a.startedAt) ? 1 : -1))[0];
    if (!last) return null;
    const at = path.resolve(last.cwd);
    const project = this.core.projects.get(employee.projectId);
    const own = [employee.workingDir, project?.repoPath].filter((x): x is string => !!x).map((x) => path.resolve(x));
    if (own.includes(at)) return last.cwd;
    return this.core.tasks.find((t) => t.assigneeId === employee.id && t.projectId === employee.projectId && !!t.worktree && path.resolve(t.worktree) === at) ? last.cwd : null;
  }

  /**
   * Start the session of someone who is needed and has none: where they last worked, continuing the conversation
   * they had there. `why` is what they are needed for, for the record ("a message from the boss").
   */
  async wake(employeeId: string, why: string): Promise<AgentSession> {
    const employee = this.core.employees.require(employeeId);
    const running = this.core.runningSessionOf(employeeId);
    if (running) return running;
    const no = this.cannotStart(employee);
    if (no) throw new EngineError(no, 409);
    const wasAsleep = this.asleep(employeeId);
    const s = await this.start(employeeId, { cwd: this.wakeCwd(employee), actor: 'office' });
    this.core.event({
      type: 'session.woken',
      source: 'server',
      summary: `${employee.name} ${wasAsleep ? 'was woken' : 'was started'} for ${why} — ${s.resumed ? 'continuing where they left off' : 'in a new conversation (there was none to continue)'}`,
      hostId: s.hostId,
      sessionId: s.id,
      employeeId,
      data: { why, resumed: !!s.resumed, wasAsleep, cwd: s.cwd },
    });
    return s;
  }

  /**
   * Turn an attached, terminal-only session into a full employee session: Claude Code in that
   * pane is asked to exit (its own /exit command — nothing is killed), and the employee is then
   * started by the office in the same folder, continuing the same conversation, with hooks and tools.
   * If it does not exit (it is in the middle of something), nothing else is changed.
   */
  async adopt(sessionId: string, actor = 'owner'): Promise<AgentSession> {
    const s = this.core.sessions.require(sessionId);
    if (s.origin !== 'attached') throw new EngineError('only a session that was attached from outside can be taken over this way');
    if (s.status !== 'running') throw new EngineError('that session is not running');
    const employee = this.core.employees.get(s.employeeId);
    if (!employee) throw new EngineError('bind the session to an employee first');
    if (!this.core.agents.isOnline(s.hostId)) throw new EngineError('the machine is offline');
    const cwd = s.cwd;
    this.core.audit(actor, 'session.adopted', s.id, { employee: employee.name, tmuxSession: s.tmuxSession, cwd });
    await this.core.agents.rpc(s.hostId, { method: 'session.keys', params: { sessionId: s.id, keys: ['Escape'] } }).catch(() => undefined);
    await this.core.agents.rpc(s.hostId, { method: 'session.paste', params: { sessionId: s.id, text: '/exit', submit: true } });
    // The host notices the process ending and reports the session gone.
    for (let i = 0; i < 80 && this.core.sessions.get(sessionId)?.status === 'running'; i++) await new Promise((r) => setTimeout(r, 250));
    if (this.core.sessions.get(sessionId)?.status === 'running') throw new EngineError('Claude Code in that session did not exit (it may be in the middle of something). Nothing else was changed; try again when it is idle, or exit it yourself.', 409);
    if (!employee.workingDir && !employee.projectId) {
      employee.workingDir = cwd;
      this.core.put('employee', employee);
    }
    return this.start(employee.id, { cwd, continueLast: true, resume: false, actor });
  }

  /** Bind a session to an employee (attached sessions arrive unbound). */
  bind(sessionId: string, employeeId: string, actor = 'owner'): AgentSession {
    const s = this.core.sessions.require(sessionId);
    const employee = this.core.employees.require(employeeId);
    const other = this.core.runningSessionOf(employeeId);
    if (other && other.id !== sessionId) throw new EngineError(`${employee.name} already has a running session; stop or detach it first`);
    s.employeeId = employee.id;
    if (employee.hostId !== s.hostId) {
      employee.hostId = s.hostId;
    }
    if (!employee.workingDir && !employee.projectId) employee.workingDir = s.cwd;
    this.core.put('employee', employee);
    this.core.put('session', s);
    this.core.audit(actor, 'session.bound', sessionId, { employee: employee.name });
    this.core.event({ type: 'session.attached', source: 'server', summary: `${employee.name} is now represented by tmux session "${s.tmuxSession}"`, sessionId, employeeId, hostId: s.hostId, data: { origin: s.origin } });
    return s;
  }

  /** Attach an already-running tmux session on a host, from the office UI. */
  async attach(hostId: string, tmuxSession: string, tmuxPane: string | null, employeeId: string | null, actor = 'owner'): Promise<AgentSession> {
    if (!this.core.agents.isOnline(hostId)) throw new EngineError('that host is offline');
    const sessionId = newId();
    const report = await this.core.agents.rpc<AgentSessionReport>(hostId, { method: 'session.attach', params: { sessionId, tmuxSession, tmuxPane } });
    const s = this.onReport(hostId, report);
    this.core.audit(actor, 'session.attached', s.id, { tmuxSession, host: hostId });
    return employeeId ? this.bind(s.id, employeeId, actor) : s;
  }

  /** Interrupt the current turn (Escape) and hold the employee until resumed. */
  async pause(employeeId: string, actor = 'owner'): Promise<void> {
    const s = this.core.runningSessionOf(employeeId);
    if (!s) throw new EngineError('no running session to pause');
    const sent = await this.core.agents.rpc<{ via?: string }>(s.hostId, { method: 'session.interrupt', params: { sessionId: s.id } });
    this.core.gateway.setPaused(s.id, true);
    // The interrupt ended the turn; no Stop hook is guaranteed after one.
    s.inTurn = s.capabilities.hooks ? false : null;
    this.setActivity(s, 'paused', 'Interrupted by the owner');
    const emp = this.core.employees.get(employeeId);
    this.core.audit(actor, 'session.interrupted', s.id, { employee: emp?.name });
    this.core.event({ type: 'terminal.interrupt', source: 'owner', summary: `Boss interrupted ${emp?.name ?? 'the session'} (${sent?.via === 'sdk' ? 'through the Agent SDK' : 'Escape sent to the terminal'})`, sessionId: s.id, employeeId, hostId: s.hostId, data: { via: sent?.via ?? 'terminal' } });
  }

  async resume(employeeId: string, actor = 'owner'): Promise<void> {
    const s = this.core.runningSessionOf(employeeId);
    if (!s) throw new EngineError('no running session to resume');
    this.core.gateway.setPaused(s.id, false);
    const emp = this.core.employees.get(employeeId);
    this.core.audit(actor, 'session.resumed_by_owner', s.id, { employee: emp?.name });
    const task = this.eng.tasks.currentTask(employeeId);
    // The next hook sets the real state; until then the employee is between turns.
    if (s.capabilities.hooks) s.inTurn = false;
    this.setActivity(s, 'idle', null);
    if (task) {
      this.eng.comms.sendMessage({ from: { kind: 'owner', id: null, name: 'the boss' }, toEmployeeId: employeeId, body: `Please resume your work on ${task.key} "${task.title}" from where you were interrupted.`, kind: 'system', taskId: task.id });
    }
    this.eng.comms.schedulePump(employeeId, 100);
    this.eng.tasks.schedule();
  }

  /**
   * The session a tools token belongs to — while that session is one that can be calling: it is running (or its
   * machine is away for a moment), and its machine is still part of the office. A token copied out of a session's
   * files opens nothing once the session has ended or its machine was taken out.
   */
  sessionByMcpToken(token: string | null | undefined): AgentSession | undefined {
    const cred = this.core.store.checkCredential('mcp', token);
    const s = cred?.refId ? this.core.sessions.get(cred.refId) : undefined;
    if (!s || (s.status !== 'running' && s.status !== 'starting' && s.status !== 'host_offline')) return undefined;
    const host = this.core.hosts.get(s.hostId);
    if (!host || host.status === 'revoked') return undefined;
    return s;
  }
}

/** Used up for now: one of the two windows is at its limit and has not reset yet. */
/** A model's week is used up: at its limit, and its time has not come (one that names no time is believed while it stands). */
export const weekFull = (w: { usedPercent: number; resetsAt: string | null }): boolean => w.usedPercent >= 99 && (!w.resetsAt || Date.parse(w.resetsAt) > Date.now());

/** The time a refusal names for when the limit lifts, if it names one the office can read: an ISO time, or seconds since 1970 after "reset". */
export function resetNamedIn(text: string, now = Date.now()): string | null {
  const iso = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)\b/.exec(text)?.[1];
  let at = iso ? Date.parse(iso) : Number(/reset[a-z_ ]*[^0-9]{0,12}(\d{10})\b/i.exec(text)?.[1] ?? NaN) * 1000;
  // As Claude Code says it on the screen: "resets Nov 19, 1pm (UTC)", "resets 5:30am (Europe/Belgrade)".
  if (!Number.isFinite(at)) at = resetWordsAt(text, now) ?? NaN;
  return Number.isFinite(at) && at > now && at < now + 14 * 86_400_000 ? new Date(at).toISOString() : null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "resets Nov 19, 1pm (UTC)" → that moment; a time alone is the next such time. The zone in brackets is honoured; none means UTC. */
function resetWordsAt(text: string, now: number): number | null {
  const m = /resets?\s+(?:on\s+)?(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i.exec(text);
  if (!m) return null;
  const month = m[1] ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  if (m[1] && month < 0) return null;
  let hour = Number(m[3]);
  const minute = Number(m[4] ?? 0);
  const half = m[5]?.toLowerCase();
  if (!half && !m[4]) return null; // a bare number is not a time
  if (half === 'pm' && hour < 12) hour += 12;
  if (half === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  const zone = (m[6] ?? 'UTC').trim();
  const offset = (instant: number): number | null => {
    if (/^(utc|gmt|z)$/i.test(zone)) return 0;
    try {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(instant)).map((p) => [p.type, p.value]));
      return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute)) - Math.floor(instant / 60_000) * 60_000;
    } catch {
      return null; // a zone this machine does not know
    }
  };
  const today = new Date(now);
  const at = (year: number, mon: number, day: number): number | null => {
    const guess = Date.UTC(year, mon, day, hour, minute);
    const off = offset(guess);
    return off === null ? null : guess - off;
  };
  if (month >= 0) {
    const day = Number(m[2]);
    let t = at(today.getUTCFullYear(), month, day);
    // "Jan 2" said in late December is next year's.
    if (t !== null && t < now - 2 * 86_400_000) t = at(today.getUTCFullYear() + 1, month, day);
    return t;
  }
  let t = at(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  if (t !== null && t <= now) t = at(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1);
  return t;
}

/**
 * What a refusal for a limit says, read from its words: whose limit (one model's — "You've hit your Fable limit" —
 * or the account's, family '') and until when. Null when the words are not about a limit at all.
 */
export function limitIn(text: string, now = Date.now()): { family: string; resetsAt: string | null } | null {
  const said = String(text ?? '');
  if (!/limit|rate.?limit|billing/i.test(said)) return null;
  const named = /hit\s+(?:your|the)\s+([A-Za-z][\w.-]*)\s+limit/i.exec(said)?.[1] ?? /([A-Za-z][\w.-]*)\s+(?:weekly\s+)?limit\s+(?:reached|hit)/i.exec(said)?.[1] ?? /(?:weekly\s+)?limit\s+for\s+([A-Za-z][\w.-]*)/i.exec(said)?.[1] ?? '';
  const family = modelFamily(named) || (/week/i.test(said) ? modelFamily(said) : '');
  return { family, resetsAt: resetNamedIn(said, now) };
}

/** The models to go on with, in order, when one model's limit is reached: the next weaker that has room. */
export const MODEL_FALLBACK: Record<string, string[]> = { mythos: ['opus', 'sonnet', 'haiku'], fable: ['opus', 'sonnet', 'haiku'], opus: ['sonnet', 'haiku'], sonnet: ['haiku'], haiku: [] };

export function exhausted(a: Pick<AccountUsage, 'fiveHour' | 'sevenDay'> & { spentUntil?: string | null; reportedAt?: string | null }): boolean {
  // A figure that names no reset time is believed for as long as its window is (five hours, a week) from when it was
  // reported — not for ever: once everybody has been moved off an account, nobody reports a newer figure for it.
  const full = (w: AccountUsage['fiveHour'], windowMs: number) =>
    !!w && w.usedPercent >= 99 && (w.resetsAt ? Date.parse(w.resetsAt) > Date.now() : !a.reportedAt || Date.parse(a.reportedAt) + windowMs > Date.now());
  return full(a.fiveHour, 5 * 3600_000) || full(a.sevenDay, 7 * 86_400_000) || (!!a.spentUntil && Date.parse(a.spentUntil) > Date.now());
}

