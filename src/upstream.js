/**
 * Client for the upstream WorkBuddy / CodeBuddy local agent service
 * (`codebuddy --serve` / `codebuddy daemon start`).
 *
 * Upstream auth model (from the product's HTTP API docs):
 *   X-CodeBuddy-Request: 1        -- required anti-CSRF marker on every call
 *   Authorization: Bearer <pw>    -- gateway password (or X-Access-Token)
 */
export class UpstreamError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export class Upstream {
  constructor(config) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.password = config.password || null;
    this.extraHeaders = config.headers || {};
    this.timeoutMs = config.requestTimeoutMs ?? 120_000;
  }

  headers(extra = {}) {
    const h = {
      'X-CodeBuddy-Request': '1',
      Accept: 'application/json',
      ...this.extraHeaders,
      ...extra
    };
    if (this.password) h.Authorization = `Bearer ${this.password}`;
    return h;
  }

  url(pathname, query) {
    const u = new URL(this.baseUrl + pathname);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
      }
    }
    return u;
  }

  /**
   * Perform an upstream request.
   * @returns {Promise<{status:number, json:any, text:string}>}
   */
  async fetch(pathname, { method = 'GET', query, body, headers, timeoutMs, raw = false } = {}) {
    const url = this.url(pathname, query);
    const init = {
      method,
      headers: this.headers(headers),
      signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs)
    };
    if (body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
      init.headers['Content-Type'] = 'application/json';
    }

    let res;
    try {
      res = await fetch(url, init);
    } catch (err) {
      throw new UpstreamError(
        `Cannot reach the local agent service at ${this.baseUrl} (${err.message}). ` +
          'Start it with `codebuddy --serve` or `codebuddy daemon start`.',
        { code: 'UPSTREAM_UNREACHABLE' }
      );
    }

    const text = await res.text();
    if (raw) return { status: res.status, text, res };

    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        /* non-JSON body */
      }
    }

    if (!res.ok) {
      const code = json?.error?.code || `HTTP_${res.status}`;
      const message = json?.error?.message || text.slice(0, 400) || res.statusText;
      throw new UpstreamError(`Upstream ${pathname} failed: ${message}`, {
        status: res.status,
        code,
        body: json ?? text
      });
    }

    return { status: res.status, json, text };
  }

  /** Unwrap the product's `{ data: ... }` envelope. */
  async data(pathname, opts) {
    const { json } = await this.fetch(pathname, opts);
    if (json && typeof json === 'object' && 'data' in json) return json.data;
    return json;
  }

  async health() {
    return this.data('/api/v1/health', { timeoutMs: 10_000 });
  }

  async info() {
    return this.data('/api/v1/info', { timeoutMs: 10_000 });
  }

  async authStatus() {
    return this.data('/api/v1/auth/status', { timeoutMs: 10_000 });
  }

  async listSessions({ cwd, limit } = {}) {
    return this.data('/api/v1/sessions', { query: { cwd, limit }, timeoutMs: 20_000 });
  }

  async listJobs({ cwd, all } = {}) {
    return this.data('/api/v1/jobs', { query: { cwd, all: all ? 1 : undefined }, timeoutMs: 20_000 });
  }

  async getJob(id) {
    const out = await this.data(`/api/v1/jobs/${encodeURIComponent(id)}`, { timeoutMs: 20_000 });
    return out?.job ?? out;
  }

  async jobTranscript(id) {
    return this.data(`/api/v1/jobs/${encodeURIComponent(id)}/transcript`, { timeoutMs: 20_000 });
  }

  async dispatchJob(payload) {
    const out = await this.data('/api/v1/jobs', { method: 'POST', body: payload, timeoutMs: 60_000 });
    return out?.job ?? out;
  }

  async stopJob(id) {
    return this.data(`/api/v1/jobs/${encodeURIComponent(id)}/stop`, { method: 'POST', body: {}, timeoutMs: 20_000 });
  }

  async replyJob(id, text) {
    return this.data(`/api/v1/jobs/${encodeURIComponent(id)}/reply`, {
      method: 'POST',
      body: { text },
      timeoutMs: 20_000
    });
  }

  async dispatchContext() {
    return this.data('/api/v1/jobs/dispatch-context', { timeoutMs: 20_000 });
  }

  async listWorkers() {
    return this.data('/api/v1/workers', { timeoutMs: 15_000 });
  }

  async workersLogs(id, { type, tail } = {}) {
    return this.data(`/api/v1/workers/${encodeURIComponent(id)}/logs`, {
      query: { type, tail },
      timeoutMs: 20_000
    });
  }

  async stats() {
    return this.data('/api/v1/stats', { timeoutMs: 20_000 });
  }

  /** Open a streaming (SSE) upstream response. Caller owns the body stream. */
  async openStream(pathname, { method = 'GET', query, body, headers } = {}) {
    const url = this.url(pathname, query);
    const init = {
      method,
      headers: this.headers({ Accept: 'text/event-stream', ...headers })
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(url, init);
    return res;
  }
}
