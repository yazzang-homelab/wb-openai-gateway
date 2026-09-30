/**
 * Tiny JSON-file backed store with atomic writes.
 *
 * Everything the gateway persists lives in one data directory:
 *   data/secret.key   HMAC signing key for access tokens
 *   data/clients.json dynamically registered OAuth clients
 *   data/state.json   refresh tokens, revoked token ids, consent log
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function atomicWrite(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export class JsonStore {
  constructor(file, fallback = {}) {
    this.file = file;
    this.fallback = fallback;
    this.data = this.#load();
  }

  #load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* first run or corrupted -> start fresh */
    }
    return structuredClone(this.fallback);
  }

  save() {
    atomicWrite(this.file, `${JSON.stringify(this.data, null, 2)}\n`);
  }

  get(key, dflt) {
    return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : dflt;
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
    return value;
  }

  update(key, fn) {
    return this.set(key, fn(this.get(key)));
  }
}

export function loadOrCreateKey(file) {
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* create below */
  }
  const key = crypto.randomBytes(48).toString('base64url');
  atomicWrite(file, `${key}\n`);
  return key;
}
