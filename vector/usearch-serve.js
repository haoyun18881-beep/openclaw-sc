#!/usr/bin/env node
/**
 * usearch-serve.js - OpenClaw/Codex single-service multi-backend USearch.
 *
 * Port 18793.
 * - POST /query without backend remains compatible and searches OpenClaw only.
 * - POST /query with backend="codex_qa_usearch" searches Codex QA only.
 */

import { createServer } from 'http';
import { DEFAULT_BACKEND_ID, DIM, MODEL_ID, MODEL_SOURCE_REPO, MODEL_VARIANT, listBackends, qdrantBuild, qdrantQuery } from './usearch-bridge.js';

const PORT = 18793;
const CT = 'application/json; charset=utf-8';

let _uptime = Date.now();
let _ready = false;
let _startupWarning = null;
let _defaultTotal = 0;

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': CT });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
  });
}

function routeUrl(req) {
  return new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = routeUrl(req);

  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, {
      status: _ready ? (_startupWarning ? 'degraded' : 'ok') : 'warming',
      service: 'usearch',
      port: PORT,
      uptime: Math.round((Date.now() - _uptime) / 1000),
      backend: DEFAULT_BACKEND_ID,
      dimension: DIM,
      model: MODEL_ID,
      model_variant: MODEL_VARIANT,
      model_source_repo: MODEL_SOURCE_REPO,
      total_vectors: _defaultTotal,
      startup_warning: _startupWarning,
      backends: listBackends(),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/backends') {
    json(res, 200, {
      service: 'usearch',
      default_backend: DEFAULT_BACKEND_ID,
      dimension: DIM,
      model: MODEL_ID,
      model_variant: MODEL_VARIANT,
      model_source_repo: MODEL_SOURCE_REPO,
      backends: listBackends(),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/query') {
    if (!_ready) {
      json(res, 503, { error: 'service warming' });
      return;
    }
    try {
      const raw = await readBody(req);
      const args = raw ? JSON.parse(raw) : {};
      const query = String(args.query || '').trim();
      if (!query) {
        json(res, 400, { error: 'query is required' });
        return;
      }
      const backend = args.backend || url.searchParams.get('backend') || DEFAULT_BACKEND_ID;
      const result = await qdrantQuery(query, args.topK || args.top_k || 10, {
        backend,
        timeoutMs: args.timeoutMs || args.timeout_ms || args.timeout,
      });
      if (result.backend === DEFAULT_BACKEND_ID) _defaultTotal = result.total_in_index || _defaultTotal;
      json(res, 200, result);
    } catch (error) {
      json(res, 500, { error: error.message });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/incremental') {
    if (!_ready) {
      json(res, 503, { error: 'service warming' });
      return;
    }
    try {
      const raw = await readBody(req);
      const args = raw ? JSON.parse(raw) : {};
      const files = args.files;
      if (!files || files.length === 0) {
        json(res, 400, { error: 'files is required' });
        return;
      }
      const backend = args.backend || url.searchParams.get('backend') || DEFAULT_BACKEND_ID;
      const result = await qdrantBuild(files, {
        backend,
        timeoutMs: args.timeoutMs || args.timeout_ms || args.timeout,
      });
      if (result.backend === DEFAULT_BACKEND_ID) _defaultTotal = result.total || _defaultTotal;
      json(res, 200, result);
    } catch (error) {
      json(res, 500, { error: error.message });
    }
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

console.error('[usearch-serve] warming default backend...');
try {
  const t0 = Date.now();
  const r = await qdrantQuery('__warmup__', 1, { backend: DEFAULT_BACKEND_ID, timeoutMs: 90000 });
  _defaultTotal = r.total_in_index || 0;
  _ready = true;
  _uptime = Date.now();
  console.error(`[usearch-serve] warmup done: backend=${DEFAULT_BACKEND_ID}, total=${_defaultTotal}, ${Math.round((Date.now() - t0) / 1000)}s`);
} catch (error) {
  _startupWarning = error.message;
  _ready = true;
  _uptime = Date.now();
  console.error(`[usearch-serve] warmup degraded: ${error.message}`);
}

server.listen(PORT, '127.0.0.1', () => {
  console.error(`[usearch-serve] HTTP service: http://127.0.0.1:${PORT}`);
});
