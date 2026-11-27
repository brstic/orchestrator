/**
 * A small Model Context Protocol server over Streamable HTTP (JSON responses,
 * stateless). It implements exactly what a tools-only server needs:
 * initialize, ping, tools/list, tools/call and notifications.
 *
 * Transport and authentication are the HTTP server's job; this module turns a
 * parsed JSON-RPC body into a JSON-RPC response.
 */

export interface McpToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  text: string;
  isError?: boolean;
}

export type McpToolHandler<Ctx> = (args: Record<string, any>, ctx: Ctx) => Promise<McpToolResult | string>;

export interface McpServerOptions<Ctx> {
  name: string;
  version: string;
  instructions: string;
  tools: McpToolSpec[];
  handlers: Record<string, McpToolHandler<Ctx>>;
  /**
   * Which tools a caller is shown by tools/list (default: all of them). Not an access check:
   * a handler that is not for everyone must refuse by itself.
   */
  listed?: (tool: McpToolSpec, ctx: Ctx) => boolean;
}

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST = '2025-06-18';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: any;
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function validateArgs(schema: any, args: Record<string, any>): string | null {
  if (!schema || schema.type !== 'object') return null;
  for (const key of schema.required ?? []) {
    if (args[key] === undefined || args[key] === null || args[key] === '') return `missing required argument "${key}"`;
  }
  for (const [key, def] of Object.entries<any>(schema.properties ?? {})) {
    const v = args[key];
    if (v === undefined || v === null) continue;
    const t = def.type;
    if (t === 'string' && typeof v !== 'string') return `argument "${key}" must be a string`;
    if ((t === 'number' || t === 'integer') && typeof v !== 'number') return `argument "${key}" must be a number`;
    if (t === 'boolean' && typeof v !== 'boolean') return `argument "${key}" must be a boolean`;
    if (t === 'array' && !Array.isArray(v)) return `argument "${key}" must be an array`;
    if (def.enum && !def.enum.includes(v)) return `argument "${key}" must be one of: ${def.enum.join(', ')}`;
  }
  return null;
}

async function handleOne<Ctx>(req: JsonRpcRequest, opts: McpServerOptions<Ctx>, ctx: Ctx): Promise<object | null> {
  const isNotification = req.id === undefined;
  if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') return rpcError(req?.id, -32600, 'Invalid Request');
  if (isNotification) return null;
  switch (req.method) {
    case 'initialize': {
      const requested = String(req.params?.protocolVersion ?? '');
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : LATEST,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: opts.name, version: opts.version },
          instructions: opts.instructions,
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id: req.id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id: req.id, result: { tools: opts.listed ? opts.tools.filter((t) => opts.listed!(t, ctx)) : opts.tools } };
    case 'tools/call': {
      const name = String(req.params?.name ?? '');
      const spec = opts.tools.find((t) => t.name === name);
      const handler = opts.handlers[name];
      if (!spec || !handler) return rpcError(req.id, -32602, `Unknown tool: ${name}`);
      const args = (req.params?.arguments ?? {}) as Record<string, any>;
      const invalid = validateArgs(spec.inputSchema, args);
      if (invalid) return { jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: `Invalid arguments: ${invalid}` }], isError: true } };
      try {
        const res = await handler(args, ctx);
        const result = typeof res === 'string' ? { text: res } : res;
        return { jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: result.text }], isError: result.isError === true } };
      } catch (e) {
        return { jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true } };
      }
    }
    case 'resources/list':
      return { jsonrpc: '2.0', id: req.id, result: { resources: [] } };
    case 'prompts/list':
      return { jsonrpc: '2.0', id: req.id, result: { prompts: [] } };
    default:
      return rpcError(req.id, -32601, `Method not found: ${req.method}`);
  }
}

/** Returns the HTTP status and JSON body for a POSTed MCP message (or batch). */
export async function handleMcpPost<Ctx>(body: unknown, opts: McpServerOptions<Ctx>, ctx: Ctx): Promise<{ status: number; body: unknown | null }> {
  if (Array.isArray(body)) {
    const results = (await Promise.all(body.map((r) => handleOne(r, opts, ctx)))).filter((r) => r !== null);
    return results.length ? { status: 200, body: results } : { status: 202, body: null };
  }
  if (!body || typeof body !== 'object') return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  const res = await handleOne(body as JsonRpcRequest, opts, ctx);
  return res ? { status: 200, body: res } : { status: 202, body: null };
}

// ───────────────────────── Tool catalogue ────────────────────────

const str = (description: string) => ({ type: 'string', description });
const WAIT = { type: 'boolean', description: 'true = you need the answer before you can go on: wait for it in this call instead of carrying on. They are told that you are waiting.' };

