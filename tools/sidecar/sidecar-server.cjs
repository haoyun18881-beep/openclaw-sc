#!/usr/bin/env node
/**
 * 🦞 sc MCP Sidecar
 *
 * 独立Node.js HTTP服务，作为Windows服务运行（通过NSSM注册）。
 * 不依赖Gateway，Gateway重启后任务继续执行。
 *
 * 端口：18792（已确认可用，非18791/Gateway MCP端口）
 *
 * API端点：
 *   POST /execute_task       — 提交长任务
 *   POST /spawn_subagent     — 提交子Agent任务
 *   GET  /task/:id           — 查任务状态
 *   GET  /tasks              — 列出所有任务
 *   POST /task/:id/cancel    — 取消任务
 *   POST /task/:id/retry     — retry任务
 *   GET  /health             — 健康检查
 *   POST /shutdown           — 优雅关闭（需要X-Shutdown-Token头）
 */

const http = require('http');
const { homedir } = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { worker } = require('cluster');

// 强制UTF-8输出编码，防止Windows/NSSM GBK乱码
if (process.stdout) process.stdout.setDefaultEncoding('utf8');

// ── 配置 ───────────────────────────────────────────────────────────────
const PORT = 18792;
const SCRIPT_DIR = path.dirname(process.argv[1]);
const TASKS_DIR = path.join(SCRIPT_DIR, 'tasks');
const INBOX_DIR = path.join(SCRIPT_DIR, 'inbox');
const LOG_FILE = path.join(SCRIPT_DIR, '..', '..', 'logs', 'sidecar.log');
const SHUTDOWN_TOKEN = process.env.SIDECAR_SHUTDOWN_TOKEN || 'sansan-sidecar-shutdown-2026';
const ACS_LLM_BASE_URL = process.env.LLM_BASE_URL || 'http://127.0.0.1:18801/v1/chat/completions';
const COMPLETION_EVENT_TYPE = 'sc.completion';
const LOW_INFO_COMPLETION_SOURCES = new Set([
  'sidecar-child-close',
  'sidecar-done-poll',
  'sidecar-orphan-scan',
]);
const BOUNDED_COMPLETION_FIELDS = [
  'artifactPath',
  'outputPath',
  'diaryPath',
  'taskPath',
  'budgetUsed',
  'budgetExceeded',
  'rawOutputPolicy',
  'rawReportPath',
  'evidence_paths_read',
  'evidence_paths_not_read',
  'not_inspected',
  'tool_usage_summary',
  'sensitive_scan_result',
  'exitCode',
  'error',
];
const INBOX_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const SIDECAR_STARTED_AT_MS = Date.now();

