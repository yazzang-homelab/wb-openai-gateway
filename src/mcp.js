/**
 * MCP server side: JSON-RPC 2.0 over the Streamable HTTP transport
 * (POST /mcp for requests, GET /mcp for the server->client SSE stream,
 *  DELETE /mcp to terminate a session).
 *
 * Tool visibility is derived from the scopes carried by the caller's access
 * token, so a read-only client literally cannot see agent_run.
 */
import { randomId } from './tokens.js';
import { TOOL_BY_NAME, toolDescriptorsForScopes } from './tools.js';

export const SERVER_NAME = 'wb-agent-gateway';
export const SERVER_VERSION = '1.0.0';

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

const JSONRPC_ERRORS = {
  parse: { code: -32700, message: 'Parse error' },
  invalidRequest: { code: -32600, message: 'Invalid Request' },
  methodNotFound: { code: -32601, message: 'Method not found' },
  invalidParams: { code: -32602, message: 'Invalid params' },
  internal: { code: -32603, message: 'Internal error' }
};

export class McpServer {
  constructor({ config, upstream, supervisor, log }) {
    this.cfg = config;
    this.upstream = upstream;
    this.supervisor = supervisor;
    this.log = log;
    this.sessions = new Map();
    this.sseClients = new Map(); // sessionId -> Set<res>
  }

  createSession({ clientInfo, protocolVersion }) {
    const id = randomId(24);
    this.sessions.set(id, {
      id,
      clientInfo: clientInfo || null,
      protocolVersion,
      createdAt: Date.now()
    });
    return id;
  }

  getSession(id) {
    if (!id) return null;
    return this.sessions.get(id) || null;
  }

  destroySession(id) {
    this.sessions.delete(id);
    const set = this.sseClients.get(id);
    if (set) {
      for (const res of set) {
        try {
          res.end();
        } catch {
          /* already closed */
        }
      }
      this.sseClients.delete(id);
    }
  }

  // ------------------------------------------------------------------ POST

  async handlePost(req, res, { auth, sendJson, readBody }) {
    const sessionId = req.headers['mcp-session-id'];
    let payload;
    try {
      const raw = await readBody(req);
      payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      sendJson(res, 400, rpcError(null, JSONRPC_ERRORS.parse));
      return;
    }

    const isBatch = Array.isArray(payload);
    const messages = isBatch ? payload : [payload];
    if (messages.length === 0) {
      sendJson(res, 400, rpcError(null, JSONRPC_ERRORS.invalidRequest));
      return;
    }

    // A session id supplied by the client must exist.
    if (sessionId && !this.getSession(sessionId)) {
      sendJson(res, 404, {
        jsonrpc: '2.0',
        error: { code: -32001, message: `Unknown session: ${sessionId}` },
        id: null
      });
      return;
    }

    const responses = [];
    let newSessionId = null;

    for (const message of messages) {
      if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
        if (message && 'id' in message) responses.push(rpcError(message.id, JSONRPC_ERRORS.invalidRequest));
        continue;
      }
      const { result, error, sessionCreated } = await this.#dispatch(message, { auth, sessionId });
      if (sessionCreated) newSessionId = sessionCreated;

      // Notifications have no id and get no response.
      if (message.id === undefined || message.id === null) continue;
      responses.push(error ? rpcError(message.id, error) : { jsonrpc: '2.0', id: message.id, result });
    }

    if (newSessionId) res.setHeader('Mcp-Session-Id', newSessionId);

    if (responses.length === 0) {
      res.writeHead(202, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    const body = isBatch ? responses : responses[0];
    const accept = String(req.headers.accept || '');
    const wantsJson = accept.includes('application/json') || accept.includes('*/*') || accept === '';
    const wantsSse = accept.includes('text/event-stream');

    if (wantsJson || !wantsSse) {
      sendJson(res, 200, body);
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
    res.end();
  }

  // -------------------------------------------------------------------- GET

  handleGet(req, res, { auth }) {
    const sessionId = req.headers['mcp-session-id'];
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(`: ${SERVER_NAME} ${SERVER_VERSION} stream open\n\n`);
    if (sessionId) {
      if (!this.sseClients.has(sessionId)) this.sseClients.set(sessionId, new Set());
      this.sseClients.get(sessionId).add(res);
      req.on('close', () => this.sseClients.get(sessionId)?.delete(res));
    }
    const keepalive = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(keepalive);
      }
    }, 25_000);
    req.on('close', () => clearInterval(keepalive));
  }

  // ----------------------------------------------------------------- DELETE

  handleDelete(req, res, { auth }) {
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId) this.destroySession(sessionId);
    res.writeHead(204).end();
  }

  // --------------------------------------------------------------- dispatch

  async #dispatch(message, { auth, sessionId }) {
    const { method, params = {} } = message;

    if (method === 'initialize') {
      const requested = params.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : DEFAULT_PROTOCOL_VERSION;
      const id = this.createSession({ clientInfo: params.clientInfo, protocolVersion });
      return {
        sessionCreated: id,
        result: {
          protocolVersion,
          capabilities: {
            tools: { listChanged: false }
          },
          serverInfo: {
            name: SERVER_NAME,
            version: SERVER_VERSION,
            title: 'WorkBuddy local agent (OAuth gateway)'
          },
          instructions:
            'This server exposes the WorkBuddy / CodeBuddy coding agent running on the user\'s machine. ' +
            'Use agent_run to execute a prompt and agent_job_status to follow long runs. ' +
            'The agent can read/write files and run shell commands, so treat tool calls as privileged.'
        }
      };
    }

    if (method.startsWith('notifications/')) {
      return { result: null };
    }

    if (method === 'ping') {
      return { result: {} };
    }

    if (method === 'tools/list') {
      const tools = toolDescriptorsForScopes(auth.scopes);
      return { result: { tools } };
    }

    if (method === 'tools/call') {
      const name = params.name;
      const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      const tool = TOOL_BY_NAME.get(name);
      if (!tool) {
        return { error: { code: -32602, message: `Unknown tool: ${name}` } };
      }
      if (!auth.scopes.includes(tool.scope)) {
        return {
          result: {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Permission denied: tool "${name}" requires the "${tool.scope}" scope. ` +
                  `This token has: ${auth.scopes.join(', ') || '(none)'}.`
              }
            ]
          }
        };
      }
      try {
        const data = await tool.handler(args, {
          upstream: this.upstream,
          supervisor: this.supervisor,
          config: this.cfg,
          auth
        });
        return {
          result: {
            content: [{ type: 'text', text: stringify(data) }],
            structuredContent: toStructured(data)
          }
        };
      } catch (err) {
        this.log.warn(`tool ${name} failed: ${err.message}`);
        return {
          result: {
            isError: true,
            content: [{ type: 'text', text: `${err.name || 'Error'}: ${err.message}` }]
          }
        };
      }
    }

    if (method === 'resources/list') return { result: { resources: [] } };
    if (method === 'resources/templates/list') return { result: { resourceTemplates: [] } };
    if (method === 'prompts/list') return { result: { prompts: [] } };
    if (method === 'logging/setLevel') return { result: {} };
    if (method === 'completion/complete') return { result: { completion: { values: [] } } };

    return { error: JSONRPC_ERRORS.methodNotFound };
  }
}

function toStructured(data) {
  if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  return { value: data };
}

function stringify(data) {
  if (typeof data === 'string') return data;
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

function rpcError(id, error) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code: error.code, message: error.message, data: error.data } };
}
