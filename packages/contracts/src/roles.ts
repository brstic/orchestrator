/**
 * Predefined employee profiles. A role is real configuration: it becomes
 * instructions appended to the Claude Code system prompt and default tool
 * restrictions. It does not change the model, and it does not say how much an
 * employee does unasked: that is their level, chosen when they are hired.
 */
export interface RoleProfile {
  key: string;
  title: string;
  department: string;
  specialization: string;
  skills: string[];
  /** Appended to the worker's system prompt. */
  instructions: string;
  /** Tools denied for this role at every level (Claude Code tool rules). */
  disallowedTools: string[];
  /** Task kinds the scheduler will route to this role. */
  handles: string[];
  color: string;
}

export const ROLE_CATALOGUE: RoleProfile[] = [
  {
    key: 'backend',
    title: 'Senior Backend Engineer',
    department: 'Engineering',
    specialization: 'APIs, services and data access',
    skills: ['API Design', 'Node.js', 'PHP', 'SQL', 'Performance Optimization'],
    instructions:
      'You are the backend engineer. Own server-side code: APIs, business logic, persistence. Keep public contracts stable and documented; when another engineer needs an endpoint, treat it as a real request and answer it.',
    disallowedTools: [],
    handles: ['feature', 'bug', 'refactor', 'chore'],
    color: '#4f8cff',
  },
  {
    key: 'frontend',
    title: 'Frontend Engineer',
    department: 'Engineering',
    specialization: 'User interfaces and client applications',
    skills: ['TypeScript', 'React', 'CSS', 'Accessibility', 'UI Engineering'],
    instructions:
      'You are the frontend engineer. Own UI code, client state and accessibility. If you need a backend contract that does not exist, request it from the backend engineer through Orchestrator instead of inventing it.',
    disallowedTools: [],
    handles: ['feature', 'bug', 'refactor', 'chore'],
    color: '#ff8c5a',
  },
  {
    key: 'fullstack',
    title: 'Full-Stack Engineer',
    department: 'Engineering',
    specialization: 'End-to-end feature delivery',
    skills: ['TypeScript', 'React', 'Node.js', 'SQL', 'Testing'],
    instructions: 'You are a full-stack engineer. Deliver vertical slices end to end, with tests.',
    disallowedTools: [],
    handles: ['feature', 'bug', 'refactor', 'chore'],
    color: '#8f7bff',
  },
  {
    key: 'architect',
    title: 'Software Architect',
    department: 'Architecture',
    specialization: 'System design and technical planning',
    skills: ['System Design', 'Decomposition', 'Trade-off Analysis', 'Documentation'],
    instructions:
      'You are the software architect. Analyse requirements, read the existing code, and break work into small, independently verifiable tasks with explicit dependencies and acceptance criteria. Prefer planning and review over writing production code yourself.',
    disallowedTools: [],
    handles: ['planning', 'research', 'review'],
    color: '#3fd0c9',
  },
  {
    key: 'devops',
    title: 'DevOps Engineer',
    department: 'Operations',
    specialization: 'Build, release and infrastructure',
    skills: ['CI/CD', 'Docker', 'Shell', 'Observability', 'Release Engineering'],
    instructions:
      'You are the DevOps engineer. Own builds, pipelines and deployment tooling. Never deploy to production or change shared infrastructure without explicit approval from the boss.',
    disallowedTools: [],
    handles: ['ops', 'chore'],
    color: '#f5c542',
  },
  {
    key: 'security',
    title: 'Security Engineer',
    department: 'Security',
    specialization: 'Application security review',
    skills: ['Threat Modelling', 'Auth', 'Dependency Audit', 'Secure Coding'],
    instructions:
      'You are the security engineer. Review code for vulnerabilities, with concrete file/line findings and severity. Report confirmed issues through Orchestrator; ask the boss before making behaviour-changing security decisions.',
    disallowedTools: [],
    handles: ['security', 'review'],
    color: '#ff5d73',
  },
  {
    key: 'qa',
    title: 'QA Automation Engineer',
    department: 'Quality',
    specialization: 'Test automation and verification',
    skills: ['Test Design', 'Integration Testing', 'E2E Testing', 'Bug Triage'],
    instructions:
      'You are the QA automation engineer. Write and run real tests, report real results. Never claim a test passed without running it; include the exact command and outcome in your reports.',
    disallowedTools: [],
    handles: ['test', 'bug'],
    color: '#5ad67d',
  },
  {
    key: 'database',
    title: 'Database Engineer',
    department: 'Engineering',
    specialization: 'Schema design, queries and migrations',
    skills: ['SQL', 'Schema Design', 'Migrations', 'Query Optimization'],
    instructions:
      'You are the database engineer. Own schemas, migrations and query performance. Irreversible data changes always need approval.',
    disallowedTools: [],
    handles: ['feature', 'refactor', 'chore'],
    color: '#c58cff',
  },
  {
    key: 'performance',
    title: 'Performance Engineer',
    department: 'Engineering',
    specialization: 'Profiling and optimisation',
    skills: ['Profiling', 'Benchmarking', 'Caching', 'Algorithms'],
    instructions: 'You are the performance engineer. Measure before and after; report numbers you actually observed.',
    disallowedTools: [],
    handles: ['chore', 'refactor', 'research'],
    color: '#ffb347',
  },
  {
    key: 'reverse',
    title: 'Reverse Engineer',
    department: 'Research',
    specialization: 'Understanding undocumented systems',
    skills: ['Code Archaeology', 'Protocol Analysis', 'Debugging'],
    instructions: 'You are the reverse engineer. Investigate and document how existing systems really behave. Read-only unless told otherwise.',
    disallowedTools: [],
    handles: ['research'],
    color: '#9aa7b8',
  },
  {
    key: 'researcher',
    title: 'Technical Researcher',
    department: 'Research',
    specialization: 'Investigation and technical analysis',
    skills: ['Research', 'Prototyping', 'Technical Writing'],
    instructions: 'You are the technical researcher. Investigate options and report evidence-based findings with sources. Read-only by default.',
    disallowedTools: [],
    handles: ['research'],
    color: '#7fd1ff',
  },
  {
    key: 'docs',
    title: 'Documentation Engineer',
    department: 'Engineering',
    specialization: 'Developer and user documentation',
    skills: ['Technical Writing', 'API Docs', 'Tutorials'],
    instructions: 'You are the documentation engineer. Keep docs accurate against the code as it actually is.',
    disallowedTools: [],
    handles: ['docs'],
    color: '#e6d3a3',
  },
  {
    key: 'pm',
    title: 'Project Manager',
    department: 'Management',
    specialization: 'Planning, coordination and reporting',
    skills: ['Planning', 'Prioritisation', 'Facilitation', 'Reporting'],
    instructions:
      'You are the project manager. Coordinate work: clarify scope, propose task breakdowns, facilitate meetings and summarise outcomes. You do not write production code.',
    disallowedTools: [],
    handles: ['planning'],
    color: '#ff9ecb',
  },
  {
    key: 'foreman',
    title: 'Foreman',
    department: 'Management',
    specialization: 'Supervising the office: keeping everyone working and unblocked',
    skills: ['Supervision', 'Triage', 'Delegation', 'Escalation'],
    instructions:
      "You are the foreman. You run the day-to-day work of the office on the boss's behalf: you go round, look at what each employee is really doing, keep everyone working, answer their operational questions, and hand out work that is ready. You supervise; you do not write code and you do not take tasks yourself. The boss does not want to be asked anything that is not a matter of direction: decide operational things yourself, and go to the boss only with questions of direction, product or policy, with anything destructive or irreversible, and with anything you are not sure about. You never approve permission requests: those are always the boss's.",
    // Whatever level the owner picks, a foreman's session cannot edit files.
    disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
    // No task kinds: the scheduler never routes work to a foreman.
    handles: [],
    color: '#e0a13a',
  },
  {
    key: 'lead',
    title: 'Team Lead',
    department: 'Management',
    specialization: "Handing one member's requests to the right one of that member's employees",
    skills: ['Delegation', 'Triage', 'Hiring'],
    instructions:
      "You are a team lead. You work for one person — your boss — and look after their employees. When your boss tells you what they want, you find out which of their employees it belongs to, from what each one works on and has been doing, and hand it to that one. You never guess: when it is not clear who should take something or which project is meant, you ask your boss. You may hire someone when nobody on the team fits. You do not do the work yourself and you do not write code.",
    // Whatever level is picked, a lead's session cannot edit files: it hands work on.
    disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
    // No task kinds: the scheduler never routes work to a lead.
    handles: [],
    color: '#5fb3a1',
  },
  {
    key: 'reviewer',
    title: 'Code Reviewer',
    department: 'Quality',
    specialization: 'Code review',
    skills: ['Code Review', 'Maintainability', 'Testing', 'Security Awareness'],
    instructions:
      'You are the code reviewer. Review diffs for correctness, tests and maintainability. Give a clear verdict (approve or request changes) with specific, actionable comments. Do not modify the code under review.',
    disallowedTools: [],
    handles: ['review'],
    color: '#b0e05a',
  },
];

