#!/usr/bin/env node
/**
 * 🦞 sc 子Agent运行器
 *
 * 由 sidecar-server.cjs 通过 spawn 启动的独立Node.js进程。
 * 生命周期:接收参数 → LLM推理 → (可选)工具调用 → 写结果 → 退出
 *
 * 传入参数:JSON字符串(命令行参数或stdin)
 * 结果输出:写到 outputPath 指定的文件
 * 日记输出:写到 diaryPath 指定的文件
 *
 * 安全约束:
 *   maxDepth=0, maxChildren=2
 *   禁止危险工具(core_abort/cpu_safetyKill等)
 *   工具失败3次熔断换路
 *   关原生工具(exec/write/edit/web_search等),CPU有的用CPU平替
 *   保留原生工具:browser(登录态)、message(发通知)
 */

// ── 配置 ───────────────────────────────────────────────────────────────
// 子agent禁止调用的工具列表 — 从 mcp-tools.config.json 动态加载
// 原生工具硬拦截（子Agent无原生工具,此处为双保险）
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ACS_LLM_BASE_URL = 'http://127.0.0.1:18801/v1/chat/completions';
let SUBAGENT_BLOCKED = [];
try {
  const pkgDir = path.dirname(__dirname);
  const configPath = path.join(pkgDir, 'mcp-tools.config.json');
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  SUBAGENT_BLOCKED = cfg.subagent?.blocked || [];
  console.log('[subagent] mcp-tools.config.json 加载成功:', SUBAGENT_BLOCKED.length, '个blocked工具');
} catch (e) {
  console.error('[subagent] ⚠️ 无法加载mcp-tools.config.json，使用安全兜底列表:', e.message);
  SUBAGENT_BLOCKED = [
    'emergencyStop', 'spawnAutonomousAgentCluster',
    'spawnEmergencyApiAgents'
  ];
}

