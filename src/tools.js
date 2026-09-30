/**
 * MCP tool catalog. Every tool is a thin, well-described wrapper around the
 * upstream local agent service.
 */
import { UpstreamError } from './upstream.js';

const TERMINAL_STATES = new Set(['done', 'failed', 'stopped']);

/** Values `POST /api/v1/jobs` accepts; anything else is a 400 from the service. */
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];
export const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Job fields forwarded verbatim to `POST /api/v1/jobs`. */
export const DISPATCH_FIELDS = ['cwd', 'agent', 'permissionMode', 'effort', 'model', 'name'];

/**
 * Where a job is from a waiting caller's point of view.
 *
 *   finished  settled (done/failed/stopped and the model is no longer active)
 *   blocked   waiting for input, e.g. a question or a permission prompt
 *   running   anything else
 *
 * `settled` is authoritative when the service reports it; older services only
 * report `state`.
 */
export function jobPhase(job) {
  if (!job) return 'running';
  if (typeof job.settled === 'boolean') {
    if (job.settled) return 'finished';
  } else if (TERMINAL_STATES.has(job.state)) {
    return 'finished';
  }
  return job.state === 'blocked' ? 'blocked' : 'running';
}

export const TOOLS = [
  {
    name: 'agent_health',
    scope: 'agent:read',
    description:
      'Check whether the local WorkBuddy/CodeBuddy agent service is reachable, whether the gateway password ' +
      'is accepted, and whether the agent is signed in to an account. Call this first when an agent run ' +
      'produces no output.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_args, { upstream, supervisor }) => {
      const health = await upstream.health();
      const status = supervisor ? await supervisor.status() : null;
      const out = {
        ...health,
        credentialAccepted: status?.credentials?.authenticated ?? null,
        signedIn: status?.account?.signedIn ?? null,
        userName: status?.account?.userName ?? null
      };
      if (status?.account && status.account.signedIn === false) {
        out.warning =
          'The agent is not signed in to a CodeBuddy account. Jobs will be accepted but never leave the ' +
          '"starting..." state, because the model call cannot be made. Sign in to CodeBuddy Code, or set ' +
          'CODEBUDDY_API_KEY and start the gateway with --spawn-upstream.';
      }
      return out;
    }
  },
  {
    name: 'agent_info',
    scope: 'agent:read',
    description:
      'Return environment information about the agent host: product version, OS, architecture, ' +
      'current working directory and uptime.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (_args, { upstream }) => upstream.info()
  },
  {
    name: 'agent_run',
    scope: 'agent:run',
    description:
      'Run a prompt on the local coding agent and return its answer. ' +
      'By default this waits for the run to finish (up to `timeoutSeconds`) and returns the final text. ' +
      'Set wait=false to get a job id back immediately and poll it with agent_job_status.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The instruction for the agent.' },
        cwd: { type: 'string', description: 'Working directory for the run. Defaults to the agent process CWD.' },
        agent: {
          type: 'string',
          description: 'Agent mode to use, e.g. "cli" (default), "ptc", "minimal", or a custom agent name.'
        },
        permissionMode: {
          type: 'string',
          enum: PERMISSION_MODES,
          description:
            'Permission mode for the run. Omit to use the service default. "minimal" agents cannot use "plan".'
        },
        effort: { type: 'string', enum: EFFORTS, description: 'Thinking effort for the run.' },
        model: { type: 'string', description: 'Optional model override.' },
        name: { type: 'string', description: 'Optional human-friendly job name.' },
        wait: { type: 'boolean', description: 'Wait for completion. Default true.' },
        timeoutSeconds: {
          type: 'number',
          description: 'Maximum seconds to wait when wait=true. Default 300, maximum 1800.'
        }
      },
      required: ['prompt'],
      additionalProperties: false
    },
    handler: async (args, { upstream }) => {
      const payload = { prompt: args.prompt };
      for (const key of DISPATCH_FIELDS) {
        if (args[key] !== undefined) payload[key] = args[key];
      }
      const job = await upstream.dispatchJob(payload);
      const jobId = job?.id || job?.shortId;
      if (!jobId) return { dispatched: true, job };

      if (args.wait === false) {
        return { jobId, sessionId: job.sessionId, state: job.state, waited: false, job };
      }

      const timeoutMs = Math.min(Math.max(Number(args.timeoutSeconds) || 300, 5), 1800) * 1000;
      const settled = await waitForJob(upstream, jobId, timeoutMs);
      const result = {
        jobId,
        sessionId: settled.job?.sessionId ?? job.sessionId,
        state: settled.job?.state ?? 'unknown',
        waited: true,
        timedOut: settled.timedOut,
        answer: settled.answer
      };
      if (settled.phase === 'blocked') {
        result.needsReply = true;
        result.detail =
          settled.job?.detail ??
          'The agent is waiting for input. Answer with agent_job_reply, or stop it with agent_job_stop.';
      }
      if (settled.job?.state === 'failed') {
        result.detail = settled.job?.detail ?? settled.job?.error ?? 'The agent run reported a failure state.';
      }
      return result;
    }
  },
  {
    name: 'agent_job_status',
    scope: 'agent:read',
    description:
      'Get the current status of an agent job by id, including its lifecycle state ' +
      '(working / blocked / done / failed / stopped) and the transcript collected so far.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'Job id (stable id, short id, or session id).' },
        includeTranscript: { type: 'boolean', description: 'Include the replayed transcript. Default true.' }
      },
      required: ['jobId'],
      additionalProperties: false
    },
    handler: async (args, { upstream }) => {
      const job = await upstream.getJob(args.jobId);
      const out = { job };
      if (args.includeTranscript !== false) {
        try {
          const t = await upstream.jobTranscript(args.jobId);
          out.transcript = t?.updates ?? [];
          out.answer = extractAnswer(t?.updates ?? []);
        } catch {
          /* transcript is best-effort */
        }
      }
      return out;
    }
  },
  {
    name: 'agent_job_stop',
    scope: 'agent:run',
    description: 'Stop a running agent job.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string', description: 'Job id to stop.' } },
      required: ['jobId'],
      additionalProperties: false
    },
    handler: (args, { upstream }) => upstream.stopJob(args.jobId)
  },
  {
    name: 'agent_job_reply',
    scope: 'agent:run',
    description:
      'Send a follow-up message to an agent job that is waiting for input (state "blocked", ' +
      'or agent_run returned needsReply). Follow it with agent_job_status.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'Job id to reply to.' },
        message: { type: 'string', description: 'The reply text.' }
      },
      required: ['jobId', 'message'],
      additionalProperties: false
    },
    handler: (args, { upstream }) => upstream.replyJob(args.jobId, args.message)
  },
  {
    name: 'agent_jobs_list',
    scope: 'agent:read',
    description: 'List background agent jobs known to the local service.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Filter by working directory.' },
        all: { type: 'boolean', description: 'Include jobs from every project.' }
      },
      additionalProperties: false
    },
    handler: (args, { upstream }) => upstream.listJobs({ cwd: args.cwd, all: args.all })
  },
  {
    name: 'agent_sessions_list',
    scope: 'agent:read',
    description: 'List recent agent conversation sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Filter by working directory.' },
        limit: { type: 'number', description: 'Maximum number of sessions to return.' }
      },
      additionalProperties: false
    },
    handler: (args, { upstream }) => upstream.listSessions({ cwd: args.cwd, limit: args.limit })
  },
  {
    name: 'agent_workers_list',
    scope: 'agent:read',
    description:
      'List running agent worker processes (interactive sessions, background jobs and daemons) ' +
      'together with the endpoint each one is serving.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (_args, { upstream }) => upstream.listWorkers()
  },
  {
    name: 'agent_worker_logs',
    scope: 'agent:read',
    description:
      'Read logs for a worker process. type may be telemetry, process, debug or transcript; ' +
      'tail limits the number of lines returned.',
    inputSchema: {
      type: 'object',
      properties: {
        workerId: { type: 'string', description: 'Worker pid or name.' },
        type: { type: 'string', description: 'Log source: telemetry | process | debug | transcript.' },
        tail: { type: 'number', description: 'Return only the last N lines.' }
      },
      required: ['workerId'],
      additionalProperties: false
    },
    handler: (args, { upstream }) => upstream.workersLogs(args.workerId, { type: args.type, tail: args.tail })
  },
  {
    name: 'agent_dispatch_context',
    scope: 'agent:read',
    description:
      'Return the context used when dispatching new agent work: default working directory, ' +
      'available agent modes and the default permission mode.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (_args, { upstream }) => upstream.dispatchContext()
  }
];

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function toolDescriptorsForScopes(scopes) {
  return TOOLS.filter((t) => scopes.includes(t.scope)).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema
  }));
}

