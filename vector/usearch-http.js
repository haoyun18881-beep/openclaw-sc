/**
 * usearch-http.js - HTTP client for the multi-backend USearch service.
 *
 * Compatibility:
 * - qdrantSearch(query, topK, timeoutMs) defaults to OpenClaw.
 * - qdrantSearch(query, topK, { backend: "codex_qa_usearch" }) is supported.
 */

const URL = process.env.USEARCH_SERVICE_URL || 'http://127.0.0.1:18793';

function splitTimeoutAndOptions(timeoutOrOptions, maybeOptions) {
  if (timeoutOrOptions && typeof timeoutOrOptions === 'object') {
    return {
      timeoutMs: Number(timeoutOrOptions.timeoutMs || timeoutOrOptions.timeout || 30000),
      options: timeoutOrOptions,
    };
  }
  return {
    timeoutMs: Number(timeoutOrOptions || 30000),
    options: maybeOptions || {},
  };
}

export async function qdrantSearch(query, topK = 10, timeoutOrOptions = 30000, maybeOptions = {}) {
  if (!query) throw new Error('query 必填');
  const { timeoutMs, options } = splitTimeoutAndOptions(timeoutOrOptions, maybeOptions);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const body = { query, topK };
  if (options.backend) body.backend = options.backend;

  try {
    const r = await fetch(`${URL}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${r.status}`);
    }
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function qdrantBuild(files, timeoutOrOptions = 600000, maybeOptions = {}) {
  if (!files || files.length === 0) throw new Error('files 必填');
  const { timeoutMs, options } = splitTimeoutAndOptions(timeoutOrOptions, maybeOptions);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const body = { files };
  if (options.backend) body.backend = options.backend;

  try {
    const r = await fetch(`${URL}/incremental`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${r.status}`);
    }
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}