const DANGEROUS_NATIVE_TOOLS = [
  // 原生工具兜底拦截（子Agent不自带原生工具，此处为安全冗余）
  'exec', 'write', 'read', 'edit',
  'sessions_spawn',
  'web_search', 'web_fetch',
  'memory_search', 'memory_get'
];
const MAX_TOOL_RETRIES = 3;
const MCP_URL = 'http://127.0.0.1:18790';
const SIDECAR_URL = 'http://127.0.0.1:18792';
const toolCacheByDepth = {}; // 按depth分级的工具列表缓存

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const SUBAGENT_LLM_TIMEOUT_MS = positiveInt(process.env.SC_SUBAGENT_LLM_TIMEOUT_MS, 300000);
const SUBAGENT_MCP_CONNECT_TIMEOUT_MS = positiveInt(process.env.SC_SUBAGENT_MCP_CONNECT_TIMEOUT_MS, 15000);
const SUBAGENT_MCP_TOOL_TIMEOUT_MS = positiveInt(process.env.SC_SUBAGENT_MCP_TOOL_TIMEOUT_MS, 120000);
const SUBAGENT_NOTIFY_TIMEOUT_MS = positiveInt(process.env.SC_SUBAGENT_NOTIFY_TIMEOUT_MS, 2000);

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
      throw new Error(`fetch timeout after ${timeoutMs}ms: ${url}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function readWithTimeout(reader, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function toAsciiSafeHeaderValue(value, fallback = '', maxChars = 160) {
  const raw = value === undefined || value === null ? '' : String(value);
  const cleaned = raw.replace(/[\u0000-\u001F\u007F]+/g, ' ').trim();
  if (!cleaned) return fallback;

  if (/^[A-Za-z0-9._~:-]+$/.test(cleaned)) {
    return cleaned.length <= maxChars
      ? cleaned
      : `sha256.${crypto.createHash('sha256').update(cleaned, 'utf8').digest('hex').slice(0, 32)}`;
  }

  if (/^[\x20-\x7E]+$/.test(cleaned)) {
    const compact = cleaned.replace(/[^A-Za-z0-9._~:-]+/g, '_').replace(/^_+|_+$/g, '');
    if (compact && compact.length <= maxChars) return compact;
  }

  const encoded = Buffer.from(cleaned, 'utf8').toString('base64url');
  if (encoded.length <= maxChars - 5) return `b64u.${encoded}`;

  return `sha256.${crypto.createHash('sha256').update(cleaned, 'utf8').digest('hex').slice(0, 32)}`;
}

function normalizePolicyPath(value) {
  if (typeof value !== 'string' || value.trim() === '') return '';
  try {
    return path.resolve(value).replace(/\\/g, '/').toLowerCase();
  } catch {
    return value.replace(/\\/g, '/').toLowerCase();
  }
}

function normalizeToolRule(rule) {
  if (typeof rule === 'string') {
    const [tool, action] = rule.split('.', 2);
    return {
      tool: tool || '',
      actions: action ? [action] : [],
      paths: [],
      maxCalls: null,
    };
  }
  if (!isPlainObject(rule)) return null;
  const tool = rule.tool || rule.name || rule.toolName || '';
  const actions = asArray(rule.actions || rule.action).map(String).filter(Boolean);
  const paths = asArray(rule.paths || rule.path || rule.allowedPaths || rule.allowed_paths).map(normalizePolicyPath).filter(Boolean);
  const maxCalls = Number(rule.maxCalls || rule.max_calls || 0) || null;
  return { tool, actions, paths, maxCalls };
}

function normalizeToolPolicy(policy) {
  if (!isPlainObject(policy)) return { enabled: false, mode: 'default', rules: [], maxToolCalls: null, violation: 'fail_task' };
  const rawRules = [
    ...asArray(policy.allowed || policy.allow || policy.rules),
    ...asArray(policy.allowedTools || policy.allowed_tools),
  ];
  const rules = rawRules.map(normalizeToolRule).filter(r => r && r.tool);
  const allowedPaths = asArray(policy.allowedPaths || policy.allowed_paths).map(normalizePolicyPath).filter(Boolean);
  if (allowedPaths.length > 0) {
    for (const rule of rules) {
      if (rule.tool === 'fileManager' && rule.paths.length === 0) rule.paths = allowedPaths;
    }
  }
  const mode = policy.mode || (rules.length > 0 ? 'allowlist' : 'default');
  return {
    enabled: mode === 'allowlist' || rules.length > 0,
    mode,
    rules,
    maxToolCalls: Number(policy.maxToolCalls || policy.max_tool_calls || 0) || null,
    violation: policy.violation || policy.onViolation || policy.on_violation || 'fail_task',
  };
}

function toolPolicySummary(policy) {
  const normalized = normalizeToolPolicy(policy);
  if (!normalized.enabled) return null;
  return {
    mode: normalized.mode,
    allowed: normalized.rules.map(rule => ({
      tool: rule.tool,
      actions: rule.actions,
      paths: rule.paths,
      maxCalls: rule.maxCalls,
    })),
    maxToolCalls: normalized.maxToolCalls,
    violation: normalized.violation,
  };
}

function filterToolsByPolicy(tools, policy) {
  const normalized = normalizeToolPolicy(policy);
  if (!normalized.enabled) return tools;
  const allowedToolNames = new Set(normalized.rules.map(rule => rule.tool));
  return tools
    .filter(tool => allowedToolNames.has(tool.name))
    .map(tool => {
      const matchingRules = normalized.rules.filter(rule => rule.tool === tool.name);
      const allowedActions = [...new Set(matchingRules.flatMap(rule => rule.actions))].filter(Boolean);
      if (allowedActions.length === 0) return tool;
      const schema = JSON.parse(JSON.stringify(tool.inputSchema || { type: 'object', properties: {} }));
      if (schema.properties?.action) {
        schema.properties.action.enum = allowedActions;
      }
      return { ...tool, inputSchema: schema };
    });
}

function validateToolPolicyCall(policy, toolName, args, state) {
  const normalized = normalizeToolPolicy(policy);
  if (!normalized.enabled) return { ok: true };
  if (normalized.maxToolCalls !== null && state.totalCalls >= normalized.maxToolCalls) {
    return {
      ok: false,
      reason: `tool_policy_violation:max_tool_calls:${state.totalCalls + 1}>${normalized.maxToolCalls}`,
      detail: { toolName, args },
    };
  }
  const matchingRules = normalized.rules.filter(rule => rule.tool === toolName);
  if (matchingRules.length === 0) {
    return {
      ok: false,
      reason: `tool_policy_violation:tool_not_allowed:${toolName}`,
      detail: { toolName, args },
    };
  }
  const action = args?.action ? String(args.action) : '';
  const actionRules = matchingRules.filter(rule => rule.actions.length === 0 || rule.actions.includes(action));
  if (actionRules.length === 0) {
    return {
      ok: false,
      reason: `tool_policy_violation:action_not_allowed:${toolName}.${action || 'call'}`,
      detail: { toolName, action, args },
    };
  }
  const rulesWithPaths = actionRules.filter(rule => rule.paths.length > 0);
  if (rulesWithPaths.length > 0) {
    const actualPath = normalizePolicyPath(args?.path || args?.dest || args?.target || '');
    const pathAllowed = rulesWithPaths.some(rule => rule.paths.includes(actualPath));
    if (!pathAllowed) {
      return {
        ok: false,
        reason: `tool_policy_violation:path_not_allowed:${toolName}.${action || 'call'}`,
        detail: { toolName, action, path: args?.path || args?.dest || args?.target || '' },
      };
    }
  }
  const specificMax = actionRules.map(rule => rule.maxCalls).filter(v => v !== null);
  if (specificMax.length > 0) {
    const max = Math.min(...specificMax);
    const key = `${toolName}.${action || 'call'}`;
    const count = state.byRule.get(key) || 0;
    if (count >= max) {
      return {
        ok: false,
        reason: `tool_policy_violation:rule_max_calls:${key}:${count + 1}>${max}`,
        detail: { toolName, action, args },
      };
    }
  }
  return { ok: true, action: action || 'call' };
}

function recordToolPolicyCall(state, toolName, action) {
  state.totalCalls++;
  const key = `${toolName}.${action || 'call'}`;
  state.byRule.set(key, (state.byRule.get(key) || 0) + 1);
}

function buildToolBudgetExhaustedHint(policy, state) {
  const normalized = normalizeToolPolicy(policy);
  if (!normalized.enabled || normalized.maxToolCalls === null) return '';
  if (state.totalCalls < normalized.maxToolCalls) return '';
  return [
    '',
    '[TOOL_POLICY_BUDGET_EXHAUSTED]',
    `Allowed tool calls used: ${state.totalCalls}/${normalized.maxToolCalls}.`,
    'Do not call any tool again. Return the final bounded JSON answer now.',
    'If required evidence was read, use that evidence. If not, report not_inspected according to the task contract.',
  ].join('\n');
}

function isToolBudgetExhausted(policy, state) {
  const normalized = normalizeToolPolicy(policy);
  return normalized.enabled &&
    normalized.maxToolCalls !== null &&
    state.totalCalls >= normalized.maxToolCalls;
}

function appendToolPolicyHint(content, hint, maxLength = 50000) {
  if (!hint) return content;
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  if (text.length + hint.length <= maxLength) return `${text}${hint}`;
  const keep = Math.max(0, maxLength - hint.length - 20);
  return `${text.substring(0, keep)}\n[tool output clipped]\n${hint}`;
}

function throwToolPolicyViolation(check) {
  const err = new Error(check.reason || 'tool_policy_violation');
  err.toolPolicyViolation = true;
  err.toolPolicyDetail = check.detail || {};
  throw err;
}

// ── MCP 并发控制(令牌桶)───────────────
// 限制同一子agent同时最多2个MCP请求在跑
// 避免MCP SSE单连接被并发冲垮
const MCP_MAX_CONCURRENCY = 3; // 单子agent并发MCP调用上限(session复用后够用)
const STALL_TIMEOUT_MS = 180_000; // 僵死检测: 3分钟无工具成功→自动熔断
const HEARTBEAT_INTERVAL_ROUNDS = 1; // 心跳间隔(轮)
let _mcpActiveCalls = 0;
const _mcpWaitQueue = [];

function acquireMCP() {
  return new Promise(resolve => {
    if (_mcpActiveCalls < MCP_MAX_CONCURRENCY) {
      _mcpActiveCalls++;
      resolve();
    } else {
      _mcpWaitQueue.push(resolve);
    }
  });
}

function releaseMCP() {
  if (_mcpWaitQueue.length > 0) {
    const next = _mcpWaitQueue.shift();
    next();
  } else {
    _mcpActiveCalls--;
  }
}

// ── 路径穿越防护 ──────────────────────────────────────────────────────
/**
 * 校验 outputPath 是否在工作区白名单内，防止路径穿越写任意位置。
 * @param {string} outputPath 用户传入的输出路径
 * @returns {{ safe: boolean, resolvedPath: string, wsRoot: string }}
 */
function validateOutputPath(outputPath) {
  const resolvedPath = path.resolve(outputPath);
  const wsRoot = process.env.WORKSPACE || path.resolve(__dirname, '..', '..', '..', '..');
  const resolvedWsRoot = path.resolve(wsRoot);
  return { safe: resolvedPath.startsWith(resolvedWsRoot), resolvedPath, wsRoot: resolvedWsRoot };
}

function clipText(value, max = 1200) {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

function writeFileAtomic(filePath, content) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

function writeJsonAtomic(filePath, value) {
  writeFileAtomic(filePath, JSON.stringify(value, null, 2));
}

function safeEventId(value, fallback = 'event') {
  const text = String(value || '').replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return (text || fallback).slice(0, 160);
}

function summarizeCompletion(result) {
  if (!result) return '';
  if (typeof result === 'string') return clipText(result, 1200);
  if (result.summary) return clipText(result.summary, 1200);
  if (result.final) return clipText(result.final, 1200);
  if (result.answer) return clipText(result.answer, 1200);
  return clipText(result, 1200);
}

function resolveRawReportPath({ runDir, taskId, outputPath }) {
  const wsRoot = process.env.WORKSPACE || path.resolve(__dirname, '..', '..', '..', '..');
  const defaultRoot = path.join(wsRoot, 'memory', 'task-states', 'raw-reports', taskId);
  const outputCheck = outputPath ? validateOutputPath(outputPath) : null;
  const outputRoot = outputCheck?.safe ? path.join(path.dirname(outputCheck.resolvedPath), taskId) : defaultRoot;
  const candidateRoot = runDir ? path.resolve(runDir) : outputRoot;
  const reportFile = runDir ? `${safeEventId(taskId, 'task')}.raw-report.json` : 'raw-report.json';
  const check = validateOutputPath(path.join(candidateRoot, reportFile));
  const root = check.safe ? candidateRoot : defaultRoot;
  return path.join(root, reportFile);
}

function buildBoundedEnvelope({ status, taskId, result, error, completedAt, rawReportPath, params, budgetExceeded = false }) {
  const rawOutputPolicy = params.rawOutputPolicy || params.raw_output_policy || params.budgets?.raw_output_policy || 'no_full_dump';
  const summary = error ? clipText(error, 1200) : summarizeCompletion(result);
  return {
    status,
    taskId,
    summary,
    completedAt,
    budgetUsed: {
      max_tool_output_chars: Number(params.budgets?.max_tool_output_chars || params.budgets?.maxToolOutputChars || 8000),
      max_total_tool_output_chars: Number(params.budgets?.max_total_tool_output_chars || params.budgets?.maxTotalToolOutputChars || 30000),
      raw_output_policy: rawOutputPolicy,
    },
    budgetExceeded,
    artifactPath: rawReportPath,
    rawReportPath,
    evidence_paths_read: Array.isArray(params.evidence?.paths_read) ? params.evidence.paths_read : [],
    evidence_paths_not_read: Array.isArray(params.evidence?.paths_not_read) ? params.evidence.paths_not_read : [],
    not_inspected: Array.isArray(params.evidence?.not_inspected) ? params.evidence.not_inspected : [],
    tool_usage_summary: {
      maxRounds: params.maxRounds,
      toolsConfigured: Array.isArray(params.tools) ? params.tools.length : 0,
      toolPolicy: toolPolicySummary(params.toolPolicy),
    },
    sensitive_scan_result: 'not_run',
    raw_output_policy: rawOutputPolicy,
    error: error ? clipText(error, 800) : undefined,
  };
}

function writeCompletionFallback(event) {
  const inboxDir = path.join(__dirname, 'inbox');
  ensureDir(inboxDir);
  const eventId = event.eventId || `sce-${safeEventId(event.taskId, 'task')}-${safeEventId(event.status || 'done')}`;
  const fp = path.join(inboxDir, `${eventId}.json`);
  const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({
    id: eventId,
    type: 'sc.completion',
    lifecycle: 'pending',
    receivedAt: new Date().toISOString(),
    source: 'subagent-runner-fallback',
    sources: ['subagent-runner-fallback'],
    ...event,
  }, null, 2));
  fs.renameSync(tmp, fp);
}

async function postCompletionEvent(event) {
  const body = {
    ...event,
    type: 'sc.completion',
    source: event.source || 'subagent-runner',
  };
  try {
    const resp = await fetchWithTimeout(`${SIDECAR_URL}/inbox/completion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, SUBAGENT_NOTIFY_TIMEOUT_MS);
    await resp.text().catch(() => '');
    if (!resp.ok) throw new Error(`sidecar inbox HTTP ${resp.status}`);
  } catch (e) {
    try {
      writeCompletionFallback({ ...body, postError: e.message });
    } catch (fallbackErr) {
      process.stderr.write('[subagent] SC inbox fallback error: ' + fallbackErr.message + '\n');
    }
  }
}