// 子Agent启动队列 + 硬并发闸门。
// 目标是允许 100 路总量进入队列，但不允许 100 个 runner 同时压垮 ACS/LLM 入口。
const SPAWN_INTERVAL_MS = positiveInt(process.env.SC_SUBAGENT_SPAWN_INTERVAL_MS, 50);
const SUBAGENT_MAX_ACTIVE = positiveInt(process.env.SC_SUBAGENT_MAX_ACTIVE, 24);
const ACS_GATE_TIMEOUT_MS = positiveInt(process.env.SC_ACS_GATE_TIMEOUT_MS, 1500);
const ACS_GATE_RETRY_MS = positiveInt(process.env.SC_ACS_GATE_RETRY_MS, 1000);
const ACS_HEALTH_URL = acsHealthUrl();
const spawnQueue = [];
let spawnQueueTimer = null;
let lastSpawnGateLogAt = 0;

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function acsHealthUrl() {
  try {
    const url = new URL(ACS_LLM_BASE_URL);
    url.pathname = '/health';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch (_) {
    return 'http://127.0.0.1:18801/health';
  }
}

function activeSubagentCount() {
  let count = 0;
  for (const entry of runningTasks.values()) {
    if (entry && entry.kind === 'subagent') count++;
  }
  return count;
}

function logSpawnGate(level, msg, data) {
  const now = Date.now();
  if (now - lastSpawnGateLogAt < 10_000) return;
  lastSpawnGateLogAt = now;
  log(level, msg, data);
}

async function isAcsHealthy(timeoutMs = ACS_GATE_TIMEOUT_MS) {
  try {
    const res = await fetch(ACS_HEALTH_URL, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch (_) {
    return false;
  }
}

function scheduleSpawnQueue(delayMs) {
  if (spawnQueueTimer !== null || spawnQueue.length === 0) return;
  spawnQueueTimer = setTimeout(() => {
    spawnQueueTimer = null;
    void processSpawnQueue();
  }, Math.max(0, delayMs));
}

async function processSpawnQueue() {
  if (spawnQueue.length === 0) return;

  const active = activeSubagentCount();
  if (active >= SUBAGENT_MAX_ACTIVE) {
    logSpawnGate('INFO', 'Subagent spawn queue waiting for active slot', {
      queued: spawnQueue.length,
      active,
      maxActive: SUBAGENT_MAX_ACTIVE,
    });
    scheduleSpawnQueue(ACS_GATE_RETRY_MS);
    return;
  }

  const acsOk = await isAcsHealthy();
  if (!acsOk) {
    logSpawnGate('WARN', 'Subagent spawn queue waiting for ACS health', {
      queued: spawnQueue.length,
      active,
      maxActive: SUBAGENT_MAX_ACTIVE,
      acsHealthUrl: ACS_HEALTH_URL,
    });
    scheduleSpawnQueue(ACS_GATE_RETRY_MS);
    return;
  }

  const entry = spawnQueue.shift();
  if (entry) entry();
  if (spawnQueue.length > 0) {
    scheduleSpawnQueue(SPAWN_INTERVAL_MS);
  }
}

function enqueueSpawn(fn) {
  spawnQueue.push(fn);
  scheduleSpawnQueue(0);
}

// 任务默认超时：24小时
const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

// ── 日志 ───────────────────────────────────────────────────────────────
function log(level, msg, data) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) { /* 日志文件写失败不阻塞 */ }
}

function cleanLabel(value, max = 80) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

// ── 任务状态机 ────────────────────────────────────────────────────────
// 状态: pending → running → success|failed|cancelled|timeout

function taskFilePath(id) {
  return path.join(TASKS_DIR, `${id}.json`);
}

function generateId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function safeId(value, fallback = 'event') {
  const text = String(value || '').replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return (text || fallback).slice(0, 160);
}

function clipText(value, max = 1200) {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

function summarizeOutputFile(outputPath) {
  if (!outputPath) return '';
  try {
    const resolved = path.resolve(outputPath);
    if (!fs.existsSync(resolved)) return '';
    const st = fs.statSync(resolved);
    if (st.size > 512000) return `result file: ${resolved} (${st.size} bytes)`;
    const raw = fs.readFileSync(resolved, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.error) return clipText(parsed.error, 1200);
    if (parsed.summary) return clipText(parsed.summary, 1200);
    if (parsed.data) return clipText(parsed.data, 1200);
    return clipText(parsed, 1200);
  } catch {
    return '';
  }
}

function completionEventId(taskId, status) {
  return `sce-${safeId(taskId, 'task')}-${safeId(status || 'done')}`;
}

function inboxEventPath(eventId) {
  return path.join(INBOX_DIR, `${safeId(eventId)}.json`);
}

function readInboxEvent(eventIdOrPath) {
  try {
    const fp = eventIdOrPath.endsWith && eventIdOrPath.endsWith('.json')
      ? eventIdOrPath
      : inboxEventPath(eventIdOrPath);
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
}

function readJsonFile(filePath) {
  try {
    if (!filePath) return null;
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) return null;
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch {
    return null;
  }
}

function hasSuccessCompletionEvent(taskId) {
  const existing = readInboxEvent(completionEventId(taskId, 'success'));
  return existing?.status === 'success';
}

function hasSuccessOutputFile(outputPath) {
  const parsed = readJsonFile(outputPath);
  return parsed?.status === 'success';
}

function hasRecordedSuccessForTask(taskId, outputPath) {
  return hasSuccessCompletionEvent(taskId) || hasSuccessOutputFile(outputPath);
}

function hasMeaningfulInboxValue(value) {
  if (value === undefined || value === null || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function shouldPreserveInboxField(existingValue, incomingValue, source) {
  if (!hasMeaningfulInboxValue(existingValue)) return false;
  if (LOW_INFO_COMPLETION_SOURCES.has(source)) return true;
  return !hasMeaningfulInboxValue(incomingValue);
}

function saveInboxEvent(event) {
  ensureDir(INBOX_DIR);
  const existing = readInboxEvent(event.id);
  const now = new Date().toISOString();
  const source = event.source || 'sidecar';
  const sources = new Set([...(existing?.sources || []), source]);
  const existingSummary = existing?.summary || '';
  const incomingSummary = event.summary || '';
  const shouldPreserveSummary = existingSummary && (
    !incomingSummary ||
    LOW_INFO_COMPLETION_SOURCES.has(source)
  );
  const next = {
    ...(existing || {}),
    ...event,
    type: COMPLETION_EVENT_TYPE,
    summary: shouldPreserveSummary ? existingSummary : (incomingSummary || existingSummary),
    lifecycle: event.lifecycle || existing?.lifecycle || 'pending',
    receivedAt: existing?.receivedAt || event.receivedAt || now,
    updatedAt: now,
    deliveredAt: event.deliveredAt || existing?.deliveredAt || null,
    ackedAt: event.ackedAt || existing?.ackedAt || null,
    sources: [...sources],
  };
  for (const field of BOUNDED_COMPLETION_FIELDS) {
    const incoming = field === 'rawOutputPolicy'
      ? (event.rawOutputPolicy || event.raw_output_policy)
      : event[field];
    if (shouldPreserveInboxField(existing?.[field], incoming, source)) {
      next[field] = existing[field];
    }
  }
  if (
    existing?.sensitive_scan_result &&
    existing.sensitive_scan_result !== 'not_run' &&
    next.sensitive_scan_result === 'not_run'
  ) {
    next.sensitive_scan_result = existing.sensitive_scan_result;
  }
  const fp = inboxEventPath(next.id);
  const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, fp);
  return next;
}

function compactInboxEvent(event) {
  return {
    id: event.id,
    type: event.type,
    taskId: event.taskId,
    runId: event.runId || '',
    batchName: event.batchName || '',
    groupName: event.groupName || '',
    taskName: event.taskName || '',
    status: event.status,
    summary: event.summary || '',
    artifactPath: event.artifactPath || event.outputPath || event.diaryPath || '',
    outputPath: event.outputPath || '',
    diaryPath: event.diaryPath || '',
    taskPath: event.taskPath || '',
    budgetUsed: event.budgetUsed || null,
    budgetExceeded: event.budgetExceeded === true,
    rawOutputPolicy: event.rawOutputPolicy || event.raw_output_policy || 'no_full_dump',
    rawReportPath: event.rawReportPath || '',
    evidence_paths_read: event.evidence_paths_read || [],
    evidence_paths_not_read: event.evidence_paths_not_read || [],
    not_inspected: event.not_inspected || [],
    tool_usage_summary: event.tool_usage_summary || null,
    sensitive_scan_result: event.sensitive_scan_result || 'not_run',
    createdAt: event.createdAt || '',
    completedAt: event.completedAt || '',
    receivedAt: event.receivedAt || '',
    deliveredAt: event.deliveredAt || null,
    ackedAt: event.ackedAt || null,
    lifecycle: event.lifecycle || 'pending',
    sources: event.sources || [],
  };
}

function buildCompletionEvent(input) {
  const taskId = safeId(input.taskId || input.id || generateId(), 'task');
  const status = input.status || 'completed';
  const task = input.task || loadTask(taskId) || {};
  const now = new Date().toISOString();
  const source = input.source || 'sidecar';
  const outputPath = input.outputPath || task.outputPath || '';
  const diaryPath = input.diaryPath || task.diaryPath || '';
  const budgetUsed = input.budgetUsed || task.budgetUsed || null;
  const rawOutputPolicy = input.rawOutputPolicy || input.raw_output_policy || task.rawOutputPolicy || task.raw_output_policy || 'no_full_dump';
  const artifactSummary = summarizeOutputFile(outputPath);
  const lowInfoSource = LOW_INFO_COMPLETION_SOURCES.has(source);
  const visibleSummary = lowInfoSource
    ? (artifactSummary || input.summary || input.error || task.error)
    : (input.summary || artifactSummary || input.error || task.error);
  const visibleError = lowInfoSource && artifactSummary
    ? artifactSummary
    : (input.error || task.error || artifactSummary);
  const summary = clipText(
    visibleSummary ||
    `Subagent ${taskId} completed with status=${status}`,
    1600
  );

  return {
    id: input.eventId || completionEventId(taskId, status),
    type: COMPLETION_EVENT_TYPE,
    taskId,
    runId: input.runId || task.runId || '',
    batchName: cleanLabel(input.batchName || task.batchName || ''),
    groupName: cleanLabel(input.groupName || task.groupName || ''),
    taskName: cleanLabel(input.taskName || task.taskName || taskId),
    status,
    summary,
    artifactPath: input.artifactPath || outputPath || diaryPath || '',
    outputPath,
    diaryPath,
    taskPath: taskFilePath(taskId),
    budgetUsed,
    budgetExceeded: input.budgetExceeded === true || task.budgetExceeded === true,
    rawOutputPolicy,
    rawReportPath: input.rawReportPath || task.rawReportPath || '',
    evidence_paths_read: Array.isArray(input.evidence_paths_read) ? input.evidence_paths_read : (Array.isArray(task.evidence_paths_read) ? task.evidence_paths_read : []),
    evidence_paths_not_read: Array.isArray(input.evidence_paths_not_read) ? input.evidence_paths_not_read : (Array.isArray(task.evidence_paths_not_read) ? task.evidence_paths_not_read : []),
    not_inspected: Array.isArray(input.not_inspected) ? input.not_inspected : (Array.isArray(task.not_inspected) ? task.not_inspected : []),
    tool_usage_summary: input.tool_usage_summary || task.tool_usage_summary || null,
    sensitive_scan_result: input.sensitive_scan_result || task.sensitive_scan_result || 'not_run',
    createdAt: input.createdAt || task.createdAt || now,
    completedAt: input.completedAt || task.completedAt || now,
    receivedAt: now,
    lifecycle: 'pending',
    source,
    exitCode: input.exitCode ?? task.exitCode,
    error: clipText(visibleError || '', 800),
  };
}

function recordCompletionEvent(input) {
  try {
    const event = saveInboxEvent(buildCompletionEvent(input));
    log('INFO', `SC inbox completion recorded: task=${event.taskId} status=${event.status} event=${event.id}`);
    return event;
  } catch (e) {
    log('WARN', `SC inbox completion record failed: ${e.message}`);
    return null;
  }
}

function listInboxEvents(options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 200);
  const includeAcked = options.includeAcked === true;
  const undeliveredOnly = options.undeliveredOnly === true;
  ensureDir(INBOX_DIR);
  return fs.readdirSync(INBOX_DIR)
    .filter(f => f.endsWith('.json') && !f.endsWith('.tmp.json'))
    .map(f => readInboxEvent(path.join(INBOX_DIR, f)))
    .filter(Boolean)
    .filter(e => e.type === COMPLETION_EVENT_TYPE)
    .filter(e => includeAcked || !e.ackedAt)
    .filter(e => !undeliveredOnly || !e.deliveredAt)
    .sort((a, b) => (b.receivedAt || '').localeCompare(a.receivedAt || ''))
    .slice(0, limit)
    .map(compactInboxEvent);
}

function markInboxDelivered(eventIds, deliveredBy = 'sc-bridge') {
  const ids = Array.isArray(eventIds) ? eventIds : [];
  const delivered = [];
  for (const id of ids) {
    const existing = readInboxEvent(id);
    if (!existing || existing.ackedAt) continue;
    const next = saveInboxEvent({
      ...existing,
      deliveredAt: existing.deliveredAt || new Date().toISOString(),
      deliveredBy,
      deliveryAttempts: Number(existing.deliveryAttempts || 0) + 1,
      source: deliveredBy,
    });
    delivered.push(compactInboxEvent(next));
  }
  return delivered;
}

function ackInboxEvents(options = {}) {
  const now = new Date().toISOString();
  const eventIds = new Set((options.eventIds || []).map(String));
  const taskIds = new Set((options.taskIds || []).map(v => safeId(v, 'task')));
  const ackAll = options.all === true;
  const acked = [];
  ensureDir(INBOX_DIR);
  for (const f of fs.readdirSync(INBOX_DIR)) {
    if (!f.endsWith('.json') || f.endsWith('.tmp.json')) continue;
    const event = readInboxEvent(path.join(INBOX_DIR, f));
    if (!event || event.type !== COMPLETION_EVENT_TYPE || event.ackedAt) continue;
    if (!ackAll && !eventIds.has(event.id) && !taskIds.has(event.taskId)) continue;
    const next = saveInboxEvent({
      ...event,
      lifecycle: 'acked',
      ackedAt: now,
      ackedBy: options.ackedBy || 'sc-inbox-consumer',
      source: options.ackedBy || 'sc-inbox-consumer',
    });
    acked.push(compactInboxEvent(next));
  }
  return acked;
}

function inboxStats() {
  ensureDir(INBOX_DIR);
  const events = fs.readdirSync(INBOX_DIR)
    .filter(f => f.endsWith('.json') && !f.endsWith('.tmp.json'))
    .map(f => readInboxEvent(path.join(INBOX_DIR, f)))
    .filter(Boolean)
    .filter(e => e.type === COMPLETION_EVENT_TYPE);
  return {
    total: events.length,
    pending: events.filter(e => !e.ackedAt).length,
    undelivered: events.filter(e => !e.ackedAt && !e.deliveredAt).length,
    acked: events.filter(e => e.ackedAt).length,
    dir: INBOX_DIR,
  };
}

function loadTask(id) {
  try {
    const raw = fs.readFileSync(taskFilePath(id), 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

function saveTask(task) {
  const tmp = taskFilePath(task.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(task, null, 2));
  fs.renameSync(tmp, taskFilePath(task.id));
}

function listTasks() {
  try {
    return fs.readdirSync(TASKS_DIR)
      .filter(f => f.endsWith('.json') && !f.endsWith('.tmp.json'))
      .map(f => {
        try {
          const t = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), 'utf8'));
          return { id: t.id, command: t.command, status: t.status, createdAt: t.createdAt, completedAt: t.completedAt };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  } catch { return []; }
}

// ── 运行中的子进程表 ──────────────────────────────────────────────────
const runningTasks = new Map(); // id → { process, timeout }
const SUBAGENT_RUNNER = path.join(SCRIPT_DIR, 'subagent-runner.cjs');
const DEEPSEEK_API_KEY = getDeepSeekKey();
const TAVILY_API_KEY = getTavilyKey();
console.log('[Sidecar] TAVILY key loaded:', !!TAVILY_API_KEY, 'len:', TAVILY_API_KEY.length);
console.log('[Sidecar] DEEPSEEK key loaded:', !!DEEPSEEK_API_KEY, 'len:', DEEPSEEK_API_KEY.length);

// 从环境变量/mcp-tools.config.json/openclaw.json读取DeepSeek API Key
// 优先级：环境变量 > mcp-tools.config.json > openclaw.json > 空
function getDeepSeekKey() {
  // 优先环境变量（Gateway注入的活跃key）
  if (process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_API_KEY.length > 10) {
    return process.env.DEEPSEEK_API_KEY;
  }
  // 回退1: mcp-tools.config.json → apiKeys.deepseek
  try {
    const mcpConfigPath = path.join(SCRIPT_DIR, '..', 'mcp-tools.config.json');
    if (fs.existsSync(mcpConfigPath)) {
      let raw = fs.readFileSync(mcpConfigPath, 'utf8');
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      const cfg = JSON.parse(raw);
      const key = cfg?.apiKeys?.deepseek || '';
      if (key && key.length > 10) return key;
    }
  } catch {}
  // 回退2: openclaw.json → models.providers.deepseek.apiKey（兼容旧路径）
  try {
    const configPath = path.join(SCRIPT_DIR, '..', '..', '..', '..', '..', 'openclaw.json');
    if (fs.existsSync(configPath)) {
      let raw = fs.readFileSync(configPath, 'utf8');
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      const cfg = JSON.parse(raw);
      return cfg?.models?.providers?.deepseek?.apiKey || '';
    }
  } catch {}
  return '';
}

// 从openclaw.json读取Tavily API Key
// Tavily key 存在 plugins.entries.tavily.config.webSearch.apiKey
function getTavilyKey() {
  // 优先环境变量
  if (process.env.TAVILY_API_KEY && process.env.TAVILY_API_KEY.length > 10) {
    return process.env.TAVILY_API_KEY;
  }
  // 回退到文件读取（带BOM兼容）
  try {
    const configPath = path.join(SCRIPT_DIR, '..', '..', '..', '..', '..', 'openclaw.json');
    if (fs.existsSync(configPath)) {
      let raw = fs.readFileSync(configPath, 'utf8');
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // 清BOM
      const cfg = JSON.parse(raw);
      return cfg?.plugins?.entries?.tavily?.config?.webSearch?.apiKey || '';
    }
  } catch {}
  return '';
}

// ── 执行任务 ──────────────────────────────────────────────────────────
function executeTask(task) {
  task.status = 'running';
  task.startedAt = new Date().toISOString();
  task.output = [];
  saveTask(task);

  log('INFO', `Starting task ${task.id}: ${task.command}`);

  // 使用 spawn 而非 exec 以支持长时间运行和实时输出
  const child = spawn('cmd.exe', ['/c', task.command], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: task.cwd || undefined,
    env: { ...process.env, ...(task.env || {}) }
  });

  const entry = { process: child };
  runningTasks.set(task.id, entry);

  // 输出缓冲
  let stdoutBuf = '';
  let stderrBuf = '';

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    stdoutBuf += text;
    // 限制输出大小（每最多500KB）
    if (stdoutBuf.length > 512000) stdoutBuf = stdoutBuf.slice(-512000);
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    stderrBuf += text;
    if (stderrBuf.length > 512000) stderrBuf = stderrBuf.slice(-512000);
  });

  // 超时定时器
  const timeoutMs = task.timeout || DEFAULT_TIMEOUT_MS;
  const timeoutTimer = setTimeout(() => {
    if (runningTasks.has(task.id)) {
      log('WARN', `Task ${task.id} timed out after ${timeoutMs}ms`);
      child.kill('SIGTERM');
      // 2s后强杀
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) { /* cleanup, ignore */ }
      }, 2000);
    }
  }, timeoutMs);

  entry.timeout = timeoutTimer;

  child.on('close', (exitCode, signal) => {
    clearTimeout(timeoutTimer);
    runningTasks.delete(task.id);

    const now = new Date().toISOString();

    // 判断最终状态
    if (task.status === 'cancelling') {
      task.status = 'cancelled';
      task.cancelledAt = now;
    } else if (signal === 'SIGTERM') {
      task.status = 'timeout';
    } else if (exitCode === 0) {
      task.status = 'success';
    } else {
      task.status = 'failed';
    }

    task.completedAt = now;
    task.exitCode = exitCode;
    task.signal = signal || null;
    task.stdout = stdoutBuf.slice(-500000);
    task.stderr = stderrBuf.slice(-500000);
    saveTask(task);

    log('INFO', `Task ${task.id} completed: status=${task.status} exitCode=${exitCode}`);
  });
}