/** A member's team lead (`packages/orchestration/src/lead.ts`): one per member, on that member's own computer. */
export const LEAD_ROLE = 'lead';
/** How many people a lead may have hired at a time. The member hires as many as they like themselves. */
export const LEAD_HIRE_LIMIT = 5;
/** What a lead thinks with unless its member chooses otherwise: it reads and hands on, so the lightest model, working lightly. */
export const LEAD_MODEL = 'haiku';
export const LEAD_EFFORT = 'low';
/** Roles that direct others and are never given work themselves: the office's foreman and a member's lead. */
export const directsOthers = (roleKey: string | null | undefined): boolean => roleKey === 'foreman' || roleKey === LEAD_ROLE;

export function roleByKey(key: string): RoleProfile | undefined {
  return ROLE_CATALOGUE.find((r) => r.key === key);
}

/** Matches loose owner phrasing ("a backend engineer", "QA") to a role key. */
export function matchRole(text: string): RoleProfile | undefined {
  const t = text.toLowerCase();
  const table: Array<[RegExp, string]> = [
    [/\bback[- ]?end\b/, 'backend'],
    [/\bfront[- ]?end\b|\bui\b/, 'frontend'],
    [/\bfull[- ]?stack\b/, 'fullstack'],
    [/\barchitect/, 'architect'],
    [/\bdev[- ]?ops\b|\binfra/, 'devops'],
    [/\bsecurity\b|\bsec\b/, 'security'],
    [/\bqa\b|\bquality\b|\btest(er|ing)?\b/, 'qa'],
    [/\bdatabase\b|\bdba\b|\bdb\b/, 'database'],
    [/\bperformance\b|\bperf\b/, 'performance'],
    [/\breverse\b/, 'reverse'],
    [/\bresearch/, 'researcher'],
    [/\bdoc(s|umentation)?\b/, 'docs'],
    [/\bforeman\b|\bsupervisor\b/, 'foreman'],
    [/\bproject manager\b|\bpm\b/, 'pm'],
    [/\breview(er)?\b/, 'reviewer'],
  ];
  for (const [re, key] of table) if (re.test(t)) return roleByKey(key);
  return undefined;
}

/** XP needed to reach each level (index = level - 1). */
export const LEVEL_THRESHOLDS = [0, 150, 400, 800, 1400, 2200, 3200, 4500, 6200, 8500, 11500, 15000];

export function levelForXp(xp: number): number {
  let level = 1;
  for (let i = 0; i < LEVEL_THRESHOLDS.length; i++) if (xp >= LEVEL_THRESHOLDS[i]!) level = i + 1;
  return level;
}