// ── 主入口 ────────────────────────────────────────────────────────────
async function main() {
  // 解析参数(优先命令行参数,回退stdin)
  let params;
  if (process.argv[2]) {
    params = JSON.parse(process.argv[2]);
  } else {
    params = await readStdin();
  }

  const {
    taskId = 'sa-' + Date.now().toString(36),
    prompt,
    tools = [],
    outputPath,
    diaryPath,
    flagDir,
    depth = 0,
    maxDepth = 0,
    maxChildren = 2,
    apiKey,
    model = 'deepseek/deepseek-v4-flash',
    timeout = 300,
    codeMode = false,
    taskName = '',
    batchName = '',
    groupName = '',
    runId = '',
    runDir = '',
    rawOutputPolicy = 'no_full_dump',
    budgets = {},
    collector = null,
    acceptance = null,
    evidence = null,
    notifyPolicy = 'notify-only',
    guardMode = '',
    guardWarnings = [],
    taskCard = null,
    toolPolicy: directToolPolicy = null,
    tool_policy: directToolPolicySnake = null
  } = params;
  params.rawOutputPolicy = rawOutputPolicy;
  params.budgets = budgets || {};
  params.collector = collector;
  params.acceptance = acceptance;
  params.evidence = evidence;
  params.notifyPolicy = notifyPolicy;
  params.guardMode = guardMode;
  params.guardWarnings = guardWarnings;
  params.taskCard = isPlainObject(taskCard) ? taskCard : null;
  params.toolPolicy = normalizeToolPolicy(directToolPolicy || directToolPolicySnake || params.taskCard?.toolPolicy || params.taskCard?.tool_policy);
  // 代码改造模式：由下面的 effectiveMaxRounds 统一限制（当前上限100），靠策略失败熔断
  const maxRounds = codeMode ? 100 : (params.maxRounds || 35);

  // ====== x0x 实时通信桥接 ======
  let _x0xCancelled = false;
  const x0xApiUrl = params.x0xApiUrl || process.env.X0X_API_URL || '';
  const x0xToken = params.x0xToken || process.env.X0X_TOKEN || '';
  const x0xTopic = params.x0xTopic || process.env.X0X_TOPIC || '';

  // 用x0x REST API（同步HTTP POST /publish），不依赖WebSocket异步连接
  function reportX0x(step, data) {
    if (!x0xApiUrl || !x0xToken) return;
    try {
      const payload = Buffer.from(JSON.stringify({
        event: 'progress', taskId: x0xTopic, step, ...data, timestamp: new Date().toISOString()
      })).toString('base64');
      // Debug: write to stderr so Sidecar collects it
      process.stderr.write('[x0x] publish: ' + x0xApiUrl + ' |len=' + x0xToken.length + ' |topic=' + (x0xTopic || 'none') + '\n');
      fetchWithTimeout(x0xApiUrl + '/publish', {
        method: 'POST',
        headers: { 'Authorization': 'B' + 'earer ' + x0xToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: 'sa-events', payload }),
      }, SUBAGENT_NOTIFY_TIMEOUT_MS).then(async r => {
        await r.text().catch(() => '');
        process.stderr.write('[x0x] publish status: ' + r.status + '\n');
      }).catch(e => process.stderr.write('[x0x] publish error: ' + e.message + '\n'));
    } catch (e) { process.stderr.write(`[x0x] error: ${e.message}\n`); }
  }

  // 发一启动消息
  reportX0x('started', { prompt: (prompt || '').substring(0,200) });


  // 超时保护（codeMode不设硬时限）
  const effectiveTimeout = codeMode ? 7200 : timeout;
  let taskTimeoutTimer = null;
  const timeoutPromise = new Promise((_, reject) => {
    taskTimeoutTimer = setTimeout(() => reject(new Error(`Subagent timeout after ${effectiveTimeout}s`)), effectiveTimeout * 1000);
  });
  const clearTaskTimeout = () => {
    if (taskTimeoutTimer) {
      clearTimeout(taskTimeoutTimer);
      taskTimeoutTimer = null;
    }
  };

    // 通过x0x报告启动
    reportX0x('running', { status: 'executing', model });

  try {
    const result = await Promise.race([
      runAgent({ taskId, prompt, tools, outputPath, diaryPath, flagDir, depth, maxDepth, maxChildren, apiKey, model, maxRounds, codeMode, taskName, batchName, groupName, taskCard: params.taskCard, toolPolicy: params.toolPolicy }),
      timeoutPromise
    ]);
    clearTaskTimeout();
    const completedAt = new Date().toISOString();
    const rawReportPath = resolveRawReportPath({ runDir, taskId, outputPath });
    writeJsonAtomic(rawReportPath, {
      status: 'success',
      taskId,
      runId,
      taskName,
      batchName,
      groupName,
      completedAt,
      data: result,
    });
    const envelope = buildBoundedEnvelope({ status: 'success', taskId, result, completedAt, rawReportPath, params });

    // 写结果文件（成功路径：路径穿越防护）
    if (outputPath) {
      const check = validateOutputPath(outputPath);
      if (!check.safe) {
        process.stderr.write(JSON.stringify({ error: '路径穿越拦截', path: check.resolvedPath, ws: check.wsRoot }));
      } else {
        ensureDir(path.dirname(check.resolvedPath));
        writeJsonAtomic(check.resolvedPath, envelope);
      }
    }

    // 写日记
    if (diaryPath) {
      const resolvedDiary = path.resolve(diaryPath);
      ensureDir(path.dirname(resolvedDiary));
      writeFileAtomic(resolvedDiary,
        `# 子Agent执行日记 - ${taskId}\n` +
        `时间: ${new Date().toISOString()}\n` +
        `深度: ${depth}/${maxDepth}\n` +
        `提示词: ${prompt?.substring(0, 200)}...\n\n` +
        `## 结果\n\`\`\`json\n${JSON.stringify(envelope, null, 2)}\n\`\`\`\n`
      );
    }

    // 写完成标记文件（零Token，让主脑知道兵回来了）
    try {
      const doneFlagDir = flagDir ? path.resolve(flagDir) : path.resolve(__dirname, '../../../../memory/dialog/subagent');
      ensureDir(doneFlagDir);
      writeFileAtomic(path.join(doneFlagDir, 'DONE_' + taskId + '_success'), new Date().toISOString());
    } catch(e) { process.stderr.write('[subagent] DONE flag error: ' + e.message + '\n'); }

    await postCompletionEvent({
      taskId,
      status: 'success',
      taskName,
      batchName,
      groupName,
      runId,
      outputPath,
      diaryPath,
      rawReportPath,
      completedAt,
      summary: envelope.summary,
      budgetUsed: envelope.budgetUsed,
      budgetExceeded: envelope.budgetExceeded,
      rawOutputPolicy: envelope.raw_output_policy,
      evidence_paths_read: envelope.evidence_paths_read,
      evidence_paths_not_read: envelope.evidence_paths_not_read,
      not_inspected: envelope.not_inspected,
      tool_usage_summary: envelope.tool_usage_summary,
      sensitive_scan_result: envelope.sensitive_scan_result,
    });

    // stdout输出供parent捕获
    // x0x报告完成
    reportX0x('completed', { status: 'success' });
    process.stdout.write(JSON.stringify(envelope));
    process.exit(0);

  } catch (err) {
    clearTaskTimeout();
    // codeMode熔断：恢复备份文件
    if (err.restoreBackup) {
      try {
        const wsRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');
        restoreBackups(wsRoot);
        process.stderr.write('[subagent] 🔄 已恢复备份文件\n');
      } catch (e) { process.stderr.write('[subagent] 备份恢复失败: ' + e.message + '\n'); }
    }
    const errorAt = new Date().toISOString();
    const errorStatus = err.toolPolicyViolation ? 'tool_policy_violation' : (err.stalled ? 'stalled' : 'error');
    const errorResult = { status: errorStatus, taskId, error: err.message, stalled: err.stalled || false, toolPolicyViolation: err.toolPolicyViolation === true, errorAt };
    const rawReportPath = resolveRawReportPath({ runDir, taskId, outputPath });
    writeJsonAtomic(rawReportPath, errorResult);
    const envelope = buildBoundedEnvelope({
      status: errorStatus,
      taskId,
      error: err.message,
      completedAt: errorAt,
      rawReportPath,
      params,
      budgetExceeded: /budget/i.test(err.message || ''),
    });
    const exitCode = err.toolPolicyViolation ? 43 : (err.stalled ? 42 : 1); // 43=工具策略违规, 42=僵死
    // 写错误结果文件（失败路径：路径穿越防护）
    if (outputPath) {
      const check = validateOutputPath(outputPath);
      if (!check.safe) {
        process.stderr.write(JSON.stringify({ error: '路径穿越拦截', path: check.resolvedPath, ws: check.wsRoot }));
      } else {
        ensureDir(path.dirname(check.resolvedPath));
        writeJsonAtomic(check.resolvedPath, envelope);
      }
    }
    // 写失败标记文件
    try {
      const doneFlagDir = flagDir ? path.resolve(flagDir) : path.resolve(__dirname, '../../../../memory/dialog/subagent');
      ensureDir(doneFlagDir);
      // 🔥 区分僵死 vs 普通失败
      const doneStatus = err.toolPolicyViolation ? 'tool_policy_violation' : (err.stalled ? 'stalled' : 'failed');
      writeJsonAtomic(path.join(doneFlagDir, 'DONE_' + taskId + '_' + doneStatus), {
        error: err.message,
        stalled: err.stalled || false,
        completedAt: new Date().toISOString()
      });
      // B方案: 通知MCP Server兵完成(含stalled状态)
      const notifyPath = path.join(doneFlagDir, 'NOTIFY_' + taskId + '_' + doneStatus + '.json');
      writeJsonAtomic(notifyPath, { taskId, status: doneStatus, completedAt: errorAt, error: err.message });
      fetchWithTimeout('http://127.0.0.1:18790/notify-done', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, status: doneStatus }),
      }, SUBAGENT_NOTIFY_TIMEOUT_MS).then(r => r.text().catch(() => '')).catch(() => {});
    } catch(e) { process.stderr.write('[subagent] DONE flag error: ' + e.message + '\n'); }

    await postCompletionEvent({
      taskId,
      status: err.toolPolicyViolation ? 'tool_policy_violation' : (err.stalled ? 'stalled' : 'failed'),
      taskName,
      batchName,
      groupName,
      runId,
      outputPath,
      diaryPath,
      rawReportPath,
      completedAt: errorAt,
      summary: envelope.summary,
      error: err.message,
      budgetUsed: envelope.budgetUsed,
      budgetExceeded: envelope.budgetExceeded,
      rawOutputPolicy: envelope.raw_output_policy,
      evidence_paths_read: envelope.evidence_paths_read,
      evidence_paths_not_read: envelope.evidence_paths_not_read,
      not_inspected: envelope.not_inspected,
      tool_usage_summary: envelope.tool_usage_summary,
      sensitive_scan_result: envelope.sensitive_scan_result,
    });

    // x0x报告失败
    reportX0x('failed', { status: 'error', error: err.message });
    process.stderr.write(JSON.stringify(errorResult));
    process.exit(exitCode); // 🔥 僵死=42, 失败=1
  }
}