// ── 取消任务 ──────────────────────────────────────────────────────────
function cancelTask(task) {
  const entry = runningTasks.get(task.id);
  if (!entry) {
    // 任务未在运行中，直接标记已取消
    task.status = 'cancelled';
    task.cancelledAt = new Date().toISOString();
    saveTask(task);
    return true;
  }

  task.status = 'cancelling';
  saveTask(task);

  // 发送Ctrl+C信号（SIGINT），然后SIGTERM，最后强杀
  entry.process.kill('SIGINT');
  setTimeout(() => {
    try {
      entry.process.kill('SIGTERM');
    } catch (_) { /* cleanup, ignore */ }
  }, 3000);
  setTimeout(() => {
    try {
      entry.process.kill('SIGKILL');
    } catch (_) { /* cleanup, ignore */ }
  }, 5000);

  // 🔧 BUGFIX: 从 runningTasks 中移除条目, 防止 Map 膨胀
  runningTasks.delete(task.id);

  return true;
}

// ── retry任务 ──────────────────────────────────────────────────────────
function retryTask(oldTask) {
  const newTask = {
    id: generateId(),
    command: oldTask.command,
    cwd: oldTask.cwd,
    env: oldTask.env,
    timeout: oldTask.timeout,
    status: 'pending',
    retryOf: oldTask.id,
    createdAt: new Date().toISOString()
  };
  saveTask(newTask);
  // 延迟执行，让响应先返回
  setImmediate(() => executeTask(newTask));
  return newTask;
}

