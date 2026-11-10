import type { AutonomyLevel } from './entities.ts';

/**
 * Predefined employee profiles. A role is real configuration: it becomes
 * instructions appended to the Claude Code system prompt, a default autonomy
 * level and default tool restrictions. It does not change the model.
 */
export interface RoleProfile {
  key: string;
  title: string;
  department: string;
  specialization: string;
  skills: string[];
  /** Appended to the worker's system prompt. */
  instructions: string;
  defaultAutonomy: AutonomyLevel;
  /** Tools denied for this role regardless of autonomy (Claude Code tool rules). */
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
    defaultAutonomy: 'standard',
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
    defaultAutonomy: 'standard',
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
    defaultAutonomy: 'standard',
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
    defaultAutonomy: 'standard',
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
    defaultAutonomy: 'supervised',
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
    defaultAutonomy: 'standard',
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
    defaultAutonomy: 'standard',
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
    defaultAutonomy: 'supervised',
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
    defaultAutonomy: 'standard',
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
    defaultAutonomy: 'restricted',
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
    defaultAutonomy: 'restricted',
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
    defaultAutonomy: 'standard',
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
    defaultAutonomy: 'restricted',
    disallowedTools: [],
    handles: ['planning'],
    color: '#ff9ecb',
  },
  {
    key: 'reviewer',
    title: 'Code Reviewer',
    department: 'Quality',
    specialization: 'Code review',
    skills: ['Code Review', 'Maintainability', 'Testing', 'Security Awareness'],
    instructions:
      'You are the code reviewer. Review diffs for correctness, tests and maintainability. Give a clear verdict (approve or request changes) with specific, actionable comments. Do not modify the code under review.',
    defaultAutonomy: 'restricted',
    disallowedTools: [],
    handles: ['review'],
    color: '#b0e05a',
  },
];

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