// ── Agent循环 ─────────────────────────────────────────────────────────
let currentTaskId = null; // 模块级，供 _callLLMImpl 带上 x-task-id
let currentTaskName = '';
let currentBatchName = '';
let currentGroupName = '';
async function runAgent(params) {
  const { taskId, prompt, tools: allowedTools, flagDir, depth, maxDepth, maxChildren, apiKey, model, maxRounds = 20, codeMode = false, taskName = '', batchName = '', groupName = '', toolPolicy = null } = params;

  // 存到模块级变量，供 _callLLMImpl 带上 x-task-id 请求头
  currentTaskId = taskId;
  currentTaskName = taskName;
  currentBatchName = batchName;
  currentGroupName = groupName;

  // 代码改造模式：不限轮次，靠策略失败熔断
  const effectiveMaxRounds = codeMode ? 100 : maxRounds;

  // 获取允许的工具列表(带function calling schema) + 共享MCP session
  const effectiveToolPolicy = normalizeToolPolicy(toolPolicy);
  const { tools: safeTools, sessionId } = await getAllowedTools(depth, maxDepth, maxChildren);
  const visibleTools = filterToolsByPolicy(safeTools, effectiveToolPolicy);
  process.stderr.write(`[subagent] session复用: ${sessionId}, tools=${visibleTools.length}个
`);
  const sharedSession = { id: sessionId }; // 用对象包装，callTool内可更新重连后的新id

  // 确保session最终关闭
  const cleanupSession = async () => {
    if (sharedSession.id) {
      try { await closeMCPSession(sharedSession.id); } catch {}
      sharedSession.id = null;
    }
  };

  try {
  const toolSchemas = visibleTools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: (t.description || '').substring(0, 200),
      parameters: t.inputSchema || { type: 'object', properties: {} }
    }
  }));

  // 系统提示词
  const systemPrompt = `你是杉杉的子Agent(taskId: ${taskId},深度: ${depth}/${maxDepth})。

## 可用工具
${visibleTools.map(t => '- \\`' + t.name + '\\`: ' + (t.description || '').substring(0, 100)).join('\n')}

## 安全规则
- 禁止调危险工具: ${SUBAGENT_BLOCKED.join(', ')}
- 同一工具失败3次停止使用
- 禁止调原生工具(exec/write/edit/web_search等)。保留:browser(登录态操作/网页)、message(发通知)
- 文件操作限工作区目录
${effectiveToolPolicy.enabled ? `- 本任务启用工具硬限制: ${JSON.stringify(toolPolicySummary(effectiveToolPolicy))}` : ''}

## 输出要求
返回最终结果。如果任务需要调工具,先调工具再根据工具结果给出最终答案。

## 工具说明书
如果看不懂某个工具、或不确定这工具你让不让用，去工作区找 skills/core-file-search/SKILL.md 读一下。工具名前有 ✅ 的就是你能用的。别一个个试，先查再说。`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt }
  ];

  let result = null;
  let toolFailCount = 0;
  let toolSuccessCount = 0; // 成功工具调用计数(僵死检测用)
  let lastToolSuccessTime = Date.now(); // 最后一次工具成功时间
  let validateFailCount = 0; // codeMode下validate连续失败追踪
  const toolPolicyState = { totalCalls: 0, byRule: new Map() };
  let toolBudgetHardStopInjected = false;
  // 同一工具+action连续失败追踪 → 自动注入换路建议（杉哥2026-06-11）
  let lastFailedTool = null;
  let lastFailedAction = null;
  let lastFailedToolConsecutive = 0;
  const TOOL_ALTERNATIVES = {
    'codeEditor': 'fileManager（读文件用action=read, 写文件用action=write）',
    'fileManager': 'codeEditor（用action=edit_code精准修改文件）',
    'webSearch': '换个搜索词重试, 或改用webSearch(action=web_fetch)直接抓取页面',
  };


  // 方案C: 消息快照 — 每轮LLM调用前保存快照，工具处理完成后校验
  let lastSnapshot = null;
  function saveSnapshot() {
    lastSnapshot = messages.map(m => JSON.parse(JSON.stringify(m)));
  }
  function rollbackMessages() {
    if (lastSnapshot) {
      messages.length = 0;
      messages.push(...JSON.parse(JSON.stringify(lastSnapshot)));
      process.stderr.write('[subagent] 回滚messages到上一轮快照\n');
    }
  }

  for (let round = 0; round < effectiveMaxRounds; round++) {
    // 🔥 僵死检测: 超过STALL_TIMEOUT_MS无工具成功 → 自动熔断(防僵尸兵)
    const stallMs = Date.now() - lastToolSuccessTime;
    if (stallMs > STALL_TIMEOUT_MS) {
      process.stderr.write(`[subagent] ⚠️ 僵死熔断: ${Math.round(stallMs/1000)}s无工具成功, 已执行${round}轮, 成功${toolSuccessCount}次, 失败${toolFailCount}次\n`);
      const stallErr = new Error(`僵死熔断(僵尸兵): ${Math.round(stallMs/1000)}s无进展 (${round}轮, 成功${toolSuccessCount}次, 失败${toolFailCount}次)`);
      stallErr.stalled = true; // 标记为僵死，区别于普通失败
      throw stallErr;
    }

    // 消息完整性保护：确保tool_calls都有tool回应
    guardMessages(messages);
    // 拍快照（在callLLM之前，快照里包含补全后的filler）
    saveSnapshot();

    // 方案B: LLM调用(带重试+400错误自愈)
    let response;
    for (let llmRetry = 0; llmRetry <= 2; llmRetry++) {
      // 🔥 排除API重试时间: LLM正在工作中，不算僵死
      lastToolSuccessTime = Date.now();
      try {
        const toolBudgetExhausted = isToolBudgetExhausted(effectiveToolPolicy, toolPolicyState);
        if (toolBudgetExhausted && !toolBudgetHardStopInjected) {
          messages.push({
            role: 'system',
            content: '[TOOL_POLICY_HARD_STOP] 工具预算已耗尽。必须严格遵守本任务工具策略。禁止再次请求、暗示或尝试任何工具调用；任何 tool_call 都会被系统判定为工具策略违规并使任务失败。现在只允许输出最终 bounded JSON，不允许输出解释、计划、请求更多工具或继续检查。',
          });
          toolBudgetHardStopInjected = true;
        }
        response = await callLLM(messages, model, apiKey, toolBudgetExhausted ? [] : toolSchemas);
        break; // 成功
      } catch (err) {
        const is400ToolMsg = err.message.includes('insufficient tool messages') ||
                             err.message.includes('tool messages responding');
        // 方案B: 400错误 → 回滚+重试
        if (is400ToolMsg && llmRetry < 2) {
          process.stderr.write(`[subagent] LLM 400错误(tool消息完整性), 回滚重试第${llmRetry+1}次\n`);
          rollbackMessages();
          // 回滚后再次运行guardMessages确保完整性
          guardMessages(messages);
          continue;
        }
        // 其他错误或重试耗尽 → 抛出
        if (llmRetry >= 2) {
          process.stderr.write(`[subagent] LLM重试${llmRetry+1}次均失败, 放弃\n`);
        }
        throw err;
      }
    }
    const choice = response.choices?.[0];
    if (!choice) throw new Error(`LLM returned empty response: ${JSON.stringify(response)}`);

    const msg = choice.message;

    // 检查是否有工具调用
    const toolCalls = msg.tool_calls || [];
    if (toolCalls.length === 0) {
      // 无工具调用 = 最终答案
      result = msg.content;
      break;
    }

    // 先把assistant消息加入对话历史
    messages.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls });

    // 方案D: 分批约束 — 每轮最多处理3个tool_call，减少批处理风险
    // 剩余的会在工具响应中提示LLM下轮继续
    const MAX_TOOLS_PER_ROUND = 3;
    const activeToolCalls = toolCalls.slice(0, MAX_TOOLS_PER_ROUND);
    const deferredToolCalls = toolCalls.slice(MAX_TOOLS_PER_ROUND);
    if (deferredToolCalls.length > 0) {
      process.stderr.write(`[subagent] 分批: 本轮${toolCalls.length}个, 处理${activeToolCalls.length}个, ${deferredToolCalls.length}个延到下轮\n`);
    }

    // 记录延期工具的名称（用于在最后一条tool消息中提示）
    const deferredNames = deferredToolCalls.map(tc => tc.function?.name);

    // 处理每个工具调用
    for (const tc of activeToolCalls) {
      const toolName = tc.function?.name;
      let toolArgs = {};
      try {
        toolArgs = JSON.parse(tc.function?.arguments || '{}');
      } catch { toolArgs = {}; }

      const policyCheck = validateToolPolicyCall(effectiveToolPolicy, toolName, toolArgs, toolPolicyState);
      if (!policyCheck.ok) {
        process.stderr.write(`[subagent] 工具策略违规: ${policyCheck.reason}\n`);
        throwToolPolicyViolation(policyCheck);
      }
      recordToolPolicyCall(toolPolicyState, toolName, policyCheck.action);

      // 安全过滤(config + 原生兜底)
      if (SUBAGENT_BLOCKED.includes(toolName) || DANGEROUS_NATIVE_TOOLS.includes(toolName)) {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ error: `工具 ${toolName} 被禁止使用(危险工具)` })
        });
        continue;
      }

      // 递归深度限制
      if (toolName === 'cpu_spawn_subagent') {
        if (depth >= maxDepth) {
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ error: `已达最大递归深度 ${maxDepth},无法派生子Agent` })
          });
          continue;
        }
        // 计算当前深度已派生的子agent数
        const children = toolArgs.children || [];
        if (children.length > maxChildren) {
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ error: `每层最多 ${maxChildren} 个子Agent` })
          });
          continue;
        }
      }

      // 调用工具(带retry+熔断),透传当前深度
      // ⚠️ 先占位再执行：确保即使异常中断，tool消息也不丢失
      const toolMsgIdx = messages.length;
      messages.push({ role: 'tool', tool_call_id: tc.id, content: '' });
      let toolResult = null;
      let lastError = null;
      for (let retry = 0; retry <= MAX_TOOL_RETRIES; retry++) {
        try {
          toolResult = await callTool(toolName, toolArgs, { depth, sharedSession });
          lastError = null;
          toolSuccessCount++;
          lastToolSuccessTime = Date.now();
          // 成功重置同工具追踪
          lastFailedTool = null;
          lastFailedAction = null;
          lastFailedToolConsecutive = 0;
          break;
        } catch (err) {
          lastError = err;
          toolFailCount++;

          // codeMode: 跟踪validate连续失败 → 2次策略失败熔断
          if (codeMode && toolName === 'validate') {
            validateFailCount++;
            if (validateFailCount >= 2) {
              // 先更新占位消息为失败信息
              messages[toolMsgIdx].content = JSON.stringify({ error: `代码修复方案失败: validate连续失败${validateFailCount}次` });
              const restoreErr = new Error(`代码修复方案失败: validate连续失败${validateFailCount}次, 策略无效`);
              restoreErr.restoreBackup = true;
              throw restoreErr;
            }
          } else if (codeMode) {
            validateFailCount = 0; // 非validate失败则不累计
          }

          // 追踪同工具+action连续失败
          const curAction = toolArgs?.action || 'call';
          if (lastFailedTool === toolName && lastFailedAction === curAction) {
            lastFailedToolConsecutive++;
          } else {
            lastFailedTool = toolName;
            lastFailedAction = curAction;
            lastFailedToolConsecutive = 1;
          }

          // 同工具+action连续失败3次 → 注入换路建议
          if (lastFailedToolConsecutive >= 3 && TOOL_ALTERNATIVES[toolName]) {
            const alt = TOOL_ALTERNATIVES[toolName];
            messages.push({
              role: 'system',
              content: `[🔧 自动提示] ${toolName}(${curAction}) 已连续失败${lastFailedToolConsecutive}次。建议换用替代方案: ${alt}。当前任务的其他部分不受影响，继续执行。`
            });
            lastFailedToolConsecutive = 0;
          }

          if (toolFailCount >= 5) {
            const toolFailDetail = `工具=${toolName}, action=${toolArgs?.action||'call'}, 最后错误=${lastError?.message||'未知'}`;
            process.stderr.write(`[subagent] 熔断前信息: ${toolFailDetail}
`);
            throw new Error(`工具调用失败次数过多(${toolFailCount}),熔断终止。${toolFailDetail}`);
          }
        }
      }

      // 更新占位消息为实际结果
      if (lastError) {
        messages[toolMsgIdx].content = JSON.stringify({ error: `工具 ${toolName} 调用失败: ${lastError.message}` });
      } else {
        messages[toolMsgIdx].content = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult).substring(0, 50000);
        messages[toolMsgIdx].content = appendToolPolicyHint(
          messages[toolMsgIdx].content,
          buildToolBudgetExhaustedHint(effectiveToolPolicy, toolPolicyState)
        );
      }

      // 方案D: 延期工具提示 — 在最后一条tool消息里追加未处理信息
      if (deferredNames.length > 0 && tc === activeToolCalls[activeToolCalls.length - 1]) {
        const remainingSummary = deferredNames.join(', ');
        const existingContent = messages[toolMsgIdx].content;
        const hint = `\n\n[分批执行] 以下tool_calls因分批约束未在当前轮执行: ${remainingSummary}。请在新一轮中重新发起这些工具调用。`;
        // 如果内容太长，截断保留头部信息再追加提示
        if (existingContent.length > 30000) {
          messages[toolMsgIdx].content = existingContent.substring(0, 28000) + hint;
        } else {
          messages[toolMsgIdx].content = existingContent + hint;
        }
      }
    }

    // 🔥 心跳: 每轮报告状态(零LLM开销,只写stderr管道)
    if (round % HEARTBEAT_INTERVAL_ROUNDS === 0) {
      const stallSec = Math.round((Date.now() - lastToolSuccessTime) / 1000);
      process.stderr.write(`[HB] R${round} OK:${toolSuccessCount} FAIL:${toolFailCount} STALL:${stallSec}s\n`);
    }
  }

  if (!result) {
    result = { warning: `达到最大轮次(${effectiveMaxRounds})未得到最终结果`, partial: messages[messages.length - 1]?.content };
  }

  return result;
  } finally {
    await cleanupSession();
  }
}

