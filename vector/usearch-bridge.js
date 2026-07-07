#!/usr/bin/env node
/**
 * usearch-bridge.js - single-service, multi-backend USearch bridge.
 *
 * Compatibility:
 * - qdrantQuery(query, topK, timeoutMs) still works and defaults to OpenClaw.
 * - qdrantBuild(files, timeoutMs) still works and defaults to OpenClaw.
 */

import { Index } from 'usearch';
import { spawn } from 'child_process';
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, appendFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';

const USER_HOME = process.env.OPENCLAW_USER_HOME
  || process.env.CODEX_USER_HOME
  || process.env.USERPROFILE
  || homedir();
const ws = process.env.OPENCLAW_WORKSPACE_ROOT || join(USER_HOME, '.openclaw', 'workspace');
const HIP_DIR = join(ws, 'memory', 'hippocampus');
const CODEX_QA_USEARCH_DIR = process.env.CODEX_QA_USEARCH_INDEX_ROOT
  || join(USER_HOME, '.codex', 'memory', 'indexes', 'codex-qa-diary-usearch-bge-m3');
const EMBED_SCRIPT = process.env.BGE_M3_EMBED_SCRIPT || join(ws, 'scripts', 'bge-m3-embed-serve.py');

const PYTHON_312 = join(
  USER_HOME,
  'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'
);

export const MODEL_ID = process.env.BGE_M3_MODEL_ID || 'BAAI/bge-m3';
export const MODEL_VARIANT = process.env.BGE_M3_MODEL_VARIANT || 'dynamic-int8-onnx';
export const MODEL_SOURCE_REPO = process.env.BGE_M3_MODEL_SOURCE_REPO || 'er6y/bge-m3_dynamic_int8_onnx';
export const DIM = 1024;
export const TOP_K = 30;
export const DEFAULT_BACKEND_ID = 'openclaw_usearch';
const BATCH_SIZE = 16;

const BACKENDS = Object.freeze({
  openclaw_usearch: {
    id: 'openclaw_usearch',
    aliases: ['openclaw', 'default'],
    label: 'OpenClaw memory USearch',
    dimension: DIM,
    model: MODEL_ID,
    modelVariant: MODEL_VARIANT,
    modelSourceRepo: MODEL_SOURCE_REPO,
    indexPath: join(HIP_DIR, 'usearch_bge_m3_vectors.index'),
    metaPath: join(HIP_DIR, 'usearch_bge_m3_meta.jsonl'),
    manifestPath: join(HIP_DIR, 'usearch_bge_m3_manifest.json'),
    sourceKind: 'openclaw_qa_logger',
    authorityTier: 'raw_search_evidence',
  },
  codex_qa_usearch: {
    id: 'codex_qa_usearch',
    aliases: ['codex_qa', 'codex'],
    label: 'Codex QA diary USearch',
    dimension: DIM,
    model: MODEL_ID,
    modelVariant: MODEL_VARIANT,
    modelSourceRepo: MODEL_SOURCE_REPO,
    indexPath: join(CODEX_QA_USEARCH_DIR, 'usearch_vectors.index'),
    metaPath: join(CODEX_QA_USEARCH_DIR, 'usearch_meta.jsonl'),
    manifestPath: join(CODEX_QA_USEARCH_DIR, 'manifest.json'),
    sourceKind: 'codex_qa_diary',
    authorityTier: 'codex_qa_archive',
  },
});

const BACKEND_ALIASES = new Map();
for (const backend of Object.values(BACKENDS)) {
  BACKEND_ALIASES.set(backend.id, backend.id);
  for (const alias of backend.aliases || []) BACKEND_ALIASES.set(alias, backend.id);
}

const _states = new Map();

function intEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function stateFor(backend) {
  if (!_states.has(backend.id)) {
    _states.set(backend.id, {
      idx: null,
      metaMap: new Map(),
      metaLoaded: false,
      sourceSet: new Set(),
      total: 0,
      maxKey: 0,
      keyCounter: Date.now(),
      indexSignature: null,
      metaSignature: null,
    });
  }
  return _states.get(backend.id);
}

function normalizeOptions(value) {
  if (typeof value === 'number') return { timeoutMs: value };
  if (value && typeof value === 'object') return value;
  return {};
}

function resolveBackend(input) {
  const raw = (typeof input === 'string' ? input : input?.backend || input?.backendId || DEFAULT_BACKEND_ID).toString();
  const backendId = BACKEND_ALIASES.get(raw) || raw;
  const backend = BACKENDS[backendId];
  if (!backend) throw new Error(`unknown USearch backend: ${raw}`);
  return backend;
}

