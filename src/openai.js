/**
 * OpenAI-compatible surface.
 *
 * Many agents, IDE plugins and scripts speak the OpenAI Chat Completions API
 * rather than MCP. This module translates that wire format onto the local
 * WorkBuddy / CodeBuddy agent so those clients can use it unchanged:
 *
 *   GET  /v1/models
 *   GET  /v1/models/:id
 *   GET  /v1/tools                the gateway's own tool catalog, in OpenAI schema form
 *   POST /v1/chat/completions     buffered and streamed, with optional function calling
 *   POST /v1/completions          legacy text completions
 *
 * Translation notes
 * -----------------
 * The upstream agent is asynchronous: POST /api/v1/jobs returns a job id and the
 * answer accumulates in the job transcript. We bridge that to a synchronous (or
 * SSE-streamed) HTTP response by polling the transcript and emitting the delta
 * as it grows.
 *
 * Function calling
 * ----------------
 * The agent runs its own tool loop, so it cannot natively return a tool call
 * instead of executing one. With `openai.toolsMode = "translate"` the gateway
 * bridges the formats:
 *
 *   OpenAI tools  ->  a tool protocol embedded in the prompt (see buildToolProtocol)
 *   agent reply   ->  parsed back into an OpenAI `tool_calls` response
 *
 * The parser only accepts a call whose name matches one of the declared tools,
 * so an answer that merely contains JSON is still treated as text.
 */
import { DISPATCH_FIELDS, EFFORTS, PERMISSION_MODES, extractAnswer, jobPhase, toolDescriptorsForScopes } from './tools.js';
import { randomId } from './tokens.js';

/** Selectable pseudo-models. Unknown ids fall back to the default agent. */
export const MODELS = [
  {
    id: 'workbuddy',
    agent: 'cli',
    owned_by: 'workbuddy',
    description: 'Default WorkBuddy agent: full tool access (read, write, bash, MCP, skills).'
  },
  {
    id: 'workbuddy-ptc',
    agent: 'ptc',
    owned_by: 'workbuddy',
    description: 'Programmatic tool calling: composes multi-step work in one script.'
  },
  {
    id: 'workbuddy-minimal',
    agent: 'minimal',
    owned_by: 'workbuddy',
    description: 'Minimal mode: REPL sandbox only, no MCP or file tools.'
  }
];

const MODEL_BY_ID = new Map(MODELS.map((m) => [m.id, m]));
const DEFAULT_MODEL = 'workbuddy';
/** Separator between a pseudo-model and a backend model: `workbuddy:gpt-5.5`. */
const BACKEND_SEPARATOR = ':';
const STREAM_POLL_MS = 700;
const SYNC_POLL_MS = 1200;

/** Envelope key the agent is asked to use when it wants to call a tool. */
const TOOL_CALL_KEY = 'wb_tool_call';

export class OpenAiCompat {
  constructor({ config, upstream, supervisor, log }) {
    this.cfg = config;
    this.upstream = upstream;
    this.supervisor = supervisor;
    this.log = log;
    this.created = Math.floor(Date.now() / 1000);
  }

  /** @returns {boolean} true when the request was handled here. */
  async handle(req, res, url, helpers, auth) {
    const p = url.pathname.replace(/\/+$/, '') || '/';

    if (p === '/v1/models' && req.method === 'GET') {
      helpers.sendJson(res, 200, {
        object: 'list',
        data: this.#modelIds().map((id) => this.#modelObject(id))
      });
      return true;
    }

    const modelMatch = p.match(/^\/v1\/models\/(.+)$/);
    if (modelMatch && req.method === 'GET') {
      helpers.sendJson(res, 200, this.#modelObject(decodeURIComponent(modelMatch[1])));
      return true;
    }

    // The gateway's own MCP tool catalog, rendered as OpenAI function schemas.
    if (p === '/v1/tools' && req.method === 'GET') {
      helpers.sendJson(res, 200, {
        object: 'list',
        data: toOpenAiTools(toolDescriptorsForScopes(auth.scopes)),
        source: 'mcp',
        mcpEndpoint: `${this.cfg.publicUrl}/mcp`
      });
      return true;
    }

    if (p === '/v1/chat/completions' && req.method === 'POST') {
      await this.#chatCompletions(req, res, helpers, auth);
      return true;
    }

    if (p === '/v1/completions' && req.method === 'POST') {
      await this.#textCompletions(req, res, helpers, auth);
      return true;
    }

    return false;
  }

  #backendModels() {
    const list = this.cfg.openai?.backendModels;
    return Array.isArray(list) ? list.filter((m) => typeof m === 'string' && m) : [];
  }