export const ORCHESTRATOR_TOOLS: McpToolSpec[] = [
  {
    name: 'get_current_task',
    description: 'Get the task currently assigned to you: description, acceptance criteria, branch, dependencies and reviewer feedback.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_project_context',
    description: 'Get the project you are working on: goals, requirements, documentation notes, teammates and the state of related tasks.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'report_status',
    description: 'Tell the office what you are doing right now in one short sentence. Shown above your desk and in the office feed.',
    inputSchema: { type: 'object', properties: { status: str('Short present-tense status, e.g. "Implementing password reset endpoint"'), detail: str('Optional extra detail') }, required: ['status'] },
  },
  {
    name: 'report_progress',
    description: 'Report real progress on your current task at meaningful milestones (not on every step).',
    inputSchema: { type: 'object', properties: { note: str('What was just accomplished'), percent: { type: 'number', description: 'Your honest estimate of completion, 0-100 (optional)' } }, required: ['note'] },
  },
  {
    name: 'ask_boss',
    description:
      'Ask the owner (the boss) a question or for a decision when you genuinely need one: unclear requirements, architecture choices, priority conflicts, risky or irreversible actions. This blocks until the boss answers or a few minutes pass. Do not guess instead of asking; do not ask about things you can determine yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        question: str('The question, phrased so it can be answered without reading your terminal'),
        context: str('Relevant technical context'),
        why: str('Why this matters / what depends on the answer'),
        kind: { type: 'string', enum: ['question', 'decision', 'priority', 'deployment'], description: 'Type of question' },
        options: {
          type: 'array',
          description: 'Suggested answers, if any',
          items: { type: 'object', properties: { label: str('Short option label'), description: str('What this option means'), consequence: str('Known consequence of choosing it'), release: { type: 'boolean', description: 'kind "deployment", when the release gate holds you: true on the choice that lets you release. An owner choosing it opens the gate for you for an hour' } }, required: ['label'] },
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'wait_for_answer',
    description: 'Keep waiting for the boss to answer a question you asked earlier with ask_boss. Blocks for a few minutes.',
    inputSchema: { type: 'object', properties: { question_id: str('The question id returned by ask_boss') }, required: ['question_id'] },
  },
  {
    name: 'comment_on_task',
    description:
      'Write on a ticket\'s conversation: what the boss or a colleague should know about it, an answer when you were tagged on it, or a question. Tag who should read it in the text (@boss, @Name) or in "to"; nobody is told about a comment that tags nobody. With ask: true you are saying "I am not sure, or I cannot go on, without this answer": the call waits for it (a few minutes at most); if none comes the ticket waits for it by itself — you stop working on it and wait too (no new task is given to you while a question of yours is open), and you get it back with the answer. Use that instead of guessing and instead of report_blocker. A question that is a choice carries its choices in "options"; something to look at goes in "files".',
    inputSchema: {
      type: 'object',
      properties: {
        text: str('What you have to say, or your question: specific, with the exact thing (file, command, option A or B) — whoever reads it is in the middle of their own work'),
        task: str('Key of the ticket, e.g. "T-12". Leave out for the ticket you are working on'),
        to: { type: 'array', items: { type: 'string' }, description: 'Who it is for: "boss", or colleagues by name. The same as tagging them in the text' },
        ask: { type: 'boolean', description: 'true = a question you cannot go on without. Only on the ticket you are working on. Without "to" it goes to the boss' },
        options: {
          type: 'array',
          description: 'With ask: the answers you propose, two to four. ALWAYS give them when the question is a choice (A or B, yes or no, which of these): the boss answers with one click instead of typing. Put your recommendation first and say why in its description',
          items: { type: 'object', properties: { label: str('The answer, in a few words — it is what you get back'), description: str('What this option means'), consequence: str('What follows from choosing it') }, required: ['label'] },
        },
        context: str('With ask: what the boss needs to know to answer without reading your terminal'),
        why: str('With ask: what depends on the answer'),
        files: { type: 'array', items: { type: 'string' }, description: 'Paths of pictures or documents on this machine to show with the comment (a screenshot of what you built, a mock-up, a log). They are put on the ticket and shown under the comment, where the boss sees them and can enlarge them. Never write only the path of a picture in the text: nobody else can open a path on your machine' },
      },
      required: ['text'],
    },
  },
  {
    name: 'split_task',
    description:
      'Divide the ticket you are working on into parts for colleagues, when it is too much for one or the boss put colleagues on it with you. Each part becomes a ticket of its own, handed to its colleague; keep a part for yourself (it stays in this ticket). You are told as parts are finished; call complete_task when your own part is done — the ticket then waits for the rest and comes back to you to bring the whole together. A part cannot be split again.',
    inputSchema: {
      type: 'object',
      properties: {
        parts: {
          type: 'array',
          description: 'One to six parts, each independent enough to be done without waiting for the others',
          items: {
            type: 'object',
            properties: {
              title: str('Short imperative title'),
              description: str('What to do, where, and what it must fit with — whoever gets it has only this and the ticket\'s conversation'),
              acceptance: str('How to tell it is done'),
              assignee: str('The colleague it is for, by name (see get_team). Leave out to let it go to a colleague already on the ticket, or to whoever fits and is free'),
            },
            required: ['title', 'description'],
          },
        },
      },
      required: ['parts'],
    },
  },
  {
    name: 'report_blocker',
    description: 'Report that you cannot continue your current task because of something no answer can solve (a machine that is down, access that does not exist). Marks the task BLOCKED and alerts the boss; it is written on the ticket, and the boss\'s reply there brings it back to you. If an answer would let you go on, ask on the ticket instead (comment_on_task with ask: true).',
    inputSchema: { type: 'object', properties: { reason: str('What is blocking you'), needs: str('What you need in order to continue') }, required: ['reason'] },
  },
  {
    name: 'complete_task',
    description:
      'Declare your current task complete. Commit your work first. Orchestrator then independently verifies it (clean working tree, commits on your branch, the project verification command) and tells you the result — if verification fails you must fix the problem and call this again.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: str('What you did and how it meets the acceptance criteria'),
        tests_run: str('Exact test commands you ran and their real outcome'),
        no_code_changes: { type: 'boolean', description: 'Set true only if the task legitimately required no changes to the repository (research, review, planning)' },
        release_plan: str("Where this work goes once it is approved, and how: the branches to push to (e.g. master), the servers to update (e.g. production), the steps and checks, and who does which part. Leave it out only if nothing goes anywhere. With the office's release gate on, nothing reaches the protected branches or production before an owner approves the work; your own branches and the development servers are free before that."),
      },
      required: ['summary'],
    },
  },
  {
    name: 'report_released',
    description: 'Say that work an owner approved is released — pushed and deployed where its release plan said. Written on the ticket; the release gate closes again for it.',
    inputSchema: {
      type: 'object',
      properties: { task: str('The task key, e.g. T-12'), note: str('What you released, where, and how you checked it is live') },
      required: ['task', 'note'],
    },
  },
  {
    name: 'submit_result',
    description: 'Store a deliverable document (report, plan, findings, review notes) so the boss and teammates can read it.',
    inputSchema: {
      type: 'object',
      properties: { title: str('Document title'), content: str('Markdown content'), kind: { type: 'string', enum: ['report', 'plan', 'summary', 'review'], description: 'Document type' } },
      required: ['title', 'content'],
    },
  },
  {
    name: 'request_review',
    description: 'Ask for a review of your current task branch before completing it. Optionally name a reviewer (teammate name or role).',
    inputSchema: { type: 'object', properties: { reviewer: str('Teammate name or role, optional'), notes: str('What the reviewer should focus on') } },
  },
  {
    name: 'answer_team_question',
    description: "Answer a colleague's question about work you put on the board, in the boss's place (you are told of each, with its question_id). Answer only what you know the boss would; anything about direction, money or what cannot be undone, or that you are not sure of: escalate_question.",
    inputSchema: { type: 'object', properties: { question_id: str('The id you were given with the question'), answer: str('Your answer, as the colleague should read it'), answers: { type: 'object', description: 'For a question in several parts: one answer per part, keyed by the part\'s exact text' } }, required: ['question_id', 'answer'] },
  },
  {
    name: 'escalate_question',
    description: "Hand a colleague's question that waits for your answer to the boss: it needs the boss, or you are not sure. Say why.",
    inputSchema: { type: 'object', properties: { question_id: str('The id you were given with the question'), why: str('Why the boss should answer it') }, required: ['question_id', 'why'] },
  },
  {
    name: 'escalate_review',
    description: "Hand the verdict on a task that waits for yours, in the boss's place, to the boss: you are not sure it is what the boss wants. Say why — the boss reads it and decides.",
    inputSchema: { type: 'object', properties: { task: str('Key of the task, e.g. "T-12"'), why: str('Why the boss should decide it: what you are unsure of') }, required: ['task', 'why'] },
  },
  {
    name: 'submit_review',
    description: 'Give your verdict on a task that is waiting for review: one you were asked to review, or — where employees manage the board — any teammate\'s finished work. Never your own. Read the change before you approve it; "approve" lets it be merged.',
    inputSchema: {
      type: 'object',
      properties: {
        task: str('Key of the task under review, e.g. "T-12"'),
        verdict: { type: 'string', enum: ['approve', 'request_changes'], description: 'Your verdict' },
        comments: str('Specific, actionable review comments'),
        checked: str('What you ran or opened to reach the verdict, and what it showed: commands and their result, the page or request on the development server, the query. Needed to approve code the office did not test itself; the owner reads it.'),
      },
      required: ['task', 'verdict', 'comments'],
    },
  },
  {
    name: 'send_message',
    description: 'Send a message to a teammate. It is delivered to their real session when they can read it.',
    inputSchema: { type: 'object', properties: { to: str('Teammate name'), message: str('The message') }, required: ['to', 'message'] },
  },
  {
    name: 'message_person',
    description:
      'Write straight to a person of the office — the boss, or a colleague (a person, not an employee) by name — when something needs their attention now, or when you were asked to tell them something. It lands in their Inbox, and on Telegram where they talk to you there. It does not wait for an answer: if they answer, it comes to you as a message. For a decision you cannot go on without, use ask_boss; for an employee, send_message. Use it sparingly: every one interrupts a person.',
    inputSchema: {
      type: 'object',
      properties: {
        to: str('"boss" (every owner of the office), or the name of a person, e.g. "Ana"'),
        message: str('What they should know or do — whole, so that it can be read without your terminal'),
        urgent: { type: 'boolean', description: 'Only when it cannot wait: it is marked as needing their attention' },
      },
      required: ['to', 'message'],
    },
  },
  {
    name: 'message_client',
    description:
      'Write to a client who rents you, in your conversation with them on the Rent portal, when you are not answering a message of theirs: the boss asks you to tell or ask them something, or news comes that they wait for (the boss\'s answer, a colleague\'s result). It is there at once, marked new, without waiting for them to write first. When you are answering their message, just reply — that already goes to them. Only what is for the client: nothing of the office they should not see.',
    inputSchema: {
      type: 'object',
      properties: {
        to: str('The client\'s name (or company); may be left out when only one client rents you'),
        message: str('What they should read — whole, written to them'),
      },
      required: ['message'],
    },
  },
  {
    name: 'request_collaboration',
    description:
      'Ask a teammate for something you need from them (an endpoint, a contract, a fix, information). They must respond: incorporate it, turn it into a task, report a dependency, or escalate. If you cannot go on without their answer, set wait to true: the call then stays open until they answer (a few minutes at most) and returns their answer.',
    inputSchema: { type: 'object', properties: { to: str('Teammate name or role (e.g. "backend")'), summary: str('One-line request'), detail: str('Details: what exactly you need and why'), wait: WAIT }, required: ['to', 'summary'] },
  },
  {
    name: 'hand_off_task',
    description: 'Hand the task you are working on over to a teammate who should finish it (it needs their speciality, or you cannot continue it). Commit your work first: they continue from your branch. Your notes travel with the task.',
    inputSchema: { type: 'object', properties: { to: str('Teammate name or role (e.g. "frontend")'), notes: str('Where the task stands: what is done, what remains, anything they must know') }, required: ['to', 'notes'] },
  },
  {
    name: 'request_help',
    description: 'Ask for help with a problem. Routed to the most relevant available teammate, or to the boss if nobody fits. Set wait to true to wait here for the teammate\'s answer.',
    inputSchema: { type: 'object', properties: { topic: str('What you need help with'), detail: str('What you tried and where you are stuck'), wait: WAIT }, required: ['topic'] },
  },
  {
    name: 'respond_to_request',
    description: 'Respond to a collaboration request another teammate sent you. If they are waiting for your answer, this is what lets them go on.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: str('The request id'),
        action: { type: 'string', enum: ['incorporated', 'new_task', 'needs_decision', 'dependency', 'declined'], description: 'incorporated: you will do it as part of your current task. new_task: it should be a separate task. needs_decision: the boss must prioritise. dependency: it depends on other work. declined: not applicable.' },
        note: str('Explanation, including contract details if you incorporated it'),
      },
      required: ['request_id', 'action', 'note'],
    },
  },
  {
    name: 'wait_for_colleague',
    description:
      'Wait for a teammate: for their answer to a request you sent (request_id), or until a task is finished (task, e.g. "T-12"). Returns at once when the answer is already there or the task has already ended. Otherwise it blocks for a few minutes and then says it has not happened yet; call it again to keep waiting (with no arguments it continues the wait you were in). You are told what happened, not just "done": the answer, or whether the task is DONE or BLOCKED and why. Use it only when you cannot go on without it.',
    inputSchema: { type: 'object', properties: { request_id: str('Id of a request you sent with request_collaboration or request_help'), task: str('Key of the task to wait for, e.g. "T-12"') } },
  },
  {
    name: 'check_messages',
    description: 'Read messages and requests waiting for you.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_goal',
    description:
      'Set yourself a goal, like Claude Code\'s /goal: a condition you then keep working toward, turn after turn, until it holds — each time your turn ends while it does not, the office sends you on. Use it for work that takes many steps you can take on your own ("all tests in packages/api pass and the branch is pushed"). When it holds, call goal_met. It replaces a goal you set before, not one a person gave you.',
    inputSchema: {
      type: 'object',
      properties: { condition: str('What has to be true when you are done, so that anybody could check it') },
      required: ['condition'],
    },
  },
  {
    name: 'goal_met',
    description: 'Say that your goal holds, with how you know. Where a person gave a command to check it by, the office runs it, and only a pass ends the goal.',
    inputSchema: {
      type: 'object',
      properties: { evidence: str('How you know: what you ran and what it showed, what you looked at') },
      required: ['evidence'],
    },
  },
  {
    name: 'set_model',
    description:
      'Choose what you, or a teammate, think with: the model (fable — the strongest and dearest, opus, sonnet, haiku — the lightest; or "default") and the effort (low, medium, high, xhigh, max; or "default"). Use it to spend the Claude allowance where it pays: a lighter model or less effort for routine work, the strongest only where the work needs it. Say why in "reason" — it is on the record and the teammate reads it. A change starts that person\'s session again with the same conversation, at the end of their turn (yours: when this turn ends). get_team shows what everybody thinks with.',
    inputSchema: {
      type: 'object',
      properties: {
        employee: str('Whose: a teammate\'s name; leave out for yourself'),
        model: str('fable, opus, sonnet, haiku, or default (whatever their Claude account uses)'),
        effort: str('low, medium, high, xhigh, max, or default'),
        reason: str('Why — what the work needs, in a sentence'),
      },
      required: ['reason'],
    },
  },
  {
    name: 'get_team',
    description: 'List your teammates, their roles and what they are doing right now.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_available_tasks',
    description: 'List tasks in your project that are ready and not assigned to anyone.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'claim_task',
    description: 'Claim an unassigned READY task (only allowed when the project permits self-assignment and you have no task in progress).',
    inputSchema: { type: 'object', properties: { task: str('Task key, e.g. "T-7"') }, required: ['task'] },
  },
  {
    name: 'propose_tasks',
    description:
      'Propose a breakdown of work as concrete tasks with dependencies. Used for planning, and for putting something you found on the task board. Tasks become real items on the project board (released automatically or after the boss approves, depending on project policy).',
    inputSchema: {
      type: 'object',
      properties: {
        rationale: str('Why the work is split this way'),
        tasks: {
          type: 'array',
          description: 'Tasks in dependency order',
          items: {
            type: 'object',
            properties: {
              title: str('Short imperative title'),
              description: str('What to do'),
              acceptance: str('Verifiable acceptance criteria'),
              kind: { type: 'string', enum: ['feature', 'bug', 'test', 'review', 'research', 'planning', 'security', 'docs', 'ops', 'refactor', 'chore'] },
              assignee: str('The colleague this task is for, by name (see get_team) — also one who works on another project of the office. Leave out to let it go to whoever suits it and is free'),
              role: str('Role best suited, when no assignee is named: backend, frontend, fullstack, qa, security, devops, database, docs, architect, reviewer …'),
              priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
              depends_on: { type: 'array', items: { type: 'integer' }, description: 'Zero-based indexes of earlier tasks in this list that must be done first' },
              dedupe_key: str('For an item found by a check you repeat (a support ticket, an alert): what identifies the item itself, e.g. its id or URL. If the project already has a task with this key, nothing is added. Tasks with a key always wait for the boss to release them.'),
            },
            required: ['title', 'description'],
          },
        },
      },
      required: ['tasks'],
    },
  },
  {
    name: 'record_lesson',
    description:
      'Record a reusable lesson you learned from real work here (a mistake you fixed, review feedback, a correction or decision by the boss). It goes into your playbook and is given back to you on future tasks. A good lesson has four parts: the rule as an instruction ("Run the project\'s verification command before calling complete_task, not only the test file I changed"), the concrete trigger ("before calling complete_task on a task with a verification command"), the evidence ("verification failed twice on T-12 because only the changed test file was run") and its scope. A lesson that does not say what to do or when ("be more careful", "always") is refused with what is missing. When asked to reflect and there is nothing worth keeping, call with none=true and a reason.',
    inputSchema: {
      type: 'object',
      properties: {
        lesson: str('The rule, as an instruction to your future self: what to do, and to what. E.g. "Run the full test script before complete_task, not just the file you changed"'),
        applies_when: str('The concrete trigger: a kind of file, a kind of task, a tool or a moment. E.g. "when editing *.sql migrations", "on bug tasks that touch the API", "before calling complete_task"'),
        why: str('The evidence, in one sentence: what happened that taught you this'),
        scope: { type: 'string', enum: ['self', 'project', 'company'], description: 'self = your own playbook (default); project = propose as knowledge for everyone on this project; company = propose for every project' },
        none: { type: 'boolean', description: 'Set true if there is no lesson worth recording (give a reason)' },
        reason: str('With none=true: why there is nothing to learn, in one sentence'),
        replaces: str('Id of a lesson of your own playbook that this one replaces, when you were told an earlier lesson did not prevent a repeat'),
      },
    },
  },
  {
    name: 'get_context',
    description:
      "The office's central context: what everybody here is to know. Most of it is already in front of you (it was given to you when your session started, and again after every compaction); use this for a fact you do not see — give a few words of what you need (\"deploy shop\", \"client invoices\"). With no topic: the facts kept on demand.",
    inputSchema: { type: 'object', properties: { topic: { type: 'string', description: 'A few words of what you need.' } } },
  },
  {
    name: 'propose_context',
    description:
      'Propose a fact for the central context — something everybody concerned should know from now on and not have to be told again: how something is done here, a decision, where something is, what a client wants. Short and standing on its own. layer: "self" (your own notes: what you are in the middle of — goes in at once), "project" (your project\'s state or how it works — goes in at once), "office", "role" or "client" (wait for a person). Never put a credential in it: name the vault entry.',
    inputSchema: {
      type: 'object',
      properties: {
        layer: { type: 'string', enum: ['self', 'project', 'office', 'role', 'client'] },
        title: { type: 'string', description: 'A few words: what it is.' },
        text: { type: 'string', description: 'The fact, short.' },
        project: { type: 'string', description: 'For layer "project": which project, when not your own.' },
      },
      required: ['layer', 'title', 'text'],
    },
  },
  {
    name: 'get_playbook',
    description: 'Read the lessons in your playbook and the shared team knowledge that applies to you.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'meeting_contribute',
    description: 'Submit your contribution to a meeting you were invited to (your proposal in the first round, your response to others in the second).',
    inputSchema: {
      type: 'object',
      properties: { meeting_id: str('Meeting id'), body: str('Your contribution (markdown)'), disagreements: { type: 'array', items: { type: 'string' }, description: 'Specific points where you disagree with other proposals' } },
      required: ['meeting_id', 'body'],
    },
  },
  {
    name: 'meeting_conclude',
    description: 'As facilitator, conclude a meeting with a decision document and follow-up tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        meeting_id: str('Meeting id'),
        decision_doc: str('Markdown decision document: context, options considered, decision, unresolved disagreements'),
        tasks: {
          type: 'array',
          description: 'Actionable follow-up tasks',
          items: {
            type: 'object',
            properties: { title: str('Title'), description: str('What to do'), acceptance: str('Acceptance criteria'), kind: str('Task kind'), role: str('Suggested role'), priority: str('Priority'), depends_on: { type: 'array', items: { type: 'integer' } } },
            required: ['title', 'description'],
          },
        },
        lessons: { type: 'array', items: { type: 'string' }, description: 'Lessons the team agreed on that should become shared project knowledge' },
      },
      required: ['meeting_id', 'decision_doc'],
    },
  },
];