function ensureParent(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

function compactText(text, limit = 2500) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function fileSignature(filePath) {
  if (!existsSync(filePath)) return 'missing';
  const info = statSync(filePath);
  return `${info.size}:${Math.round(info.mtimeMs)}`;
}

function loadIndex(backend) {
  const state = stateFor(backend);
  const signature = fileSignature(backend.indexPath);
  if (state.idx && state.indexSignature === signature) return state;
  ensureParent(backend.indexPath);
  state.idx = new Index({ metric: 'cos', dimensions: backend.dimension, connectivity: 16, expansionSearch: 64 });
  if (existsSync(backend.indexPath) && statSync(backend.indexPath).size > 0) {
    try {
      state.idx.load(backend.indexPath);
    } catch (error) {
      console.error(`[usearch-bridge] ${backend.id} index load failed, using empty index: ${error.message}`);
    }
  }
  state.total = Number(state.idx.size()) || 0;
  state.indexSignature = signature;
  return state;
}

async function loadMeta(backend) {
  const state = stateFor(backend);
  const signature = fileSignature(backend.metaPath);
  if (state.metaLoaded && state.metaSignature === signature) return state;
  state.metaMap = new Map();
  state.sourceSet = new Set();
  state.maxKey = 0;
  if (!existsSync(backend.metaPath)) {
    state.metaLoaded = true;
    state.metaSignature = signature;
    return state;
  }
  await new Promise((resolve, reject) => {
    const rl = createInterface({ input: createReadStream(backend.metaPath, 'utf-8'), crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const m = JSON.parse(line);
        if (m.k === undefined) return;
        const key = Number(m.k);
        state.metaMap.set(key, {
          text: m.t || m.text || '',
          source: m.s || m.source || '',
          sourceKind: m.source_kind || backend.sourceKind,
          authorityTier: m.authority_tier || backend.authorityTier,
        });
        if (m.s || m.source) state.sourceSet.add(String(m.s || m.source));
        if (Number.isFinite(key)) state.maxKey = Math.max(state.maxKey, key);
      } catch (_) {
        // Ignore malformed metadata lines.
      }
    });
    rl.on('close', resolve);
    rl.on('error', reject);
  });
  state.keyCounter = Math.max(state.keyCounter || 0, state.maxKey || 0, Date.now());
  state.metaLoaded = true;
  state.metaSignature = signature;
  return state;
}

// Embedding process ----------------------------------------------------------
let _proc = null;
let _starting = null;
let _qid = 0;
let _pending = new Map();
let _buf = '';
let _ready = false;

function failPending(error) {
  for (const pending of _pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  _pending.clear();
}

function ensureEmbedProc() {
  if (_proc && _proc.exitCode === null && _ready) return Promise.resolve();
  if (_starting) return _starting;
  if (_proc) {
    try { _proc.kill(); } catch (_) {}
    _proc = null;
  }
  _ready = false;
  _buf = '';
  _proc = spawn(PYTHON_312, [EMBED_SCRIPT], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, HOME: USER_HOME, USERPROFILE: USER_HOME },
  });

  _proc.stdout.on('data', (chunk) => {
    _buf += chunk.toString();
    const lines = _buf.split('\n');
    _buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let data;
      try {
        data = JSON.parse(line);
      } catch (_) {
        continue;
      }
      const id = String(data._queryId ?? data.id ?? '');
      const pending = _pending.get(id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      _pending.delete(id);
      if (data.error) pending.reject(new Error(data.error));
      else pending.resolve(data.vectors || (data.vector ? [data.vector] : []));
    }
  });

  _starting = new Promise((resolve, reject) => {
    let settled = false;
    const warmupTimeoutMs = intEnv('BGE_M3_EMBED_WARMUP_TIMEOUT_MS', 90000);
    const timer = setTimeout(() => settle(new Error(`BGE-M3 embedding process warmup timeout after ${warmupTimeoutMs}ms`)), warmupTimeoutMs);
    const settle = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      _starting = null;
      if (error) reject(error);
      else resolve();
    };

    _proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (text.includes('就绪') || text.includes('Ready')) {
        _ready = true;
        settle();
      }
      const trimmed = text.trim();
      if (trimmed && !trimmed.includes('就绪')) console.error(`[bge-m3-embed] ${trimmed}`);
    });
    _proc.on('exit', (code) => {
      _ready = false;
      failPending(new Error(`BGE-M3 embedding process exited(code=${code})`));
      if (!settled) settle(new Error(`BGE-M3 embedding process exited before ready(code=${code})`));
    });
    _proc.on('error', (error) => {
      _ready = false;
      failPending(error);
      if (!settled) settle(error);
    });
  });
  return _starting;
}