// ── 清理旧状态文件 ───────────────────────────────────────────────────
function cleanOldFiles() {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7天前的任务
  const inboxCutoff = Date.now() - INBOX_RETENTION_MS;
  let cleaned = 0;
  try {
    for (const f of fs.readdirSync(TASKS_DIR)) {
      if (!f.endsWith('.json') || f.endsWith('.tmp.json')) continue;
      const fp = path.join(TASKS_DIR, f);
      try {
        if (fs.statSync(fp).mtimeMs < cutoff) {
          fs.unlinkSync(fp);
          cleaned++;
        }
      } catch (_) { /* cleanup, ignore */ }
    }
  } catch (_) { /* cleanup, ignore */ }
  try {
    ensureDir(INBOX_DIR);
    for (const f of fs.readdirSync(INBOX_DIR)) {
      if (!f.endsWith('.json') || f.endsWith('.tmp.json')) continue;
      const fp = path.join(INBOX_DIR, f);
      try {
        const event = readInboxEvent(fp);
        if (event?.ackedAt && fs.statSync(fp).mtimeMs < inboxCutoff) {
          fs.unlinkSync(fp);
          cleaned++;
        }
      } catch (_) { /* cleanup, ignore */ }
    }
  } catch (_) { /* cleanup, ignore */ }
  if (cleaned > 0) log('INFO', `Cleaned ${cleaned} old task files`);
}