// ── 获取安全工具列表(从MCP拉取,过滤危险工具)───────────────
async function getAllowedTools(depth, maxDepth, maxChildren) {
  // 按depth分级缓存:不同深度的工具列表不同(maxDepth决定了是否含cpu_spawn_subagent)
  if (toolCacheByDepth[depth]) return toolCacheByDepth[depth];

  const sessionId = await createMCPSession();
  process.stderr.write(`[subagent] 创建新MCP session: ${sessionId}
`);
  try {
    // 调MCP tools/list获取所有工具定义
    const msgUrl = `${MCP_URL}/messages?sessionId=${sessionId}`;
    const listResponse = await fetchWithTimeout(msgUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 'list-tools', method: 'tools/list', params: { role: 'subagent' }
      })
    }, SUBAGENT_MCP_TOOL_TIMEOUT_MS);
    if (!listResponse.ok) throw new Error(`MCP tools/list HTTP ${listResponse.status}`);

    // 从SSE流读取结果
    const session = mcpSessions.get(sessionId);
    let tools = await readMCPListResult(session.reader);

    // 过滤:去掉危险工具(config + 原生兜底)
    tools = tools.filter(t => !SUBAGENT_BLOCKED.includes(t.name) && !DANGEROUS_NATIVE_TOOLS.includes(t.name));
    // 去重(按name)
    const seen = new Set();
    tools = tools.filter(t => {
      if (seen.has(t.name)) return false;
      seen.add(t.name);
      return true;
    });
    // 简化inputSchema:只保留properties+required,去掉additionalProperties等DeepSeek不认的字段
    tools = tools.map(t => {
      const schema = t.inputSchema || {};
      return {
        name: t.name,
        description: t.description || '',
        inputSchema: {
          type: 'object',
          properties: schema.properties || {},
          required: schema.required || []
        }
      };
    });

    // 如果没到最大深度且MCP未提供cpu_spawn_subagent,再手动加
    if (depth < maxDepth && !tools.some(t => t.name === 'cpu_spawn_subagent')) {
      tools.push({
        name: 'cpu_spawn_subagent',
        description: `派生子Agent执行子任务(当前深度${depth+1}/${maxDepth},最多${maxChildren}个)`,
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: '子任务描述' },
            timeout: { type: 'number', description: '超时s数(可选)' }
          },
          required: ['prompt']
        }
      });
    }

    // tavily_search不再手动注入 — webSearch(MCP统一入口)已含搜索+提取

    // 按depth存缓存,不同深度互不影响
    toolCacheByDepth[depth] = tools;
    return { tools, sessionId }; // session不关，留给调用方复用
  } catch (err) {
    // 如果获取tools/list失败，关闭session后抛出
    try { await closeMCPSession(sessionId); } catch {}
    throw err;
  }
}