export type OrchestratorToolName = (typeof ORCHESTRATOR_TOOLS)[number]['name'];

/**
 * Tools with which any employee keeps the task board moving without the owner (shown, and answered, only while
 * the office setting "Employees manage the task board themselves" is on). None of them approves a permission
 * request, marks work done without verification, or deletes anything.
 */
export const BOARD_TOOLS: McpToolSpec[] = [
  {
    name: 'get_task',
    description: 'Look at any task you can see, not only your own: status, who has it, what it is blocked on, its review, its description and dependencies.',
    inputSchema: { type: 'object', properties: { task: str('Task key, e.g. "T-7"') }, required: ['task'] },
  },
  {
    name: 'release_task',
    description: 'Release a task that is waiting in the backlog so that it is scheduled (it starts when its dependencies are done and someone suitable is free). Use it when the work is clearly wanted and nothing is left to decide; ask the boss when it is a matter of direction or priority.',
    inputSchema: { type: 'object', properties: { task: str('Task key, e.g. "T-7"') }, required: ['task'] },
  },
  {
    name: 'unblock_task',
    description: 'Put a BLOCKED task back to work when you know how its blocker is resolved — yours or a teammate\'s. Say how in "note": whoever picks it up reads that. Not for something the boss blocked, and not for what only the boss can decide.',
    inputSchema: { type: 'object', properties: { task: str('Task key, e.g. "T-7"'), note: str('How the blocker is resolved, in full: what was found, decided or fixed') }, required: ['task', 'note'] },
  },
  {
    name: 'give_task',
    description: 'Give a task to whoever fits it best — a teammate, or yourself (your own name). It is handed to them as soon as they are free. Not for a task somebody is in the middle of.',
    inputSchema: { type: 'object', properties: { task: str('Task key, e.g. "T-7"'), employee: str('Employee name') }, required: ['task', 'employee'] },
  },
  {
    name: 'cancel_task',
    description: 'Cancel a task that is no longer wanted — a duplicate, overtaken by other work, or not worth doing. It is closed, not deleted: it stays on the board as cancelled with your reason, and the boss is told and can reopen it. Your own task, or one nobody is in the middle of; not one in review, not one the boss blocked, not a person\'s. When it is a matter of direction or priority, ask the boss instead.',
    inputSchema: { type: 'object', properties: { task: str('Task key, e.g. "T-7"'), reason: str('Why it is no longer wanted, in full: the boss reads this') }, required: ['task', 'reason'] },
  },
  {
    name: 'wake_colleague',
    description: 'Start the session of a teammate who is not at their desk (asleep, or never started) because they are needed now. Say what for: it is delivered to them as your message when they are up. Not needed for someone who is at work; not possible for someone the owner paused.',
    inputSchema: { type: 'object', properties: { employee: str('Employee name'), reason: str('What they are needed for — they read this first') }, required: ['employee', 'reason'] },
  },
];