/** Poll a job until it settles, blocks on input, or the timeout elapses. */
export async function waitForJob(upstream, jobId, timeoutMs, pollMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  let job = null;
  let phase = 'running';
  while (Date.now() < deadline) {
    try {
      job = await upstream.getJob(jobId);
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 404) {
        return { job: null, phase: 'finished', timedOut: false, answer: null };
      }
      throw err;
    }
    phase = jobPhase(job);
    if (phase !== 'running') break;
    await sleep(pollMs);
  }
  let answer = null;
  try {
    const t = await upstream.jobTranscript(jobId);
    answer = extractAnswer(t?.updates ?? []);
  } catch {
    /* best effort */
  }
  return { job, phase, timedOut: phase === 'running', answer };
}

/** ACP updates that separate one assistant message from the next. */
const MESSAGE_BREAKS = new Set(['tool_call', 'tool_call_update', 'user_message_chunk', 'user_message']);

function textOf(content) {
  if (typeof content === 'string') return content;
  if (content?.type === 'text' && typeof content.text === 'string') return content.text;
  if (Array.isArray(content)) return content.map(textOf).join('');
  return '';
}

/**
 * Pull assistant text out of ACP replay updates.
 *
 * `agent_message_chunk`s are fragments of one message and are concatenated;
 * separate messages (split by a tool call or a user turn) are joined with a
 * blank line. The result only ever grows as the transcript grows, which the
 * streaming bridge relies on.
 */
export function extractAnswer(updates) {
  if (!Array.isArray(updates)) return null;
  const messages = [];
  let current = '';
  for (const u of updates) {
    if (!u || typeof u !== 'object') continue;
    const kind = u.sessionUpdate || u.type;
    if (kind === 'agent_message_chunk' || kind === 'agent_message') {
      current += textOf(u.content);
    } else if (MESSAGE_BREAKS.has(kind)) {
      if (current.trim()) messages.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) messages.push(current.trim());
  return messages.length ? messages.join('\n\n') : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