// 从SSE流读取tools/list的结果
async function readMCPListResult(reader) {
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await readWithTimeout(reader, SUBAGENT_MCP_TOOL_TIMEOUT_MS, 'MCP tools/list');
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6));
          if (data.id === 'list-tools' && data.result?.tools) {
            return data.result.tools;
          }
          if (data.id === 'list-tools' && data.error) {
            throw new Error('MCP tools/list error: ' + (data.error.message || JSON.stringify(data.error)));
          }
        } catch (e) {
          if (e.message?.startsWith('MCP tools/list error')) throw e;
        }
      }
    }
  }
  throw new Error('MCP tools/list returned no tools');
}

// ── LLM调用(含function calling,自带令牌桶排队)───────────────
// 令牌桶:同一子agent最多3个API并发请求,超出的排队
const API_MAX_CONCURRENCY = 3;
let _apiActiveCalls = 0;
const _apiWaitQueue = [];

function acquireAPI() {
  return new Promise(resolve => {
    if (_apiActiveCalls < API_MAX_CONCURRENCY) {
      _apiActiveCalls++;
      resolve();
    } else {
      _apiWaitQueue.push(resolve);
    }
  });
}

function releaseAPI() {
  if (_apiWaitQueue.length > 0) {
    const next = _apiWaitQueue.shift();
    next();
  } else {
    _apiActiveCalls--;
  }
}