/**
 * The vault, for employees: what is in it (names, never values) and putting a credential in. Taking a value out
 * is not a tool the model is shown — it is done by a command, through the helper in the session
 * (`$("$ORCH_VAULT" get name)`), so that the value goes into the command and not into the conversation.
 * `vault_read` is that helper's own call.
 */
export const VAULT_TOOLS: McpToolSpec[] = [
  {
    name: 'vault_list',
    description: 'What the office\'s vault holds: each credential\'s name, what it is for, the login it goes with — never a value. To use one in a command write $("$ORCH_VAULT" get NAME) where the value is needed.',
    inputSchema: { type: 'object', properties: { query: str('Optional: part of a name, a service or a login') } },
  },
  {
    name: 'vault_store',
    description: 'Put a credential you were given, found or created into the office\'s vault, so that it is kept and your colleagues can use it. Name it for what it opens: <service>-<account or environment>-<kind>, e.g. "github-deploy-token", "shop-db-admin-password". Afterwards refer to it by name ({{vault:NAME}}), never by its value. (To store something a command produced without it passing through you: … | "$ORCH_VAULT" put NAME.)',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('A short name in lower case with dashes that says what it opens'),
        value: str('The credential itself'),
        kind: { type: 'string', enum: ['password', 'api_key', 'token', 'ssh_key', 'other'] },
        service: str('The site, host or product it is for'),
        username: str('The login it goes with, if any'),
        description: str('A few words: what it is for'),
      },
      required: ['name', 'value'],
    },
  },
  {
    name: 'vault_read',
    description: 'The helper\'s own call. Use $("$ORCH_VAULT" get NAME) in a command instead.',
    inputSchema: { type: 'object', properties: { name: str('The credential\'s name') }, required: ['name'] },
  },
];