// ── HTTP 请求体解析 ──────────────────────────────────────────────────
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk.toString('utf8'));
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// ── JSON 响应辅助 ────────────────────────────────────────────────────
function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Shutdown-Token'
  });
  res.end(JSON.stringify(data));
}

// ── 路由 ──────────────────────────────────────────────────────────────
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const method = req.method;
  const pathname = url.pathname;

  // CORS preflight
  if (method === 'OPTIONS') {
    json(res, 204, {});
    return;
  }

  try {
    // POST /execute_task
    if (method === 'POST' && pathname === '/execute_task') {
      const body = await parseBody(req);
      if (!body.command || typeof body.command !== 'string') {
        json(res, 400, { error: 'Missing or invalid "command" field' });
        return;
      }
      if (body.command.length > 32000) {
        json(res, 400, { error: 'Command too long (max 32000 chars)' });
        return;
      }

      const task = {
        id: generateId(),
        command: body.command,
        cwd: body.cwd || null,
        env: body.env || null,
        timeout: Number(body.timeout) || DEFAULT_TIMEOUT_MS,
        status: 'pending',
        createdAt: new Date().toISOString()
      };
      saveTask(task);

      // 异步执行
      setImmediate(() => executeTask(task));

      log('INFO', `Task created: ${task.id}`);
      json(res, 201, { id: task.id, command: task.command, status: task.status });
      return;
    }

    // POST /spawn_subagent — 提交子Agent任务
    if (method === 'POST' && pathname === '/spawn_subagent') {
      const body = await parseBody(req);
      // 🔒 安全校验：禁止外部覆盖系统API Key
      if (body._apiKey) {
        json(res, 403, { error: 'Parameter _apiKey is reserved and cannot be set externally' });
        return;
      }
      if (!body.prompt || typeof body.prompt !== 'string') {
        json(res, 400, { error: 'Missing or invalid "prompt" field' });
        return;
      }

      // 🔒 安全校验：taskId 可选，支持复用（传已有 taskId 则继承上下文）
      const taskId = body.taskId || ('sa-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6));
      const depth = Number(body.depth) || 0;
      const maxDepth = Number(body.maxDepth) || 0;
      const maxChildren = Number(body.maxChildren) || 2;
      const model = body.model || 'deepseek/deepseek-v4-flash';
      const timeout = Number(body.timeout) || 300;
      const maxRounds = Number(body.maxRounds) || 20;
      const batchName = cleanLabel(body.batchName || '');
      const groupName = cleanLabel(body.groupName || body.name || '');
      const taskName = cleanLabel(body.taskName || groupName || batchName || taskId);
      const runId = cleanLabel(body.runId || batchName || '');
      const runDir = typeof body.runDir === 'string' ? body.runDir : '';
      const budgets = body.budgets && typeof body.budgets === 'object' ? body.budgets : {};
      const taskCard = body.taskCard && typeof body.taskCard === 'object' ? body.taskCard : null;
      const toolPolicy = body.toolPolicy || body.tool_policy || taskCard?.toolPolicy || taskCard?.tool_policy || null;
      const rawOutputPolicy = body.raw_output_policy || body.rawOutputPolicy || budgets.raw_output_policy || 'no_full_dump';
      const codeMode = body.codeMode === true || /修|改代码|edit_code|修复|fix|改bug/.test(body.prompt || '');
      // 杉哥2026-06-09: 自动识别修代码任务→timeout=600/manualOverride通过body.timeout传入
      // 🔧 BUGFIX: codeMode检测到时显式timeout不应覆盖翻倍保护，取max保证至少600s
      const effectiveTimeout = codeMode ? Math.max(timeout, 600) : timeout;
      const tools = body.tools || [];
      const outputPath = body.outputPath || path.join(SCRIPT_DIR, '..', '..', '..', '..', 'memory', 'task-states', `${taskId}.json`);
      const diaryPath = body.diaryPath || path.join(SCRIPT_DIR, '..', '..', '..', '..', 'memory', 'dialog', 'subagent', `${taskId}.md`);

      // 创建任务记录
      const task = {
        id: taskId,
        type: 'subagent',
        prompt: body.prompt.substring(0, 500),
        taskName, batchName, groupName,
        runId, runDir,
        rawOutputPolicy,
        taskCard,
        toolPolicy,
        budgets,
        collector: body.collector || null,
        acceptance: body.acceptance || null,
        evidence: body.evidence || null,
        notifyPolicy: body.notifyPolicy || 'notify-only',
        guardMode: body.guardMode || '',
        guardWarnings: body.guardWarnings || [],
        depth, maxDepth, maxChildren,
        model, timeout,
        status: 'pending',
        outputPath,
        createdAt: new Date().toISOString()
      };
      saveTask(task);

      // 提前准备key（队列执行时再用）
      const liveDeepSeekKey = getDeepSeekKey();
      const liveTavilyKey = getTavilyKey();
      // 🔒 安全修复：只从环境变量读取API Key，禁止调用者通过body._apiKey注入
      const useApiKey = liveDeepSeekKey || '';


      // 读取x0x配置（子Agent实时通信用，daemon不在就静默跳过）
      let x0xConfig = {};
      try {
        // 从USERPROFILE动态获取用户目录，兼容SYSTEM/NSSM账号
        const x0xName = process.env.X0X_NAME || 'sssan';
        const userDataRoot = process.env.USERPROFILE || homedir();
        const x0xDir = process.env.X0X_DATA_DIR || path.join(userDataRoot, 'AppData', 'Roaming', 'x0x-' + x0xName);
        if (fs.existsSync(path.join(x0xDir, 'api.port'))) {
          const apiAddr = fs.readFileSync(path.join(x0xDir, 'api.port'), 'utf8').trim();
          const x0xToken = fs.readFileSync(path.join(x0xDir, 'api-token'), 'utf8').trim();
          x0xConfig = { x0xApiUrl: `http://${apiAddr}`, x0xToken, x0xTopic: taskId };
        }
        if (x0xConfig.x0xApiUrl) log('INFO', `x0x桥接ready: ${x0xConfig.x0xApiUrl} topic=${x0xConfig.x0xTopic}`);
      } catch (e) { log('WARN', `x0x桥接不可用: ${e.message}`); }
const params = {
        taskId, prompt: body.prompt,
        tools, outputPath, diaryPath, flagDir: path.resolve(__dirname, '..', '..', '..', '..', 'memory', 'dialog', 'subagent'),
        taskName, batchName, groupName,
        runId, runDir,
        rawOutputPolicy,
        taskCard,
        toolPolicy,
        budgets,
        collector: body.collector || null,
        acceptance: body.acceptance || null,
        evidence: body.evidence || null,
        notifyPolicy: body.notifyPolicy || 'notify-only',
        guardMode: body.guardMode || '',
        guardWarnings: body.guardWarnings || [],
        depth, maxDepth, maxChildren,
        apiKey: useApiKey,
        model, timeout: effectiveTimeout, maxRounds: codeMode ? Math.max(maxRounds, 100) : maxRounds, codeMode,
        ...x0xConfig
      };

      // 加入启动队列，每隔50ms启动一个，防SSE连接风暴
      enqueueSpawn(() => {
        const child = spawn(process.execPath, [SUBAGENT_RUNNER], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, LLM_BASE_URL: ACS_LLM_BASE_URL, DEEPSEEK_API_KEY: useApiKey, TAVILY_API_KEY: liveTavilyKey, X0X_API_URL: x0xConfig.x0xApiUrl || '', X0X_TOKEN: x0xConfig.x0xToken || '', X0X_TOPIC: x0xConfig.x0xTopic || '' }
        });
        // 通过stdin传参(绕过Windows命令行8191字符限制)
        child.stdin.write(JSON.stringify(params));
        child.stdin.end();

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', d => stdout += d.toString());
        child.stderr.on('data', d => stderr += d.toString());

        const timer = setTimeout(() => {
          try { child.kill('SIGTERM'); } catch {}
          task.status = 'timeout';
          task.completedAt = new Date().toISOString();
          task.stderr = stderr.slice(-10000);
          saveTask(task);
        }, (timeout + 30) * 1000);

        // 🔧 BUGFIX: 子Agent进程加入 runningTasks 追踪，防止孤儿进程泄漏
        runningTasks.set(taskId, { process: child, timeout: timer, kind: 'subagent' });
        task.pid = child.pid;
        task.status = 'running';
        saveTask(task);

        child.on('close', (code) => {
          clearTimeout(timer);
          runningTasks.delete(taskId);
          scheduleSpawnQueue(0);
          const childExitCode = code === null || code === undefined ? -1 : code;
          const successAlreadyRecorded = childExitCode !== 0 && hasRecordedSuccessForTask(taskId, outputPath);
          task.status = successAlreadyRecorded ? 'success' : childExitCode === 0 ? 'success' : childExitCode === 42 ? 'stalled' : 'failed';
          task.exitCode = successAlreadyRecorded ? 0 : childExitCode;
          if (successAlreadyRecorded) {
            task.childExitCode = childExitCode;
            task.childCloseWarning = `child closed nonzero after success artifact was recorded: ${childExitCode}`;
          }
          task.completedAt = new Date().toISOString();
          task.stdout = stdout.slice(-10000);
          task.stderr = stderr.slice(-10000);
          saveTask(task);
          log('INFO', `Subagent ${taskId} completed: status=${task.status} exitCode=${code}`);

          if (successAlreadyRecorded) {
            log('WARN', `Subagent ${taskId} child close exitCode=${childExitCode} ignored because success artifact/event already exists`);
            if (!hasSuccessCompletionEvent(taskId)) {
              recordCompletionEvent({
                source: 'sidecar-child-close',
                taskId,
                status: 'success',
                taskName, batchName, groupName,
                outputPath, diaryPath,
                runId,
                rawOutputPolicy,
                completedAt: task.completedAt,
                exitCode: 0,
              });
            }
            return;
          }

          recordCompletionEvent({
            source: 'sidecar-child-close',
            taskId,
            status: task.status,
            taskName, batchName, groupName,
            outputPath, diaryPath,
            runId,
            rawOutputPolicy,
            completedAt: task.completedAt,
            exitCode: code,
            error: task.stderr,
          });
        });

        child.on('error', (err) => {
          clearTimeout(timer);
          runningTasks.delete(taskId);
          scheduleSpawnQueue(0);
          task.status = 'failed';
          task.error = err.message;
          task.completedAt = new Date().toISOString();
          saveTask(task);
          log('ERROR', `Subagent ${taskId} spawn error: ${err.message}`);
          recordCompletionEvent({
            source: 'sidecar-spawn-error',
            taskId,
            status: 'failed',
            taskName, batchName, groupName,
            outputPath, diaryPath,
            runId,
            rawOutputPolicy,
            completedAt: task.completedAt,
            error: err.message,
          });
        });

        log('INFO', `Subagent spawned: ${taskId} depth=${depth}/${maxDepth} model=${model}`);
      });

      // 立即返回201，不等待队列执行
      json(res, 201, {
        id: taskId,
        status: 'pending',
        depth, maxDepth, maxChildren,
        model, outputPath, diaryPath,
        checkStatus: `/task/${taskId}`
      });
      return;
    }

    // SC inbox: completion event ingress. This is SC-owned, not user/assistant spoofing.
    if (method === 'POST' && (pathname === '/inbox/completion' || pathname === '/sc/inbox/completion')) {
      const body = await parseBody(req);
      if (!body.taskId || typeof body.taskId !== 'string') {
        json(res, 400, { error: 'Missing or invalid "taskId" field' });
        return;
      }
      const event = recordCompletionEvent({ ...body, source: body.source || 'http-completion' });
      if (!event) {
        json(res, 500, { error: 'Failed to record completion event' });
        return;
      }
      json(res, 201, { ok: true, event: compactInboxEvent(event) });
      return;
    }

    // SC inbox: list unacked completion events. undeliveredOnly=true is for bridge polling.
    if (method === 'GET' && (pathname === '/inbox/pending' || pathname === '/sc/inbox/pending')) {
      const events = listInboxEvents({
        limit: url.searchParams.get('limit') || 20,
        includeAcked: url.searchParams.get('includeAcked') === 'true',
        undeliveredOnly: url.searchParams.get('undeliveredOnly') === 'true',
      });
      json(res, 200, { count: events.length, events, stats: inboxStats() });
      return;
    }

    // SC inbox: mark events as delivered to a consumer, but keep them unacked.
    if (method === 'POST' && (pathname === '/inbox/delivered' || pathname === '/sc/inbox/delivered')) {
      const body = await parseBody(req);
      const delivered = markInboxDelivered(body.eventIds || [], body.deliveredBy || 'sc-bridge');
      json(res, 200, { ok: true, count: delivered.length, events: delivered, stats: inboxStats() });
      return;
    }

    // SC inbox: ack only after a user-visible report or an explicit consumer decision.
    if (method === 'POST' && (pathname === '/inbox/ack' || pathname === '/sc/inbox/ack')) {
      const body = await parseBody(req);
      const acked = ackInboxEvents(body);
      json(res, 200, { ok: true, count: acked.length, events: acked, stats: inboxStats() });
      return;
    }

    if (method === 'GET' && (pathname === '/inbox/stats' || pathname === '/sc/inbox/stats')) {
      json(res, 200, inboxStats());
      return;
    }

    // GET /task/:id 或 POST /task/:id/:action
    const taskMatch = pathname.match(/^\/task\/([^/]+)$/);
    const taskActionMatch = pathname.match(/^\/task\/([^/]+)\/(cancel|retry)$/);

    if (taskMatch && method === 'GET') {
      const task = loadTask(taskMatch[1]);
      if (!task) { json(res, 404, { error: 'Task not found' }); return; }
      json(res, 200, task);
      return;
    }

    if (taskActionMatch) {
      const taskId = taskActionMatch[1];
      const action = taskActionMatch[2];
      const task = loadTask(taskId);
      if (!task) { json(res, 404, { error: 'Task not found' }); return; }

      if (action === 'cancel') {
        // 已经在终态则不允许取消
        if (['success', 'failed', 'cancelled', 'timeout'].includes(task.status)) {
          json(res, 400, { error: `Task already in terminal state: ${task.status}` });
          return;
        }
        cancelTask(task);
        log('INFO', `Task cancelled: ${taskId}`);
        json(res, 200, { id: taskId, status: 'cancelling' });
        return;
      }

      if (action === 'retry') {
        if (task.status !== 'failed' && task.status !== 'timeout' && task.status !== 'cancelled') {
          json(res, 400, { error: `Can only retry completed tasks, current status: ${task.status}` });
          return;
        }
        const newTask = retryTask(task);
        log('INFO', `Task retry: ${taskId} → ${newTask.id}`);
        json(res, 201, { id: newTask.id, retryOf: taskId, command: newTask.command, status: newTask.status });
        return;
      }
    }

    // GET /tasks
    if (method === 'GET' && pathname === '/tasks') {
      const tasks = listTasks();
      json(res, 200, { count: tasks.length, tasks });
      return;
    }

    // GET /health
    if (pathname === '/health') {
      json(res, 200, {
        status: 'ok',
        uptime: process.uptime(),
        runningTasks: runningTasks.size,
        subagentQueue: {
          queued: spawnQueue.length,
          active: activeSubagentCount(),
          maxActive: SUBAGENT_MAX_ACTIVE,
          spawnIntervalMs: SPAWN_INTERVAL_MS,
          acsGateRetryMs: ACS_GATE_RETRY_MS,
          acsGateTimeoutMs: ACS_GATE_TIMEOUT_MS,
          acsHealthUrl: ACS_HEALTH_URL,
        },
        pid: process.pid,
        timestamp: new Date().toISOString()
      });
      return;
    }

    // POST /shutdown
    if (method === 'POST' && pathname === '/shutdown') {
      const token = req.headers['x-shutdown-token'];
      if (token !== SHUTDOWN_TOKEN) {
        json(res, 403, { error: 'Invalid shutdown token' });
        return;
      }
      json(res, 200, { status: 'shutting_down' });
      // 优雅关闭
      log('INFO', 'Shutdown requested, killing all running tasks...');
      for (const [id, entry] of runningTasks) {
        try {
          entry.process.kill('SIGTERM');
          clearTimeout(entry.timeout);
        } catch (_) { /* cleanup, ignore */ }
      }
      setTimeout(() => process.exit(0), 1000);
      return;
    }

    // 404
    json(res, 404, { error: `Not found: ${method} ${pathname}` });

  } catch (err) {
    log('ERROR', `Request error: ${err.message}`, { url: req.url });
    json(res, 500, { error: 'Internal server error', detail: err.message });
  }
}

