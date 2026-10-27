import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import worker from "../../cloudflare-worker/src/worker.js";
import { zonedLocalToUtc } from "../../cloudflare-worker/src/workforce-core.js";

const BASE_URL = "https://simulation.invalid";
const SERVER_KEY = "simulation-server-key";
const PIN_PEPPER = "simulation-pin-pepper";

function plainRow(row) {
  return row == null ? null : Object.fromEntries(Object.entries(row));
}

class D1Statement {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }

  bind(...args) {
    return new D1Statement(this.db, this.sql, args);
  }

  all(...args) {
    const rows = this.db.prepare(this.sql).all(...(this.args.length ? this.args : args));
    return Promise.resolve({ results: rows.map(plainRow) });
  }

  first(...args) {
    const row = this.db.prepare(this.sql).get(...(this.args.length ? this.args : args));
    return Promise.resolve(plainRow(row));
  }

  run(...args) {
    const result = this.db.prepare(this.sql).run(...(this.args.length ? this.args : args));
    return Promise.resolve({ meta: {
      changes: Number(result.changes || 0),
      last_row_id: Number(result.lastInsertRowid || 0)
    } });
  }
}

class D1Simulation {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys = ON;");
  }

  exec(sql) {
    this.sqlite.exec(sql);
    return Promise.resolve({});
  }

  prepare(sql) {
    return new D1Statement(this.sqlite, sql);
  }

  async batch(statements) {
    this.sqlite.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

class R2Simulation {
  constructor() {
    this.objects = new Map();
  }

  async put(key, value, options = {}) {
    const bytes = value instanceof Uint8Array
      ? value
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(await new Response(value).arrayBuffer());
    this.objects.set(key, { bytes, httpMetadata: options.httpMetadata || {} });
    return { size: bytes.byteLength, httpMetadata: options.httpMetadata || {} };
  }

  async head(key) {
    const item = this.objects.get(key);
    return item ? { size: item.bytes.byteLength, httpMetadata: item.httpMetadata } : null;
  }

  async get(key) {
    const item = this.objects.get(key);
    if (!item) return null;
    return {
      body: new Response(item.bytes).body,
      size: item.bytes.byteLength,
      httpMetadata: item.httpMetadata,
      arrayBuffer: async () => item.bytes.buffer.slice(item.bytes.byteOffset, item.bytes.byteOffset + item.bytes.byteLength),
      writeHttpMetadata(headers) {
        for (const [key, value] of Object.entries(item.httpMetadata || {})) {
          const header = key.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase());
          if (value) headers.set(header, value);
        }
      }
    };
  }
}

export function createSimulation(){
const db = new D1Simulation();
const releases = new R2Simulation();
const env = {
  DB: db,
  RELEASES: releases,
  ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
  SERVER_KEY,
  PIN_PEPPER,
  CLIENT_KEY: "simulation-client-key"
};

async function call(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  if (options.server) headers.set("X-Fleet-Server-Key", SERVER_KEY);
  let body = options.body;
  if (body !== undefined) {
    body = typeof body === "string" ? body : JSON.stringify(body);
    headers.set("Content-Type", "application/json");
  }
  const response = await worker.fetch(new Request(`${BASE_URL}${path}`, {
    method: options.method || "GET",
    headers,
    body
  }), env);
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  return { status: response.status, data, headers: response.headers };
}

async function callRaw(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  if (options.server) headers.set("X-Fleet-Server-Key", SERVER_KEY);
  const response = await worker.fetch(new Request(`${BASE_URL}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body
  }), env);
  const raw = await response.arrayBuffer();
  let data = {};
  try { data = raw.byteLength ? JSON.parse(new TextDecoder().decode(raw)) : {}; } catch { data = { bytes: raw.byteLength }; }
  return { status: response.status, data, headers: response.headers, bytes: raw };
}

function ok(result, expectedStatus = 200, label = "request") {
  assert.equal(result.status, expectedStatus, `${label}: ${JSON.stringify(result.data)}`);
  return result.data;
}

function fails(result, expectedStatus, expectedCode, label) {
  assert.equal(result.status, expectedStatus, `${label}: ${JSON.stringify(result.data)}`);
  if (expectedCode) assert.equal(result.data.code, expectedCode, `${label}: error code`);
}



return {db,env,call,callRaw};
}