async function embedTexts(texts, timeoutMs = 300000) {
  await ensureEmbedProc();
  return new Promise((resolve, reject) => {
    const id = String(++_qid);
    const timer = setTimeout(() => {
      _pending.delete(id);
      reject(new Error('BGE-M3 embedding timeout'));
    }, timeoutMs);
    _pending.set(id, { resolve, reject, timer });
    try {
      _proc.stdin.write(JSON.stringify({ _queryId: id, texts }, null, 0) + '\n');
    } catch (error) {
      clearTimeout(timer);
      _pending.delete(id);
      reject(error);
    }
  }).then((vectors) => {
    for (const vector of vectors) {
      if (!Array.isArray(vector) || vector.length !== DIM) {
        throw new Error(`BGE-M3 vector dimension mismatch: expected ${DIM}, got ${Array.isArray(vector) ? vector.length : 'non-array'}`);
      }
    }
    return vectors;
  });
}

// Query ----------------------------------------------------------------------
export async function qdrantQuery(query, topK = TOP_K, optionsOrTimeout = {}) {
  if (!query) throw new Error('query is required');
  const options = normalizeOptions(optionsOrTimeout);
  const backend = resolveBackend(options);
  const timeoutMs = Number(options.timeoutMs || options.timeout || 30000);
  const limit = Math.max(1, Math.min(Number(topK || TOP_K), 100));
  const t0 = performance.now();
  const state = loadIndex(backend);
  await loadMeta(backend);
  const tMeta = performance.now();

  if (state.total <= 0) {
    return {
      results: [],
      total_in_index: 0,
      elapsed_ms: Math.round(performance.now() - t0),
      backend: backend.id,
      dimension: backend.dimension,
      model: backend.model,
      model_variant: backend.modelVariant,
      model_source_repo: backend.modelSourceRepo,
      timing: { meta_ms: Math.round(tMeta - t0), embed_ms: 0, search_ms: 0 },
    };
  }

  const [vector] = await embedTexts([query], timeoutMs);
  const tEmbed = performance.now();
  const matches = state.idx.search(new Float32Array(vector), limit);
  const tSearch = performance.now();
  const items = [];
  for (let i = 0; i < matches.keys.length; i += 1) {
    const key = Number(matches.keys[i]);
    const distance = Number(matches.distances[i]);
    const score = 1 - distance;
    const meta = state.metaMap.get(key) || { text: '', source: '', sourceKind: backend.sourceKind, authorityTier: backend.authorityTier };
    items.push({
      score: Math.round(score * 10000) / 10000,
      text: compactText(meta.text, 2500),
      text_full_length: String(meta.text || '').length,
      source: String(meta.source || '').slice(0, 500),
      id: key,
      backend: backend.id,
      source_kind: meta.sourceKind || backend.sourceKind,
      authority_tier: meta.authorityTier || backend.authorityTier,
      needs_main_review: true,
    });
  }

  return {
    results: items,
    total_in_index: state.total,
    elapsed_ms: Math.round(performance.now() - t0),
    backend: backend.id,
    dimension: backend.dimension,
    model: backend.model,
    model_variant: backend.modelVariant,
    model_source_repo: backend.modelSourceRepo,
    timing: {
      meta_ms: Math.round(tMeta - t0),
      embed_ms: Math.round(tEmbed - tMeta),
      search_ms: Math.round(tSearch - tEmbed),
    },
  };
}

function nextKey(state) {
  state.keyCounter = Math.max(state.keyCounter || 0, state.maxKey || 0, Date.now()) + 1;
  state.maxKey = Math.max(state.maxKey || 0, state.keyCounter);
  return state.keyCounter;
}

function chunksFromFile(filePath) {
  const raw = readFileSync(filePath, 'utf-8');
  const records = [];
  if (filePath.endsWith('.jsonl') || filePath.endsWith('.json')) {
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        const text = obj.text || obj.content || obj.summary || line;
        if (String(text).trim().length >= 10) records.push({ text: String(text), source: filePath });
      } catch (_) {
        if (line.trim().length >= 20) records.push({ text: line, source: filePath });
      }
    }
    return records;
  }

  for (const para of raw.split(/\n{2,}/)) {
    const trimmed = para.trim();
    if (trimmed.length < 20) continue;
    if (trimmed.length <= 1800) {
      records.push({ text: trimmed, source: filePath });
      continue;
    }
    for (let offset = 0; offset < trimmed.length; offset += 1500) {
      const chunk = trimmed.slice(offset, offset + 1800).trim();
      if (chunk.length >= 20) records.push({ text: chunk, source: filePath });
    }
  }
  return records;
}