// ── 启动 ──────────────────────────────────────────────────────────────
function start() {
  // 确保状态目录存在
  ensureDir(TASKS_DIR);
  ensureDir(INBOX_DIR);

  // 启动时清理旧文件（7天前的）
  cleanOldFiles();

  // 启动HTTP服务器
  const server = http.createServer(handleRequest);

  server.on('error', (err) => {
    log('FATAL', `Server error: ${err.message}`);
    if (err.code === 'EADDRINUSE') {
      log('FATAL', `Port ${PORT} is already in use!`);
    }
    process.exit(1);
  });

  server.listen(PORT, '127.0.0.1', () => {
    log('INFO', `sc Sidecar running on http://127.0.0.1:${PORT}`);
    log('INFO', `Tasks directory: ${TASKS_DIR}`);
    log('INFO', `SC inbox directory: ${INBOX_DIR}`);
    log('INFO', `PID: ${process.pid}`);

    // 如果通过NSSM运行，通知NSSM服务已启动
    if (process.env.NSSM_CONFIGURATION) {
      log('INFO', 'Running under NSSM service manager');
    }

    // 启动时扫描 tasks 目录，将 pending 状态的任务重新加入队列
    // 这是关键设计：重启后任务仍在，需要恢复执行
    try {
      const files = fs.readdirSync(TASKS_DIR).filter(f => f.endsWith('.json') && !f.endsWith('.tmp.json'));
      let recoveredCount = 0;
      for (const f of files) {
        try {
          const fp = path.join(TASKS_DIR, f);
          const task = JSON.parse(fs.readFileSync(fp, 'utf8'));
          if (task.status === 'pending') {
            // 重新加入执行队列
            enqueueSpawn(() => executeTask(task));
            recoveredCount++;
          }
        } catch (readErr) {
          log('WARN', `无法读取任务文件 ${f}: ${readErr.message}`);
        }
      }
      if (recoveredCount > 0) {
        log('INFO', `从重启中恢复了 ${recoveredCount} 个 pending 任务`);
      }

      // 🔥 孤儿检测: 扫描running状态任务，PID不存在→标orphaned
      let orphanedCount = 0;
      for (const f of files) {
        try {
          const fp = path.join(TASKS_DIR, f);
          const task = JSON.parse(fs.readFileSync(fp, 'utf8'));
          if (task.status === 'running' && task.pid) {
            try {
              process.kill(task.pid, 0); // 只检查信号，不杀进程
            } catch {
              // PID不存在，孤儿
              task.status = 'orphaned';
              task.completedAt = new Date().toISOString();
              saveTask(task);
              // 创建DONE标记让主agent知道
              const subagentDoneDir = path.join(homedir(), '.openclaw', 'workspace', 'memory', 'dialog', 'subagent');
              try {
                fs.mkdirSync(subagentDoneDir, { recursive: true });
                fs.writeFileSync(path.join(subagentDoneDir, 'DONE_' + task.id + '_orphaned'), JSON.stringify({
                  taskId: task.id, status: 'orphaned', reason: 'sidecar重启后子Agent进程已消失',
                  completedAt: new Date().toISOString()
                }));
              } catch(e) { log('WARN', `孤儿DONE标记创建失败: ${e.message}`); }
              recordCompletionEvent({
                source: 'sidecar-orphan-scan',
                taskId: task.id,
                status: 'orphaned',
                task,
                completedAt: task.completedAt,
                error: 'sidecar重启后子Agent进程已消失',
              });
              orphanedCount++;
            }
          }
        } catch (readErr) { /* skip */ }
      }
      if (orphanedCount > 0) {
        log('INFO', `检测到 ${orphanedCount} 个孤儿任务，已标记`);
      }
    } catch (scanErr) {
      log('WARN', `启动时扫描 tasks 目录失败: ${scanErr.message}`);
    }
  });

  // 优雅退出
  const shutdown = () => {
    log('INFO', 'Received shutdown signal, stopping...');
    // 不杀运行中的任务——这是关键设计：重启后任务仍在
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // 每6小时清理旧任务文件
  setInterval(cleanOldFiles, 6 * 60 * 60 * 1000);

  // ====== DONE标记轮询: 每3秒检查子Agent完成状态 ======
  const subagentDir = path.join(homedir(), '.openclaw', 'workspace', 'memory', 'dialog', 'subagent');
  let processedDones = new Set();
  setInterval(() => {
    try {
      const files = fs.readdirSync(subagentDir).filter(f => f.startsWith('DONE_'));
      for (const file of files) {
        if (processedDones.has(file)) continue;
        const donePath = path.join(subagentDir, file);
        try {
          if (fs.statSync(donePath).mtimeMs < SIDECAR_STARTED_AT_MS - 5000) {
            processedDones.add(file);
            continue;
          }
        } catch {}
        processedDones.add(file);
        // 解析taskId和状态
        const match = file.match(/^DONE_(.+)_(success|failed|stalled|orphaned)$/);
        if (!match) continue;
        const taskId = match[1];
        const status = match[2];
        // 读task文件获取完整结果
        const taskPath = path.join(__dirname, 'tasks', taskId + '.json');
        let detail = '';
        if (fs.existsSync(taskPath)) {
          try {
            const task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
            detail = task.stderr || '';
          } catch {}
        }
        if (!fs.existsSync(inboxEventPath(completionEventId(taskId, status)))) {
          recordCompletionEvent({
            source: 'sidecar-done-poll',
            taskId,
            status,
            completedAt: new Date().toISOString(),
            error: detail,
          });
        }
        process.stderr.write(`[轮询] 子Agent完成: ${taskId} status=${status} detail=${detail.substring(0,200)}\n`);
      }
      // 定期清理已处理的记录（保留最近1000条）
      if (processedDones.size > 1000) {
        const arr = [...processedDones];
        processedDones = new Set(arr.slice(-500));
      }
    } catch (e) {
      process.stderr.write(`[轮询] DONE检查错误: ${e.message}\n`);
    }
  }, 3000);
}

// ── 启动（如果直接运行） ─────────────────────────────────────────────
if (require.main === module) {
  start();
}

module.exports = { start, executeTask, cancelTask, retryTask, loadTask, listTasks };