async function callLLM(messages, model, apiKey, tools) {
  // 先获取API令牌,排队等
  await acquireAPI();
  try {
    return await _callLLMImpl(messages, model, apiKey, tools);
  } finally {
    releaseAPI();
  }
}

async function _callLLMImpl(messages, model, apiKey, tools) {
  // 从环境变量或参数中获取API Key
  const key = apiKey || process.env.DEEPSEEK_SUB_API_KEY || process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('DEEPSEEK_API_KEY 未设置');

  // 支持 LLM_BASE_URL 重定向所有模型（含 DeepSeek）到 ACS
  const url = process.env.LLM_BASE_URL || ACS_LLM_BASE_URL;

  const modelId = model.startsWith('deepseek/') ? model.replace('deepseek/', '') : model;

  const body = {
    model: modelId,
    messages,
    max_tokens: 8192,
    temperature: 0.3
  };

  // 如果传入了工具定义,加到请求里(function calling)
  if (tools && tools.length > 0) {
    body.tools = tools;
    // DeepSeek V4 Flash需要tool_choice让模型知道可以调工具
    body.tool_choice = 'auto';
  }

  const acsTaskIdHeader = toAsciiSafeHeaderValue(currentTaskId, '');

  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-task-id': acsTaskIdHeader || 'main',
      'x-acs-lane': 'SUB',
      'x-acs-task-id': acsTaskIdHeader,
      'x-acs-task-name': toAsciiSafeHeaderValue(currentTaskName, ''),
      'x-acs-batch-name': toAsciiSafeHeaderValue(currentBatchName, ''),
      'x-acs-group-name': toAsciiSafeHeaderValue(currentGroupName, ''),
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify(body),
  }, SUBAGENT_LLM_TIMEOUT_MS);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM API error ${response.status}: ${text.substring(0, 200)}`);
  }

  return response.json();
}

// ── 工具调用 ──────────────────────────────────────────────────────────
async function callTool(toolName, args, context = {}) {
  // 特殊处理:递归派兵走Sidecar
  if (toolName === 'cpu_spawn_subagent') {
    // 用调用者传入的当前深度 +1,而不是从LLM参数里猜
    // 这样不管DeepSeek传不传depth,深度都正确传递
    const currentDepth = (context && context.depth !== undefined) ? context.depth : 0;
    const response = await fetchWithTimeout(`${SIDECAR_URL}/spawn_subagent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...args,
        taskName: args.taskName || args.name || currentTaskName,
        batchName: args.batchName || currentBatchName,
        groupName: args.groupName || currentGroupName || currentTaskName,
        depth: currentDepth + 1
      })
    }, SUBAGENT_MCP_CONNECT_TIMEOUT_MS);
    if (!response.ok) throw new Error(`spawn_subagent error: ${response.status}`);
    return response.json();
  }

  // 其他工具走sc MCP，用共享session(断了自动重连)
  const sharedSession = context.sharedSession;
  if (!sharedSession || !sharedSession.id) throw new Error('MCP session未初始化');

  await acquireMCP();
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        process.stderr.write(`[subagent] 调工具 ${toolName} (session复用: ${sharedSession.id})
`);
        return await callMCPTool(sharedSession.id, toolName, args);
      } catch (err) {
        if (attempt === 0 && (err.message.includes('SSE') || err.message.includes('session') || err.message.includes('reader'))) {
          process.stderr.write(`[subagent] MCP session断连,重连中: ${err.message}\n`);
          try { await closeMCPSession(sharedSession.id); } catch {}
          sharedSession.id = await createMCPSession();
          continue;
        }
        throw err;
      }
    }
  } finally {
    releaseMCP();
  }
}