/**
 * Files on tasks, for employees: leaving something to look at as evidence of the work.
 * (What people attach to a task is copied to the employee's machine and named in the task; it needs no tool.)
 */
export const FILE_TOOLS: McpToolSpec[] = [
  {
    name: 'attach_file',
    description:
      'Give a file from this machine to the boss: a screenshot of the page or screen you built or changed, a mock-up, a rendered report or PDF, a log, an export. A picture is SHOWN to them (they click to enlarge it), and so is a page — an .html or .svg file opens as the page it is (scripts, styles and pictures inline or from the web work; it cannot reach the office), so a report, payment slips or a mock-up made as one HTML file is the easiest thing for them to look at; text files they read in the window; anything else they download. While you are on a task the file is left on that task as evidence — do it before complete_task whenever the work has something to look at — and is shown in your conversation with the boss too. With no task in progress it goes into your conversation with the boss: use it whenever they ask to see something ("show me", "send me the file"). Never answer with only a path: nobody but you can open a path on your machine. Give the file\'s path (absolute, or relative to your working folder) and a few words saying what it shows. At most 100 MB a file.',
    inputSchema: {
      type: 'object',
      properties: { path: str('Path of the file on this machine'), caption: str('What it shows, in a few words'), task: str('Task key, e.g. "T-7". Default: your current task') },
      required: ['path'],
    },
  },
];