export async function qdrantBuild(files, optionsOrTimeout = {}) {
  const options = normalizeOptions(optionsOrTimeout);
  const backend = resolveBackend(options);
  const timeoutMs = Number(options.timeoutMs || options.timeout || 900000);
  if (!files || files.length === 0) {
    return { status: 'ok', backend: backend.id, added: 0, total: stateFor(backend).total || 0, elapsed_ms: 0, note: 'no files' };
  }

  const t0 = performance.now();
  const state = loadIndex(backend);
  await loadMeta(backend);
  ensureParent(backend.metaPath);

  const newRecords = [];
  for (const rawFile of files) {
    const filePath = String(rawFile || '').trim();
    if (!filePath || !existsSync(filePath) || state.sourceSet.has(filePath)) continue;
    try {
      newRecords.push(...chunksFromFile(filePath));
    } catch (error) {
      console.error(`[usearch-bridge] ${backend.id} read failed: ${filePath}: ${error.message}`);
    }
  }

  let added = 0;
  for (let offset = 0; offset < newRecords.length; offset += BATCH_SIZE) {
    const batch = newRecords.slice(offset, offset + BATCH_SIZE);
    const vectors = await embedTexts(batch.map((record) => record.text), timeoutMs);
    for (let i = 0; i < batch.length; i += 1) {
      const key = nextKey(state);
      const text = compactText(batch[i].text, 2500);
      const source = String(batch[i].source || '').slice(0, 500);
      state.idx.add(BigInt(key), new Float32Array(vectors[i]));
      state.metaMap.set(key, { text, source, sourceKind: backend.sourceKind, authorityTier: backend.authorityTier });
      state.sourceSet.add(source);
      appendFileSync(backend.metaPath, JSON.stringify({
        k: key,
        t: text,
        s: source,
        source_kind: backend.sourceKind,
        authority_tier: backend.authorityTier,
      }, null, 0) + '\n', 'utf-8');
      added += 1;
    }
  }

  if (added > 0) {
    state.idx.save(backend.indexPath);
    state.total = Number(state.idx.size()) || 0;
    writeManifest(backend, { mode: 'incremental', added, total: state.total, source_files: files.length });
  }

  return {
    status: 'ok',
    backend: backend.id,
    added,
    total: state.total,
    dimension: backend.dimension,
    model: backend.model,
    model_variant: backend.modelVariant,
    model_source_repo: backend.modelSourceRepo,
    elapsed_ms: Math.round(performance.now() - t0),
  };
}

function writeManifest(backend, extra) {
  ensureParent(backend.manifestPath);
  writeFileSync(backend.manifestPath, JSON.stringify({
    schema_version: 1,
    generated_at: new Date().toISOString(),
    backend: backend.id,
    model: backend.model,
    model_variant: backend.modelVariant,
    model_source_repo: backend.modelSourceRepo,
    dimension: backend.dimension,
    index_path: backend.indexPath,
    meta_path: backend.metaPath,
    ...extra,
  }, null, 2), 'utf-8');
}

function validateTmpIndex(filePath, expectedSize, dimension) {
  if (expectedSize <= 0) return;
  const probe = new Index({ metric: 'cos', dimensions: dimension, connectivity: 16, expansionSearch: 64 });
  probe.load(filePath);
  const actualSize = Number(probe.size()) || 0;
  if (actualSize !== expectedSize) {
    throw new Error(`rebuilt index size mismatch: expected ${expectedSize}, got ${actualSize}`);
  }
}

function replaceFileWithBackup(tmpPath, targetPath, backupPath) {
  const hadTarget = existsSync(targetPath);
  if (hadTarget) copyFileSync(targetPath, backupPath);
  try {
    rmSync(targetPath, { force: true });
    renameSync(tmpPath, targetPath);
  } catch (error) {
    try {
      if (hadTarget && existsSync(backupPath) && !existsSync(targetPath)) {
        copyFileSync(backupPath, targetPath);
      }
    } catch (_) {
      // Preserve the original error; restoration is best-effort.
    }
    throw error;
  }
}