// ── MCP Session管理 ──────────────────────────────────────────────────
const mcpSessions = new Map(); // sessionId -> { response, reader }

async function createMCPSession() {
  let response;
  try {
    response = await fetchWithTimeout(`${MCP_URL}/sse?role=subagent`, {}, SUBAGENT_MCP_CONNECT_TIMEOUT_MS);
  } catch (e) {
    throw new Error(`SC bridge unavailable at ${MCP_URL} (MCP/SSE). Check that the 18790 bridge is running before spawning SC subagents. Original error: ${e.message}`);
  }
  if (!response.ok) throw new Error(`MCP SSE error: ${response.status}`);
  const reader = response.body.getReader();

  // 读第一块数据,提取sessionId
  const { value } = await readWithTimeout(reader, SUBAGENT_MCP_CONNECT_TIMEOUT_MS, 'MCP session init');
  const text = new TextDecoder().decode(value);
  const sessionId = text.match(/sessionId=([^\s&]+)/)?.[1];
  if (!sessionId) throw new Error('Failed to get MCP sessionId');

  mcpSessions.set(sessionId, { response, reader });
  return sessionId;
}

async function closeMCPSession(sessionId) {
  const session = mcpSessions.get(sessionId);
  if (session) {
    try { session.reader.cancel(); } catch (e) { process.stderr.write(`[subagent] reader cancel error: ${e.message}\n`); }
    mcpSessions.delete(sessionId);
  }
}

async function callMCPTool(sessionId, toolName, args) {
  const msgUrl = `${MCP_URL}/messages?sessionId=${sessionId}`;
  const session = mcpSessions.get(sessionId);
  if (!session) throw new Error(`MCP session ${sessionId} not found`);

  // 发工具调用请求
  const msgResponse = await fetchWithTimeout(msgUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'req-' + Date.now().toString(36),
      method: 'tools/call',
      params: { name: toolName, arguments: args }
    })
  }, SUBAGENT_MCP_TOOL_TIMEOUT_MS);
  if (!msgResponse.ok) throw new Error(`MCP call error: ${msgResponse.status}`);

  // 从SSE流中读取结果
  const result = await readMCPSessionResult(sessionId, session.reader, toolName);
  return result;
}

async function readMCPSessionResult(sessionId, reader, toolName) {
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await readWithTimeout(reader, SUBAGENT_MCP_TOOL_TIMEOUT_MS, `MCP tool ${toolName}`);
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      // SSE格式: data: {...json...}
      if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6));
          // MCP结果格式: { jsonrpc, id, result } 或 { jsonrpc, id, error }
          if (data.id && data.id.startsWith('req-')) {
            if (data.result) return data.result;
            if (data.error) throw new Error(`MCP error: ${data.error.message || JSON.stringify(data.error)}`);
          }
        } catch (e) {
          if (e.message?.startsWith('MCP error')) throw e;
          // 非JSON行忽略
        }
      }
    }
  }

  throw new Error(`MCP tool ${toolName} returned no result`);
}

// ── 工具函数 ──────────────────────────────────────────────────────────
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/** 方案A: 消息邻接完整性保护
 * 按消息顺序逐条扫描，确保每个assistant(tool_calls)后面紧跟正确数量的tool响应
 * 缺口自动补filler（插到正确位置，不丢到数组末尾）
 * 额外（非对应assistant的）tool消息自动移除
 */
function guardMessages(messages) {
  const fixed = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    fixed.push(msg);
    i++;

    // 发现assistant(tool_calls) → 消费紧跟在后面的N个tool消息
    if (msg.role === 'assistant' && msg.tool_calls?.length > 0) {
      const expectedIds = new Set(msg.tool_calls.map(tc => tc.id));
      let consumed = 0;
      const expectedCount = msg.tool_calls.length;

      // 消费紧跟在后面的tool消息（只消费属于这个assistant的）
      while (i < messages.length && consumed < expectedCount) {
        const next = messages[i];
        if (next.role === 'tool' && next.tool_call_id && expectedIds.has(next.tool_call_id)) {
          fixed.push(next);
          i++;
          consumed++;
        } else {
          break; // 遇到了非tool消息或不属于本assistant的tool → 缺口
        }
      }

      // 补上缺失的filler（插到缺口位置，不是数组末尾）
      while (consumed < expectedCount) {
        const missingId = msg.tool_calls[consumed]?.id || 'unknown_' + consumed;
        fixed.push({
          role: 'tool',
          tool_call_id: missingId,
          content: JSON.stringify({ error: '工具调用中断(系统自动补全)' })
        });
        consumed++;
      }
    }
  }

  // 用修复后的数组替换原数组
  messages.length = 0;
  messages.push(...fixed);
  return messages;
}

/** codeMode熔断: 递归恢复workspace下所有最近2h内创建的.bak文件 */
function restoreBackups(wsRoot) {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000; // 2小时以内的备份
  function walk(dir) {
    let items; try { items = fs.readdirSync(dir); } catch { return; }
    for (const item of items) {
      if (item.startsWith('node_modules') || item.startsWith('.git')) continue;
      const fp = path.join(dir, item);
      let stat; try { stat = fs.statSync(fp); } catch { continue; }
      if (stat.isDirectory()) { walk(fp); }
      else if (item.endsWith('.bak') && stat.mtimeMs > cutoff) {
        const orig = fp.replace(/\.bak$/, '');
        try { fs.copyFileSync(fp, orig); process.stderr.write('[subagent] 恢复: ' + fp + ' → ' + orig + '\n'); }
        catch (e) { process.stderr.write('[subagent] 恢复失败: ' + fp + ': ' + e.message + '\n'); }
      }
    }
  }
  walk(wsRoot);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error('Invalid JSON from stdin')); }
    });
    process.stdin.on('error', reject);
  });
}

// ── 启动 ──────────────────────────────────────────────────────────────
main().catch(err => {
  process.stderr.write(JSON.stringify({ status: 'error', error: err.message }));
  process.exit(1);
});