/**
 * The office's long memory, for employees (shown only where the office has one: MemPalace on its own machine).
 */
export const MEMORY_TOOLS: McpToolSpec[] = [
  {
    name: 'recall',
    description: 'Ask the office\'s long memory a question in plain words: earlier tasks and how they went, answers the boss gave, blockers and what resolved them, lessons, meeting decisions, colleagues\' notes. It finds by meaning, in any language. Use it before starting something that may have been done, decided or tried here before. What comes back may be out of date: check before relying on it.',
    inputSchema: { type: 'object', properties: { query: str('What you want to know, as a question or a few words') }, required: ['query'] },
  },
  {
    name: 'remember',
    description: 'Write down, for whoever works here later, something that should outlive this session: a decision and its reason, how something in this project really works, what was tried and dropped and why. Not a log of what you did (finished tasks are remembered by themselves), and never a credential (those go to the vault).',
    inputSchema: { type: 'object', properties: { about: str('A few words: the subject'), note: str('The note itself, complete enough to be understood without this conversation') }, required: ['note'] },
  },
];

/**
 * Tools only a member's team lead may use (the handlers refuse anyone else, and nobody else is shown them). They reach
 * that member's team and no further; the descriptions are short because a lead reads them on every turn.
 */
export const LEAD_TOOLS: McpToolSpec[] = [
  {
    name: 'team_overview',
    description: 'Team lead only. Your team at a glance: each person, their project and folder, what they are doing, what they did lately; the projects you can put work on; how many more you may hire. Call it first.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'team_look',
    description: 'Team lead only. One person on your team in detail: their task, what they were told and answered lately, and their terminal now. Use it when the overview does not tell you whether something is theirs.',
    inputSchema: { type: 'object', properties: { employee: str('Employee name') }, required: ['employee'] },
  },
  {
    name: 'team_tell',
    description: 'Team lead only. Hand something to one person on your team in words: a question to look into, something to check, what to do next. They see only this message, so say it in full, and say that it comes from your boss.',
    inputSchema: { type: 'object', properties: { employee: str('Employee name'), message: str('What they should do, in full') }, required: ['employee', 'message'] },
  },
  {
    name: 'team_task',
    description: 'Team lead only. Put a task on the board of one of your projects, optionally given to someone. For work that should be tracked and checked when done; for a quick look or a question use team_tell.',
    inputSchema: {
      type: 'object',
      properties: {
        project: str('Project name'),
        title: str('Short imperative title'),
        description: str('What to do'),
        acceptance: str('How one sees it is done'),
        assignee: str('Employee name (optional)'),
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        kind: { type: 'string', enum: ['feature', 'bug', 'test', 'research', 'planning', 'security', 'docs', 'ops', 'refactor', 'chore'] },
      },
      required: ['project', 'title', 'description'],
    },
  },
  {
    name: 'team_assign',
    description: 'Team lead only. Give a task that is already on one of your boards to someone on your team.',
    inputSchema: { type: 'object', properties: { task: str('Task key, e.g. "T-7"'), employee: str('Employee name') }, required: ['task', 'employee'] },
  },
  {
    name: 'team_folders',
    description: "Team lead only. The folders on one of your boss's machines (which are git repositories, which have a CLAUDE.md): to find where a project lives before hiring someone into it. Without a path: where the machine lets the office in.",
    inputSchema: { type: 'object', properties: { machine: str("Machine name (optional: yours)"), path: str('Folder to look into (optional)') } },
  },
  {
    name: 'team_hire',
    description: "Team lead only. Hire someone onto one of your boss's own machines when nobody on the team fits the work. At most 5 people hired by you at a time. Your boss is told. Never hire on a guess: know the folder or project first (team_folders), or ask your boss.",
    inputSchema: {
      type: 'object',
      properties: {
        name: str('Their name'),
        role: str('Role key, e.g. backend, frontend, fullstack, qa, devops, docs, researcher'),
        project: str('One of your projects (or give a folder)'),
        folder: str('A folder on the machine: it becomes their project'),
        machine: str('Machine name (optional: yours)'),
        executionMode: { type: 'string', enum: ['interactive_cli', 'managed_sdk', 'codex_managed'], description: 'Worker runtime (optional: interactive_cli). Choose a managed runtime when asked and the machine supports it.' },
        instructions: str('Standing instructions for them (optional)'),
        why: str('One line for your boss: what you need them for'),
      },
      required: ['name', 'role', 'why'],
    },
  },
];