  #modelIds() {
    const backends = this.#backendModels();
    return [
      ...MODELS.map((m) => m.id),
      ...MODELS.flatMap((m) => backends.map((b) => `${m.id}${BACKEND_SEPARATOR}${b}`))
    ];
  }

  /** Split `workbuddy:gpt-5.5` into its pseudo-model and a configured backend model. */
  #resolveModel(requested) {
    const i = requested.indexOf(BACKEND_SEPARATOR);
    if (i > 0) {
      const base = MODEL_BY_ID.get(requested.slice(0, i));
      const backend = requested.slice(i + 1);
      if (base && this.#backendModels().includes(backend)) return { known: base, backend };
    }
    return { known: MODEL_BY_ID.get(requested), backend: undefined };
  }

  #modelObject(id) {
    return { id, object: 'model', created: this.created, owned_by: 'workbuddy' };
  }

  // ------------------------------------------------------------- completions

  async #chatCompletions(req, res, helpers, auth) {
    const body = await helpers.readBody(req);
    if (!body || typeof body !== 'object') {
      return openAiError(res, 400, 'Invalid request body', 'invalid_request_error', 'invalid_body');
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return openAiError(
        res,
        400,
        "'messages' is required and must be a non-empty array",
        'invalid_request_error',
        'missing_messages'
      );
    }

    const plan = this.#plan(body, auth);
    if (plan.error) return openAiError(res, plan.status, plan.error, plan.type, plan.code);

    if (body.stream === true) await this.#streamChat(req, res, body, plan);
    else await this.#syncChat(req, res, body, plan);
  }

  async #textCompletions(req, res, helpers, auth) {
    const body = await helpers.readBody(req);
    const prompt = typeof body?.prompt === 'string' ? body.prompt : Array.isArray(body?.prompt) ? body.prompt.join('\n') : null;
    if (!prompt) {
      return openAiError(res, 400, "'prompt' is required", 'invalid_request_error', 'missing_prompt');
    }
    const plan = this.#plan({ ...body, messages: [{ role: 'user', content: prompt }] }, auth);
    if (plan.error) return openAiError(res, plan.status, plan.error, plan.type, plan.code);

    try {
      const run = await this.#runAgent(plan, { pollMs: SYNC_POLL_MS, signal: disconnectSignal(res) });
      if (run.aborted) return;
      const outcome = runOutcome(run);
      if (outcome.error) {
        return openAiError(res, outcome.error.status, outcome.error.message, 'upstream_error', outcome.error.code);
      }
      helpers.sendJson(res, 200, {
        id: `cmpl-${run.jobId}`,
        object: 'text_completion',
        created: Math.floor(Date.now() / 1000),
        model: plan.model,
        choices: [{ index: 0, text: outcome.content, logprobs: null, finish_reason: outcome.finishReason }],
        usage: estimateUsage(plan.prompt, outcome.content)
      });
    } catch (err) {
      this.#reportUpstreamError(res, err);
    }
  }

  // ------------------------------------------------------------------ planning

  /** Turn an OpenAI request into an agent dispatch plan. */
  #plan(body, auth) {
    if (!auth.scopes.includes('agent:run')) {
      return {
        error: `This token has scopes [${auth.scopes.join(', ')}] but chat completions require "agent:run".`,
        status: 403,
        type: 'permission_error',
        code: 'insufficient_scope'
      };
    }

    const mode = this.cfg.openai.toolsMode;
    const ext = body.workbuddy && typeof body.workbuddy === 'object' ? body.workbuddy : {};
    const requested = String(body.model || DEFAULT_MODEL);
    const { known, backend } = this.#resolveModel(requested);

    const declaredTools = normalizeTools(body.tools);
    const toolChoice = body.tool_choice;

    if (declaredTools.length > 0 && mode === 'reject') {
      const names = declaredTools.map((t) => t.function.name);
      return {
        error:
          `This endpoint was configured with openai.toolsMode="reject" because the WorkBuddy agent runs its ` +
          `own tool loop. The request declared tools (${names.join(', ')}). Either drop "tools" and let the ` +
          `agent act autonomously, set openai.toolsMode="translate" to bridge the formats, or use the MCP ` +
          `endpoint at /mcp, which exposes the agent as explicit tools.`,
        status: 400,
        type: 'invalid_request_error',
        code: 'tools_not_supported'
      };
    }

    const toolsActive = mode === 'translate' && declaredTools.length > 0 && toolChoice !== 'none';

    const forced = typeof toolChoice === 'object' ? toolChoice?.function?.name : null;
    if (toolsActive && forced && !declaredTools.some((t) => t.function.name === forced)) {
      return badRequest(`tool_choice names "${forced}", which is not one of the declared tools.`, 'tool_choice');
    }

    const agent = ext.agent || known?.agent || MODEL_BY_ID.get(DEFAULT_MODEL).agent;
    // `reasoning_effort` is standard OpenAI; values the agent has no equivalent
    // for are ignored like temperature. The explicit extension is validated.
    const effort = ext.effort ?? (EFFORTS.includes(body.reasoning_effort) ? body.reasoning_effort : undefined);
    if (effort !== undefined && !EFFORTS.includes(effort)) {
      return badRequest(`workbuddy.effort must be one of ${EFFORTS.join(', ')}.`, 'workbuddy.effort');
    }
    if (ext.permissionMode !== undefined && !PERMISSION_MODES.includes(ext.permissionMode)) {
      return badRequest(
        `workbuddy.permissionMode must be one of ${PERMISSION_MODES.join(', ')}.`,
        'workbuddy.permissionMode'
      );
    }
    const permissionMode = ext.permissionMode ?? this.cfg.openai.permissionMode;
    if (agent === 'minimal' && permissionMode === 'plan') {
      return badRequest('The minimal agent cannot run with permissionMode "plan".', 'workbuddy.permissionMode');
    }

    return {
      model: requested,
      dispatch: {
        cwd: ext.cwd,
        agent,
        permissionMode,
        effort,
        model: ext.model ?? backend,
        name: ext.name
      },
      timeoutSeconds: clamp(Number(ext.timeoutSeconds ?? body.timeoutSeconds ?? 300), 5, 1800),
      tools: declaredTools,
      toolChoice,
      toolsActive,
      toolsIgnored: declaredTools.length > 0 && !toolsActive,
      prompt: toPrompt(body.messages, { agent, declaredTools, toolsActive, toolChoice })
    };
  }

  // --------------------------------------------------------------------- run

  /**
   * Dispatch the job and follow it until it settles.
   * `onDelta` is invoked with the accumulated answer whenever it grows.
   *
   * An OpenAI request is stateless, so a job the caller can no longer reach -
   * timed out, blocked on input, or abandoned by a disconnect - is stopped
   * rather than left running in the background.
   */
  async #runAgent(plan, { pollMs, onDelta, signal } = {}) {
    const payload = { prompt: plan.prompt };
    for (const key of DISPATCH_FIELDS) {
      if (plan.dispatch[key] !== undefined) payload[key] = plan.dispatch[key];
    }

    const job = await this.upstream.dispatchJob(payload);
    const jobId = job?.id || job?.shortId;
    if (!jobId) throw new Error('the agent service did not return a job id');

    const deadline = Date.now() + plan.timeoutSeconds * 1000;
    let answer = null;
    let current = job;
    let phase = jobPhase(job);
    let aborted = false;

    const pull = async () => {
      const next = await this.#readAnswer(jobId);
      if (next && next !== answer) {
        answer = next;
        if (onDelta) onDelta(answer);
      }
    };

    while (phase === 'running' && Date.now() < deadline) {
      if (signal?.aborted) {
        aborted = true;
        break;
      }
      await sleep(pollMs);
      current = (await this.upstream.getJob(jobId).catch(() => null)) ?? current;
      phase = jobPhase(current);
      await pull();
    }

    if (phase !== 'finished') {
      await this.upstream.stopJob(jobId).catch((err) => this.log.warn(`could not stop job ${jobId}: ${err.message}`));
    }
    if (!aborted) await pull();

    return {
      jobId,
      state: current?.state ?? 'unknown',
      phase,
      answer,
      detail: current?.detail ?? null,
      timedOut: phase === 'running' && !aborted,
      aborted
    };
  }

  async #readAnswer(jobId) {
    try {
      const t = await this.upstream.jobTranscript(jobId);
      return extractAnswer(t?.updates ?? []);
    } catch {
      return null; // transcript is best effort while the job runs
    }
  }

  // ------------------------------------------------------------------ outputs

  async #syncChat(req, res, body, plan) {
    try {
      const run = await this.#runAgent(plan, { pollMs: SYNC_POLL_MS, signal: disconnectSignal(res) });
      if (run.aborted) return;
      const outcome = runOutcome(run);
      if (outcome.error) {
        return openAiError(res, outcome.error.status, outcome.error.message, 'upstream_error', outcome.error.code);
      }

      const content = outcome.content;
      const call = plan.toolsActive ? parseToolCall(content, plan.tools) : null;

      const message = call
        ? { role: 'assistant', content: null, tool_calls: [toOpenAiToolCall(call)] }
        : { role: 'assistant', content };

      const choice = {
        index: 0,
        message,
        finish_reason: call ? 'tool_calls' : outcome.finishReason
      };

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'X-WorkBuddy-Job-Id, X-WorkBuddy-Tools-Ignored',
        'X-WorkBuddy-Job-Id': run.jobId,
        ...(plan.toolsIgnored ? { 'X-WorkBuddy-Tools-Ignored': '1' } : {})
      });
      res.end(
        JSON.stringify({
          id: `chatcmpl-${run.jobId}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: plan.model,
          system_fingerprint: 'wb-agent-gateway',
          choices: [choice],
          usage: estimateUsage(plan.prompt, content)
        })
      );
    } catch (err) {
      this.#reportUpstreamError(res, err);
    }
  }

  async #streamChat(req, res, body, plan) {
    const id = `chatcmpl-${Date.now().toString(36)}`;
    const created = Math.floor(Date.now() / 1000);
    const includeUsage = body.stream_options?.include_usage === true;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'X-WorkBuddy-Job-Id, X-WorkBuddy-Tools-Ignored',
      ...(plan.toolsIgnored ? { 'X-WorkBuddy-Tools-Ignored': '1' } : {})
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const send = (payload) => {
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    const chunk = (delta, finishReason = null) => ({
      id,
      object: 'chat.completion.chunk',
      created,
      model: plan.model,
      system_fingerprint: 'wb-agent-gateway',
      choices: [{ index: 0, delta, finish_reason: finishReason }]
    });

    // An agent run can take minutes, and in translate mode nothing is emitted
    // until it finishes. SSE comments keep proxies and clients from dropping an
    // apparently idle stream.
    const keepalive = setInterval(() => {
      if (res.writableEnded) return;
      try {
        res.write(': keepalive\n\n');
      } catch {
        /* connection already gone */
      }
    }, 15_000);
    if (typeof keepalive.unref === 'function') keepalive.unref();

    const finish = () => {
      clearInterval(keepalive);
      if (res.writableEnded) return;
      res.write('data: [DONE]\n\n');
      res.end();
    };

    const controller = new AbortController();
    let clientGone = false;
    // `req` does not emit close once its body is consumed; `res` does on disconnect.
    res.on('close', () => {
      if (!res.writableEnded) clientGone = true;
      clearInterval(keepalive);
      controller.abort();
    });

    // A reply can only be classified as text or tool call once it is complete,
    // so tool bridging buffers instead of streaming partial deltas.
    let emitted = '';
    const onDelta = plan.toolsActive
      ? undefined
      : (full) => {
          const delta = full.slice(emitted.length);
          if (!delta) return;
          emitted = full;
          send(chunk({ content: delta }));
        };

    if (!plan.toolsActive) send(chunk({ role: 'assistant', content: '' }));

    const usageChunk = (completion) => ({
      id,
      object: 'chat.completion.chunk',
      created,
      model: plan.model,
      choices: [],
      usage: estimateUsage(plan.prompt, completion)
    });
    const errorChunk = (message, code) => ({
      id,
      object: 'chat.completion.chunk',
      created,
      model: plan.model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      error: { message, type: 'upstream_error', code }
    });

    try {
      const run = await this.#runAgent(plan, {
        pollMs: STREAM_POLL_MS,
        onDelta,
        signal: controller.signal
      });

      if (clientGone) return;

      const outcome = runOutcome(run);
      if (outcome.error) {
        send(errorChunk(outcome.error.message, outcome.error.code));
        finish();
        return;
      }

      if (plan.toolsActive) {
        const call = parseToolCall(outcome.content, plan.tools);
        if (call) {
          send(chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, ...toOpenAiToolCall(call) }] }));
          send(chunk({}, 'tool_calls'));
          if (includeUsage) send(usageChunk(outcome.content));
          finish();
          return;
        }
        // Not a tool call after all: emit the text in one piece.
        send(chunk({ role: 'assistant', content: outcome.content }));
        emitted = outcome.content;
      }

      send(chunk({}, outcome.finishReason));
      if (includeUsage) send(usageChunk(emitted));
      finish();
    } catch (err) {
      if (clientGone || res.writableEnded) return;
      this.log.warn(`streaming chat completion failed: ${err.message}`);
      send(errorChunk(err.message, err.code || 'upstream_error'));
      finish();
    }
  }

  #reportUpstreamError(res, err) {
    if (res.headersSent) {
      res.end();
      return;
    }
    this.log.warn(`chat completion failed: ${err.message}`);
    // The service validates dispatch fields itself; its 400s are the caller's fault.
    if (err.status === 400) return openAiError(res, 400, err.message, 'invalid_request_error', err.code || 'bad_request');
    const status = err.status === 404 ? 404 : 502;
    openAiError(res, status, err.message, 'upstream_error', err.code || 'upstream_error');
  }
}

/**
 * Map a finished run onto an OpenAI outcome.
 * @returns {{error: {status:number, message:string, code:string}} | {content:string, finishReason:string}}
 */
function runOutcome(run) {
  if (run.state === 'failed') {
    return {
      error: {
        status: 502,
        message: run.detail || 'The agent run failed. Check the gateway log and `agent_health`.',
        code: 'agent_run_failed'
      }
    };
  }
  const content = run.answer ?? '';
  if (run.phase === 'blocked' && !content) {
    return {
      error: {
        status: 409,
        message:
          'The agent stopped to wait for input (usually a permission prompt) and produced no answer, so the job ' +
          'was stopped. Pass workbuddy.permissionMode (e.g. "dontAsk"), set a non-prompting openai.permissionMode ' +
          'on the gateway, or use agent_run over /mcp ' +
          'and answer it with agent_job_reply.' +
          (run.detail ? ` Agent said: ${run.detail}` : ''),
        code: 'agent_needs_input'
      }
    };
  }
  // A question the agent asks is an ordinary answer: the caller replies in the next request.
  return { content, finishReason: run.timedOut ? 'length' : 'stop' };
}

// ------------------------------------------------------------- tool bridging

/** Coerce OpenAI `tools` into a normalized shape. */
export function normalizeTools(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    const fn = entry?.function ?? (entry?.name ? entry : null);
    if (!fn?.name) continue;
    out.push({
      type: 'function',
      function: {
        name: String(fn.name),
        description: fn.description ? String(fn.description) : '',
        parameters:
          fn.parameters && typeof fn.parameters === 'object'
            ? fn.parameters
            : { type: 'object', properties: {} }
      }
    });
  }
  return out;
}

/** Render the gateway's MCP tool descriptors as OpenAI function schemas. */
export function toOpenAiTools(descriptors) {
  return descriptors.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema }
  }));
}

/** The instruction block that teaches the agent to emit a tool call. */
export function buildToolProtocol(tools, toolChoice) {
  const names = tools.map((t) => t.function.name);
  const lines = [
    'You have access to the caller\'s tools listed below.',
    'If you need one, reply with ONLY this JSON object and nothing else:',
    '',
    `{"${TOOL_CALL_KEY}": {"name": "<tool name>", "arguments": { ... }}}`,
    '',
    'No prose, no code fences, exactly one tool call. If no tool is needed, answer normally in plain text.',
    'You cannot execute these tools yourself - the caller will run them and send you the result.',
    '',
    `Available tools: ${names.join(', ')}`,
    '',
    'Tool schemas:',
    JSON.stringify(tools.map((t) => t.function), null, 2)
  ];

  if (typeof toolChoice === 'object' && toolChoice?.function?.name) {
    lines.push('', `You must call "${toolChoice.function.name}" now.`);
  } else if (toolChoice === 'required') {
    lines.push('', 'You must call exactly one of these tools now.');
  }

  return lines.join('\n');
}

/**
 * Parse an agent reply into a tool call.
 *
 * Only accepts a call whose name is one of `tools`, so an answer that merely
 * contains JSON is still treated as text.
 *
 * @returns {{name: string, arguments: object, raw: string} | null}
 */
export function parseToolCall(answer, tools) {
  if (typeof answer !== 'string' || answer.trim() === '') return null;
  const allowed = new Set((tools || []).map((t) => t.function?.name).filter(Boolean));
  if (allowed.size === 0) return null;

  const candidates = jsonCandidates(answer);
  for (const candidate of candidates) {
    const call = extractCall(candidate);
    if (!call) continue;
    if (!allowed.has(call.name)) continue;
    return { ...call, raw: candidate };
  }
  return null;
}

/** Yield JSON objects found in a reply, most specific first. */
function jsonCandidates(text) {
  const out = [];

  // Whole reply, after stripping a code fence.
  const fenced = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  out.push(fenced.trim());

  // Any fenced block in the reply.
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m;
  while ((m = fenceRe.exec(text)) !== null) out.push(m[1].trim());

  // Balanced braces anywhere in the reply.
  for (const block of balancedObjects(text)) out.push(block);

  return [...new Set(out.filter(Boolean))];
}

/** Naive brace matcher that ignores braces inside strings. */
function balancedObjects(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          out.push(text.slice(i, j + 1));
          i = j;
          break;
        }
      }
    }
  }
  return out;
}

/** Normalize the several plausible tool-call shapes into {name, arguments}. */
function extractCall(json) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const node =
    parsed[TOOL_CALL_KEY] ??
    parsed.tool_call ??
    (Array.isArray(parsed.tool_calls) ? parsed.tool_calls[0] : null) ??
    (parsed.name && (parsed.arguments !== undefined || parsed.parameters !== undefined) ? parsed : null) ??
    (parsed.function?.name ? parsed : null);

  if (!node || typeof node !== 'object') return null;

  const fn = node.function && typeof node.function === 'object' ? node.function : node;
  const name = fn.name ?? node.name;
  if (typeof name !== 'string' || name.trim() === '') return null;

  let args = fn.arguments ?? node.arguments ?? fn.parameters ?? node.parameters ?? {};
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      args = { input: args };
    }
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) args = { value: args };

  return { name: name.trim(), arguments: args };
}

function toOpenAiToolCall(call) {
  return {
    id: `call_${randomId(12)}`,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) }
  };
}

// --------------------------------------------------------------------- helpers

/** Flatten OpenAI messages into a single prompt for the agent. */
export function toPrompt(messages, { agent, declaredTools = [], toolsActive = false, toolChoice } = {}) {
  const system = [];
  const turns = [];
  // OpenAI tool results carry `tool_call_id`, not the tool name.
  const toolNameById = new Map();

  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const text = contentToText(m.content);

    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      for (const c of m.tool_calls) if (c?.id) toolNameById.set(c.id, c.function?.name || c.name);
      const rendered = m.tool_calls
        .map((c) => `${c.function?.name || c.name}(${stringifyArgs(c.function?.arguments ?? c.arguments)})`)
        .join(', ');
      turns.push(`Assistant: [requested tool call ${rendered}]${text ? ` ${text}` : ''}`);
      continue;
    }
    if (!text) continue;

    switch (m.role) {
      case 'system':
      case 'developer':
        system.push(text);
        break;
      case 'assistant':
        turns.push(`Assistant: ${text}`);
        break;
      case 'tool':
      case 'function': {
        const name = m.name || toolNameById.get(m.tool_call_id);
        turns.push(`Tool result${name ? ` (${name})` : ''}: ${text}`);
        break;
      }
      default:
        turns.push(`User: ${text}`);
    }
  }

  const isSingleUserTurn =
    turns.length === 1 && turns[0].startsWith('User: ') && system.length === 0 && !toolsActive;
  if (isSingleUserTurn) return turns[0].slice('User: '.length);

  const parts = [];
  if (system.length) parts.push(system.join('\n\n'));
  if (turns.length) {
    parts.push(`Conversation so far:\n\n${turns.join('\n\n')}`);
    const lastIsUser = turns[turns.length - 1].startsWith('User: ');
    parts.push(
      lastIsUser
        ? 'Respond as the assistant to the final user message.'
        : 'Continue the conversation as the assistant.'
    );
  }

  if (toolsActive) {
    parts.push(buildToolProtocol(declaredTools, toolChoice));
  } else if (declaredTools.length > 0) {
    parts.push(
      'The caller declared tools in its request but tool bridging is disabled, so you cannot call them. ' +
        'Use your own tools to gather what you need, then answer in plain text.'
    );
  }

  if (agent === 'minimal') {
    parts.push('You are running in minimal mode: only the sandbox REPL is available.');
  }

  return parts.join('\n\n').trim();
}

function stringifyArgs(args) {
  if (args === undefined || args === null) return '';
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

function contentToText(content) {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text' && typeof part.text === 'string') return part.text;
        if (part?.type === 'image_url') return '[image omitted]';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

/** Rough token estimate; the agent does not report exact counts per turn. */
function estimateUsage(prompt, completion) {
  const p = Math.ceil(String(prompt || '').length / 4);
  const c = Math.ceil(String(completion || '').length / 4);
  return { prompt_tokens: p, completion_tokens: c, total_tokens: p + c };
}

function openAiError(res, status, message, type = 'invalid_request_error', code = null) {
  if (res.headersSent) {
    res.end();
    return;
  }
  const payload = JSON.stringify({ error: { message, type, param: null, code } });
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(payload);
}

const clamp = (n, lo, hi) => Math.min(Math.max(Number.isFinite(n) ? n : lo, lo), hi);

const badRequest = (message, param) => ({
  error: message,
  status: 400,
  type: 'invalid_request_error',
  code: `invalid_${param.replace(/\W+/g, '_')}`
});

/** Aborts when the client goes away before the response is finished. */
function disconnectSignal(res) {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller.signal;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