export async function rebuildBackendFromRecords(backendInput, records, options = {}) {
  const backend = resolveBackend(backendInput);
  const timeoutMs = Number(options.timeoutMs || options.timeout || 900000);
  const t0 = performance.now();
  ensureParent(backend.indexPath);
  ensureParent(backend.metaPath);

  const tmpIndex = `${backend.indexPath}.tmp-${process.pid}`;
  const tmpMeta = `${backend.metaPath}.tmp-${process.pid}`;
  const backupStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupIndex = `${backend.indexPath}.bak-${backupStamp}`;
  const backupMeta = `${backend.metaPath}.bak-${backupStamp}`;
  rmSync(tmpIndex, { force: true });
  rmSync(tmpMeta, { force: true });

  const idx = new Index({ metric: 'cos', dimensions: backend.dimension, connectivity: 16, expansionSearch: 64 });
  const metaStream = createWriteStream(tmpMeta, { encoding: 'utf-8' });
  let added = 0;

  for (let offset = 0; offset < records.length; offset += BATCH_SIZE) {
    const batch = records.slice(offset, offset + BATCH_SIZE)
      .map((record) => ({
        text: String(record.text || record.content || '').trim(),
        source: String(record.source || record.path || '').slice(0, 500),
        chunk_index: record.chunk_index,
      }))
      .filter((record) => record.text.length >= 10);
    if (batch.length === 0) continue;

    const vectors = await embedTexts(batch.map((record) => record.text), timeoutMs);
    for (let i = 0; i < batch.length; i += 1) {
      const key = added + 1;
      const text = compactText(batch[i].text, 2500);
      idx.add(BigInt(key), new Float32Array(vectors[i]));
      metaStream.write(JSON.stringify({
        k: key,
        t: text,
        s: batch[i].source,
        chunk_index: batch[i].chunk_index,
        source_kind: backend.sourceKind,
        authority_tier: backend.authorityTier,
      }, null, 0) + '\n');
      added += 1;
    }
  }

  await new Promise((resolve, reject) => {
    metaStream.on('error', reject);
    metaStream.end(resolve);
  });

  if (added > 0) idx.save(tmpIndex);
  else writeFileSync(tmpIndex, '', 'utf-8');
  validateTmpIndex(tmpIndex, added, backend.dimension);
  replaceFileWithBackup(tmpMeta, backend.metaPath, backupMeta);
  if (added > 0) replaceFileWithBackup(tmpIndex, backend.indexPath, backupIndex);
  else rmSync(tmpIndex, { force: true });
  writeManifest(backend, {
    mode: options.mode || 'full',
    source_mode: options.sourceMode || 'records',
    source_files: options.sourceFiles || null,
    source_root: options.sourceRoot || null,
    source_fingerprint: options.sourceFingerprint || null,
    chunks: added,
    total: added,
  });

  _states.delete(backend.id);
  const state = loadIndex(backend);
  await loadMeta(backend);
  return {
    status: 'ok',
    backend: backend.id,
    chunks: added,
    total: state.total,
    dimension: backend.dimension,
    model: backend.model,
    model_variant: backend.modelVariant,
    model_source_repo: backend.modelSourceRepo,
    elapsed_ms: Math.round(performance.now() - t0),
  };
}

function backendStatus(backend) {
  const state = _states.get(backend.id);
  const indexExists = existsSync(backend.indexPath) && statSync(backend.indexPath).size > 0;
  const metaExists = existsSync(backend.metaPath) && statSync(backend.metaPath).size > 0;
  return {
    id: backend.id,
    label: backend.label,
    default: backend.id === DEFAULT_BACKEND_ID,
    dimension: backend.dimension,
    model: backend.model,
    model_variant: backend.modelVariant,
    model_source_repo: backend.modelSourceRepo,
    source_kind: backend.sourceKind,
    authority_tier: backend.authorityTier,
    index_path: backend.indexPath,
    meta_path: backend.metaPath,
    index_exists: indexExists,
    meta_exists: metaExists,
    loaded: Boolean(state?.idx),
    total_vectors: state?.total ?? null,
    status: indexExists && metaExists ? 'ok' : 'missing',
  };
}

export function getBackendRegistry() {
  return Object.values(BACKENDS).map((backend) => ({ ...backend }));
}

export function listBackends() {
  return Object.values(BACKENDS).map(backendStatus);
}

export function stopEmbedProcess() {
  try { if (_proc) _proc.kill(); } catch (_) {}
  _proc = null;
  _ready = false;
}

process.on('exit', () => stopEmbedProcess());
process.on('SIGTERM', () => { stopEmbedProcess(); process.exit(0); });
process.on('SIGINT', () => { stopEmbedProcess(); process.exit(0); });
