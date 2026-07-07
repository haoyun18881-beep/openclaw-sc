/**
 * 🦞 sc v5.37.0 — Worker 线程 (ESM + 多核并行决策)
 */

import { parentPort, workerData } from "worker_threads";
import { readFile, stat, realpath, unlink, rmdir, mkdtemp, writeFile, readdir, appendFile } from "fs/promises";
import { createReadStream } from "fs";
import { execFile, spawn } from "child_process";
import { join, resolve, normalize, relative, isAbsolute, dirname } from "path";
import { homedir, tmpdir } from "os";
import readline from "readline";
import { LEVEL_RULES, LEVEL_TOOL_MAP } from "../lib/level-rules.js";
import { TASK_CATEGORY_MAP, TASK_CATEGORY } from "../lib/constants.js";
import { routeDecompose as decomposeTaskBody } from "../lib/decomposer.js";

// ====== Worker 独立日志系统：console 双写（文件 + 原始 console）======
import { fileURLToPath } from 'url';
const _wDir = dirname(fileURLToPath(import.meta.url));
const WORKER_LOG_DIR = join(_wDir, '..', 'logs');
const WORKER_LOG_FILE = join(WORKER_LOG_DIR, 'worker-pool.log');
const WORKER_ERROR_FILE = join(WORKER_LOG_DIR, 'error.log');

// 异步写入函数（Worker 内部使用，不依赖主线程 logger）
const _logQueue = [];
let _logFlushing = false;

async function _flushLogQueue() {
  if (_logFlushing) return;
  _logFlushing = true;
  while (_logQueue.length > 0) {
    const { filePath, line } = _logQueue.shift();
    try {
      await appendFile(filePath, line + '\n', 'utf-8');
    } catch {}
  }
  _logFlushing = false;
}

function _enqueueLog(filePath, line) {
  _logQueue.push({ filePath, line });
  if (_logQueue.length === 1) {
    _flushLogQueue().catch(() => {});
  }
}

function _workerTs() {
  const now = new Date();
  return now.toISOString().replace('T', ' ').substring(0, 19) + '.' +
    String(now.getMilliseconds()).padStart(3, '0');
}

// 异步确保日志目录存在（首次调用时执行）
let _logDirEnsured = false;
async function _ensureWorkerLogDir() {
  if (_logDirEnsured) return;
  try {
    const { mkdir } = await import('fs/promises');
    await mkdir(WORKER_LOG_DIR, { recursive: true });
    _logDirEnsured = true;
  } catch {}
}
_ensureWorkerLogDir().catch(() => {});

// 保存原始 console 方法
const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);

// 替换 console.log：文件 + 原始
console.log = function(...args) {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  const line = `[${_workerTs()}] [Worker-${workerData.id}] [LOG] ${msg}`;
  _enqueueLog(WORKER_LOG_FILE, line);
  _origLog(...args);
};

// 替换 console.warn：worker-pool + error 双文件 + 原始
console.warn = function(...args) {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  const line = `[${_workerTs()}] [Worker-${workerData.id}] [WARN] ${msg}`;
  _enqueueLog(WORKER_LOG_FILE, line);
  _enqueueLog(WORKER_ERROR_FILE, line);
  _origWarn(...args);
};

// 替换 console.error：worker-pool + error 双文件 + 原始
console.error = function(...args) {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  const line = `[${_workerTs()}] [Worker-${workerData.id}] [ERROR] ${msg}`;
  _enqueueLog(WORKER_LOG_FILE, line);
  _enqueueLog(WORKER_ERROR_FILE, line);
  _origError(...args);
};

// ====== 任务分类器 + 探索型 partialResult 存储 ======
const partialResultStore = new Map(); // jobId → { progress, ... }

/**
 * 分类任务类型（图灵可判定终止保证）
 * 有限型 → 严格超时 | 件型 → 幂等retry | 探索型 → checkpoint | 交互型 → 等待
 */
/**
 * 分类任务类型（图灵可判定终止保证）
 * 有限型 → 严格超时 | 件型 → 幂等retry | 探索型 → checkpoint | 交互型 → 等待
 *
 * 🧠 先查 TASK_CATEGORY_MAP（精确匹配），不在 map 中的工具走关键词兜底。
 * 不在 map 中的工具不是忘记加——是有意不加（见 constants.js TASK_CATEGORY_MAP 注释）。
 * 兜底关键词匹配确保新工具或非常用工具也能被分类。
 * 兜底不到的一律归为 FINITE（最保守的安全侧）。
 */
function classifyTaskType(taskType) {
  if (TASK_CATEGORY_MAP[taskType]) return TASK_CATEGORY_MAP[taskType];
  const kw = (taskType || '').toLowerCase();
  if (/research|orchestrate|pipeline|explor/i.test(kw)) return TASK_CATEGORY.EXPLORATORY;
  if (/ping|resolve|route|dispatch/i.test(kw)) return TASK_CATEGORY.CONDITIONAL;
  if (/interact|wait|pause/i.test(kw)) return TASK_CATEGORY.INTERACTIVE;
  return TASK_CATEGORY.FINITE;
}

/**
 * 存储探索型任务的中间进度（供请求-响应协议使用）
 */
function storePartial(jobId, data) {
  const existing = partialResultStore.get(jobId) || {};
  partialResultStore.set(jobId, { ...existing, ...data, updatedAt: Date.now() });
}

// ====== Embedding 配置（从系统配置读取，不硬编码） ======
import { getEmbeddingConfig, getVisionConfig } from '../lib/config.js';

let _embedCfg = null;
let _visionCfg = null;
let _cfgLoadTime = 0;
const CACHED_CFG_TTL = 60000;

/** 懒加载 embedding 配置（缓存 60 s） */
async function getOllamaConfig() {
  const now = Date.now();
  if (_embedCfg && now - _cfgLoadTime < CACHED_CFG_TTL) {
    return { embed: _embedCfg, vision: _visionCfg };
  }
  _embedCfg = await getEmbeddingConfig();
  _visionCfg = await getVisionConfig();
  _cfgLoadTime = now;
  return { embed: _embedCfg, vision: _visionCfg };
}

/** 获取 embedding 模型名，没有配置则报错 */
async function getEmbeddingModel() {
  const { embed } = await getOllamaConfig();
  if (!embed.embeddingModel) {
    throw new Error('Embedding 模型未配置，请在 openclaw.json 的 models.providers.embedding 中配置向量模型');
  }
  return embed.embeddingModel;
}

// 🧠 设计决策：EMBEDDING_TIMEOUT_MS=30000（30s超时）。
// Ollama embedding 请求本地（127.0.0.1:11434）平均 1-3 s，
// 加文件读取最多 5-10 s，30s足够扛过模型冷启动加载。
// 设太短（10s）会在模型冷启动时频繁retry，设太长（60s）则
// 排队累积时语义搜索会大量阻塞。
const EMBEDDING_TIMEOUT_MS = 30000;
// 🧠 设计决策：EMBEDDING_MAX_RETRIES=2（最多retry2次）。
// Ollama 本地服务偶尔超时（模型冷加载），retry1次不够，
// retry3次→缓存已冷启动了的模型已经能用了。2次≈足够覆盖
// 偶发热加载延迟，又不至于在Ollama宕机时反复撞墙。
const EMBEDDING_MAX_RETRIES = 2;

// ====== 语义搜索配置 ======
const SEMANTIC_SEARCH_CHUNK_CHARS = 2000; // 每个文件最多取前 N 字符做 embedding
const SEMANTIC_SEARCH_MAX_FILES = 100;     // 单次最多搜索文件数

const workerId = workerData.id;
const ALLOWED_ROOTS = [
  resolve(homedir(), ".openclaw"),
];

const rootsReady = (async () => {
  try {
    const base = join(homedir(), ".openclaw");
    ALLOWED_ROOTS.length = 0;
    ALLOWED_ROOTS.push(await realpath(base));
  } catch {
    ALLOWED_ROOTS.length = 0;
    ALLOWED_ROOTS.push(resolve(homedir(), ".openclaw"));
  }
})();

let portClosed = false;

const MAX_CONCURRENT = 3;        // 每个Worker最多同时跑3个任务
const MAX_QUEUE_DEPTH = 50;      // 排队队列最大深度，超过后新任务返回 QUEUE_FULL 错误
let activeCount = 0;             // 当前活跃任务数
const pendingQueue = [];         // 排队等待的任务

// 🧠 设计决策：CHAIN_TASK_TIMEOUT=120000（链式任务超时2min）。
// Worker里链式任务（如route-quick→route-system→route-intent链）
// 每次单个任务超时60s（TASK_TIMEOUT_MAP.default.kill），
// 2min够3个链式步骤各跑60s。设太短（60s）会在正常3步链
// 中频繁超时，设太长（5min）会在无限循环链中浪费资源。
const CHAIN_TASK_TIMEOUT = 120000;

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`任务超时: ${label} (${timeoutMs}ms)`)), timeoutMs)
    ),
  ]);
}

parentPort.on("close", () => { portClosed = true; });

function runTask(task) {
  if (portClosed) return;
  activeCount++;
  const { jobId } = task;
  (async () => {
    try {
      const effectiveTimeout = task.timeout || CHAIN_TASK_TIMEOUT;
      const result = await withTimeout(executeTask(task), effectiveTimeout, task.type);
      if (!portClosed) parentPort.postMessage({ jobId, type: "result", data: result });
    } catch (err) {
      if (!portClosed) parentPort.postMessage({
        jobId, type: "error",
        error: JSON.stringify({ code: err.code || "UNKNOWN", message: err.message }),
      });
    } finally {
      activeCount--;
      // 🧠 可判定终止: 任务完成后清理 partialResult 存储
      partialResultStore.delete(jobId);
      // 🧠 [设计决策] Worker内部链式串行：用户定的。子agent返回几千字报告可能会卡，
      // 但Worker返回几十字节不会。串行不卡主线程，所以未改并行。
      // （详见 memory/known-design-decisions.md — Worker池设计）
      if (pendingQueue.length > 0) {
        const next = pendingQueue.shift();
        runTask(next);
      }
    }
  })().catch((err) => {
    if (err?.message) console.error(`[Worker ${workerId}] 并发错误:`, err.message);
  });
}

parentPort.on("message", (msg) => {
  if (msg.type === "ping") {
    parentPort.postMessage({ jobId: msg.jobId, type: "result", data: { pong: true, worker: workerId, ts: Date.now() } });
    return;
  }
  // 🧠 可判定终止: 探索型任务 partialResult 请求-响应协议
  if (msg.type === "requestPartialResult") {
    const partial = partialResultStore.get(msg.jobId);
    if (!portClosed) {
      parentPort.postMessage({
        jobId: msg.jobId,
        type: "partialResult",
        data: partial || { status: 'running', progress: null, workerId, ts: Date.now() }
      });
    }
    return;
  }
  if (activeCount < MAX_CONCURRENT) {
    runTask(msg);
  } else {
    // 排队等待，不再自动派AI兵（杉哥2026-06-09：AI兵已不走Worker池，无意义）
    pendingQueue.push(msg);
  }
});

// ====== 安全校验 ======

async function validatePath(filePath) {
  await rootsReady;
  if (!filePath) throw Object.assign(new Error("路径不能为空"), { code: "BAD_REQUEST" });
  const isWin = process.platform === "win32";
  const norm = p => isWin ? p.toLowerCase() : p;

  let resolved;
  try {
    resolved = await realpath(filePath);
  } catch (err) {
    if (err.code === "ENOENT") {
      resolved = resolve(normalize(filePath));
    } else {
      throw Object.assign(new Error(`路径解析失败: ${err.message}`), { code: "ACCESS_DENIED" });
    }
  }

  const allowed = ALLOWED_ROOTS.some(root => {
    const normRoot = norm(root);
    const normResolved = norm(resolved);
    if (isWin) {
      return normResolved.startsWith(normRoot + "\\") || normResolved === normRoot;
    }
    const rel = relative(root, resolved);
    return !rel.startsWith("..") && !isAbsolute(rel);
  });
  if (!allowed) throw Object.assign(new Error(`路径不在允许范围内: ${filePath}`), { code: "ACCESS_DENIED" });
  return resolved;
}

// 🧠 设计决策：RETRY_DELAY_MS=200（200ms退避基础间隔）。
// Windows 上 EBUSY/EACCES 通常是短暂的文件锁，200ms足够
// 等锁释放，同时retry3次总延迟不到1s。不用指数退避是因为
// 文件锁通常是瞬态的，长退避反而加延迟。
const RETRY_DELAY_MS = 200;
// 🧠 设计决策：MAX_RETRIES=3（最多retry3次）。
// 每次退避间隔递增（200ms→400ms→600ms），3次总等待约1.2s。
// 1次不够（恰好撞锁），4次+消耗I/O时间。3次折中。
const MAX_RETRIES = 3;

async function readFileRetry(fn, maxRetries = MAX_RETRIES) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      if ((err.code === 'EBUSY' || err.code === 'EACCES') && i < maxRetries - 1) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (i + 1)));
        continue;
      }
      throw err;
    }
  }
}

async function safeReadJson(path) {
  try {
    const content = await readFileRetry(() => readFile(path, "utf-8"));
    return JSON.parse(content);
  } catch { return null; }
}

let _configCache = null;
let _configCacheTime = 0;
const CONFIG_CACHE_TTL = 30000;

async function readModelConfig(provider, modelId) {
  const now = Date.now();
  if (!_configCache || now - _configCacheTime > CONFIG_CACHE_TTL) {
    _configCache = await safeReadJson(join(homedir(), ".openclaw", "openclaw.json"));
    _configCacheTime = now;
  }
  const cfg = _configCache;
  if (!cfg) return null;
  const cleanId = modelId.includes("/") ? modelId.split("/").pop() : modelId;
  const models = cfg?.models?.providers?.[provider]?.models || [];
  return models.find(m => m.id === cleanId) || null;
}

// ====== Embedding 功能 ======

// 延迟 import similarity（仅在语义搜索时加载）
// [removed: migrated to FAISS GPU]

/**
 * 调 Ollama /api/embeddings 获取文本向量
 * 带retry机制和超时处理
 */
async function embedText(text) {
  if (!text || text.trim().length === 0) {
    return { error: 'embedding 文本不能为空' };
  }

  // 截断超长文本（Ollama embedding 模型最大支持 ~8192 token，~6000 字符安全）
  const safeText = text.substring(0, 6000);

  // 从配置读取 Ollama baseUrl 和 embedding 模型
  const { embed: ollamaCfg } = await getOllamaConfig();
  const embeddingModel = await getEmbeddingModel();
  const baseUrl = ollamaCfg.baseUrl; // 配置文件里的 baseUrl

  if (!embeddingModel) {
    return { error: 'embedding 模型未配置，请检查 openclaw.json models.providers.embedding' };
  }

  let lastError = null;
  for (let attempt = 0; attempt <= EMBEDDING_MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);

      const response = await fetch(`${baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: embeddingModel,
          prompt: safeText,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        throw new Error(`Embedding API 返回 ${response.status}: ${errBody.substring(0, 200)}`);
      }

      const data = await response.json();

      if (!data.embedding || !Array.isArray(data.embedding)) {
        throw new Error('Embedding API 返回格式异常：missing embedding 字段');
      }

      return { embedding: data.embedding };
    } catch (err) {
      lastError = err;
      if (attempt < EMBEDDING_MAX_RETRIES) {
        // 指数退避：200ms → 400ms
        await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
        continue;
      }
    }
  }

  return { error: `embedding 失败（retry ${EMBEDDING_MAX_RETRIES} 次后）: ${lastError?.message || '未知错误'}` };
}

/**
 * 从文件内容中提取用于 embedding 的文本摘要
 */
function extractContentForEmbedding(filePath, content) {
  // 取前 SEMANTIC_SEARCH_CHUNK_CHARS 字符
  return content.substring(0, SEMANTIC_SEARCH_CHUNK_CHARS);
}

// ====== 语义搜索（已由 bridge → usearch-bridge 统一管理）======
// Worker不再独立启动搜索进程，语义搜索统一走 usearch-bridge.js 单例
// ====== 流式搜索大文件 ======

async function streamSearch(filePath, keyword) {
  const matches = [];
  let lineNum = 0;
  const kw = keyword.toLowerCase();
  const MAX_MATCHES = 1000;

  const stream = createReadStream(filePath, { encoding: "utf-8", highWaterMark: 65536 });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      lineNum++;
      if (line.toLowerCase().includes(kw)) {
        matches.push({ line: lineNum, text: line.trim().substring(0, 200) });
        if (matches.length >= MAX_MATCHES) break;
      }
    }
  } finally {
    stream.destroy();
    try { rl.close(); } catch {}
  }

  return matches;
}

// ====== 子 agent 专用工具列表（模块级常量，统一引用） ======
// v5.37.0: 已清理，子agent路由由 steward-rules.js 的 getToolTiers 统一管理
const SUBAGENT_TOOLS = [];

// ====== 双树快速路由：小树关键词匹配 ======
// LEVEL_RULES 和 LEVEL_TOOL_MAP 定义在 lib/level-rules.js 中
// 修改后无需同步 worker.js 和 task-router.js（该文件已删除）

function routeQuick(text) {
  const kw = (text || "").toLowerCase();
  const result = { matched: false, tool: null, params: {}, confidence: 0 };

  // ====== Step 1: L0-L7 复杂度分类（优先使用，解决了 quickClassify() 闲置缺陷） ======
  let bestLevel = null;
  let maxWeight = 0;
  const matchedLevels = [];

  for (const rule of LEVEL_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(kw)) {
        matchedLevels.push(rule.level);
        if (rule.weight > maxWeight) {
          maxWeight = rule.weight;
          bestLevel = rule.level;
        }
        break;
      }
    }
  }

  if (bestLevel && maxWeight >= 0.5) {
    const levelConfig = LEVEL_TOOL_MAP[bestLevel];
    if (levelConfig) {
      result.matched = true;
      result.tool = levelConfig.tool;
      result.confidence = levelConfig.conf;
      result.params = {
        ...(levelConfig.params || {}),
        level: bestLevel,
        levelConfidence: maxWeight,
        matchedLevels,
      };
      return result;
    }
  }

  // ====== Step 2: 搜索类型细分（记忆/网络/文件，按优先级排序） ======
  const patterns = [
    // 🥇 记忆/日记搜索 — 路由到混合搜索（子agent用memory_hybrid_search.py）
    { regex: /日记|记忆|历史对话|之前说|之前聊|聊过|说过|之前.*事|之前.*话|记不记得|还记得.*吗|recall|remember|过去说过|翻.*日记|查.*日记|搜.*日记|搜.*记忆|memory.*search|之前.*讨论|之前.*决定|之前.*说过|之前.*聊过|查.*历史|翻.*记录|对话记录|Q&A|qa.*log|dialog.*log/i, tool: "memory_search", confidence: 0.98 },

    // 🥇 网络搜索 — 路由到Tavily（直连不需VPN）
    { regex: /网络|网上|网页|网上查|查资料|查.*信息|最新|新闻|今天.*消息|现在.*情况|tavily|search.*web|网上找|搜.*网络|web.*search|online.*search|internet.*search|网上搜|搜.*网上|找.*网上|web_fetch|fetch.*url|打开.*网页|访问.*网站/i, tool: "web_search", confidence: 0.96 },

    // 🥇 通用文件搜索（兜底）
    { regex: /搜索|搜|查找|寻找|搜寻|search|find|query|locate|搜一下|找文件|搜索什么内容|看一看|看一下|找一找|查一查|帮我查查|帮我找找|你去查查|你去看看|帮我搜|帮我找|有没有|哪里能|哪里有|谁有|你知道|帮我看看|hunt ?for|track ?down|poke ?around|root ?around|scope ?out|look ?up|ferret ?out/i, tool: "core_search", confidence: 0.95 },
    { regex: /日志|log|错误|error|warn|报错|查看日志|check ?log|出错了|报错了|挂了|崩了|出啥事了|看看日志|check一下|查查日志|what went wrong|crash|fail/i, tool: "core_processLog", confidence: 0.92 },
    { regex: /改代码|修复|bug|replace|edit|改一下|修修|调一调|弄一弄|整整|帮我改|帮我修修|这个东西坏了|不对劲|不好使了|fix|broken|not working|something wrong|malfunction|glitch/i, tool: "core_bugFix", confidence: 0.9 },
    { regex: /审查|检查代码|review|lint|看看代码/i, tool: "cpu_codeReview", confidence: 0.9 },
    { regex: /系统|体检|诊断|状态|资源|健康检查|system|diagnose|health|看看状态|检查一下|有啥问题|正常运行不|正不正常|还好吗|what.*wrong|check up|what.*going on|is.*ok|health.*check/i, tool: "cpu_diagnose", confidence: 0.9 },
    { regex: /对比|差异|diff|变化|different|compare|区别/i, tool: "cpu_diff", confidence: 0.9 },
    { regex: /批量|多个|同时/i, tool: "core_dispatch", confidence: 0.85 },
    { regex: /调研|研究|调查|了解|查资料|研究一下|research|investigate|analyze|对比|对比分析|帮我了解一下|打听一下|问问|查查资料|看看有啥说法|什么情况|dig ?into|suss ?out|find ?out|look ?into|what.*people.*say|find.*more/i, tool: "cpu_research", confidence: 0.9 },
    { regex: /打开|查看|看下|显示|read|open|view|show|display|打开看看|打开瞅瞅|给我看看|我看看|念一下|读一下|瞅一眼|扫一眼|说说内容|have a look|take a look|glance at|let me see|show me/i, tool: "cpu_batch", confidence: 0.85 },
    { regex: /全盘|扫描|遍历|全局|scan|full.?scan|traverse|翻一翻|全盘翻翻|搜一遍|扫一遍|全部查查|所有文件|everything|every.*file|search.*all|all.*search/i, tool: "cpu_scan", confidence: 0.9 },
    { regex: /设计|方案|架构|规划|蓝图|策划|体系|design|plan|architecture|blueprint|framework|roadmap|proposal|白皮书/i, tool: "cpu_orchestrate", confidence: 0.9 },
    { regex: /监控.*子agent|子agent.*监控|子agent.*状态|子agent.*卡死|subagent.*monitor|monitor.*subagent|查看.*子agent|子agent.*列表|子agent.*快照/i, tool: "cpu_monitorSubagents", confidence: 0.92 },
    { regex: /日记|对话记录|聊过什么|说过什么|搜.*日记|查.*日记|翻.*日记|翻.*记录|查.*记录|回看.*对话|回顾.*对话|之前.*说过|之前.*聊过|之前.*讨论|之前.*决定|回忆|recall.*dialog|dialog.*search|dialog.*recall|对话检索|历史.*对话|对话.*历史/i, tool: "cpu_dialogRecall", confidence: 0.95 },

    // ====== 🆕 扩展规则（2026-06-05 新增：日常口语/哲学/心理学/文学/逻辑）======

    // 🆕 日常口语桥接 — 口语层→操作层映射（置信度0.45-0.88）
    { regex: /帮我查查|帮我搜一下|帮我查一下|帮我搜搜|帮我找找|帮我搜索/i, tool: "cpu_search", confidence: 0.88 },
    { regex: /你看看这个|帮我看看|给我看看|你看一下|你看一看|你瞅瞅/i, tool: "cpu_batch", confidence: 0.75 },
    { regex: /怎么回事|这是怎么回事|这是什么情况|什么情况|怎么啦|咋回事|什么鬼/i, tool: "core_memorySearch", confidence: 0.70 },
    { regex: /怎么办|咋办|怎么弄|怎么搞|如何处理|该怎么做/i, tool: "cpu_orchestrate", confidence: 0.80 },
    { regex: /帮我(弄|搞|处理|看看|查查|整整)/i, tool: "cpu_orchestrate", confidence: 0.65 },
    { regex: /能不能帮我|能不能.*帮我|可以帮我|可不可以帮我/i, tool: "cpu_orchestrate", confidence: 0.55 },
    { regex: /把.*(弄|整|处理|搞).*(一下|下)/i, tool: "cpu_orchestrate", confidence: 0.45 },
    { regex: /请问|请教|问一下|想问/i, tool: "core_memorySearch", confidence: 0.50 },

    // 🆕 哲学思辨 — 概念澄清/假设推演/伦理判断（置信度0.35-0.85）
    { regex: /这么做(对吗|真的对吗|是不是对的|合理吗|正当吗|应该吗)/i, tool: "core_memorySearch", confidence: 0.85 },
    { regex: /意义.*(何在|在哪|是什么)|存在.*(意义|本质)/i, tool: "core_memorySearch", confidence: 0.80 },
    { regex: /先有.*后(有|是)|因果.*先后/i, tool: "core_memorySearch", confidence: 0.85 },
    { regex: /(到底|究竟)什么是.*(本质|终极|真正|真实)/i, tool: "core_memorySearch", confidence: 0.70 },
    { regex: /有没有可能(其实|只是|不过)|会不会其实|可不可能/i, tool: "core_memorySearch", confidence: 0.75 },
    { regex: /(从|换).*(角度|视角|维度|层面|立场).*(看|分析|理解|思考)/i, tool: "core_memorySearch", confidence: 0.70 },
    { regex: /选择.*(自由|被迫|自愿|可选)|自由意志/i, tool: "core_memorySearch", confidence: 0.78 },
    { regex: /(重来|再来|重新|当初).*(选择|决定|选)/i, tool: "core_memorySearch", confidence: 0.72 },
    { regex: /(本质|意味).*(是什么|到底|究竟)/i, tool: "core_memorySearch", confidence: 0.65 },
    { regex: /(怎么|如何).*(证明|证实|确认|验证)|怎么知道.*是真/i, tool: "core_memorySearch", confidence: 0.55 },
    { regex: /(凭什么|这样公平|这样合理|公平.*合理)/i, tool: "core_memorySearch", confidence: 0.50 },
    { regex: /(自相矛盾|逻辑不通|不合理|说不过去)/i, tool: "core_memorySearch", confidence: 0.50 },
    { regex: /(公平|公正|正义)/i, tool: "core_memorySearch", confidence: 0.35 },
    { regex: /(矛盾|悖论)/i, tool: "core_memorySearch", confidence: 0.40 },

    // 🆕 心理学情绪 — 情绪表达/心理咨询/性格分析（置信度0.50-0.90）
    { regex: /(我好|我有点|我感觉|我觉得).*(焦虑|抑郁|难受|压抑|烦躁|emo)/i, tool: "core_memorySearch", confidence: 0.90 },
    { regex: /怎么.*(调整|改善|改变).*(情绪|心态|心理|状态)/i, tool: "core_memorySearch", confidence: 0.80 },
    { regex: /(梦境|梦到|潜意识|投射|防御|依恋)/i, tool: "core_memorySearch", confidence: 0.75 },
    { regex: /(讨好型|回避型|edges缘型|焦虑型|依恋型)人格/i, tool: "core_webSearch", confidence: 0.75 },
    { regex: /(焦虑|抑郁|压力大|emo|emo了|好烦|不开心|烦躁)/i, tool: "core_memorySearch", confidence: 0.70 },
    { regex: /(原生家庭|童年阴影|童年创伤|缺爱)/i, tool: "core_memorySearch", confidence: 0.70 },
    { regex: /(睡不着|失眠|入睡困难|睡眠.*不好|噩梦)/i, tool: "core_memorySearch", confidence: 0.70 },
    { regex: /(心理|情绪|人格|性格|认知|行为)/i, tool: "core_memorySearch", confidence: 0.60 },
    { regex: /(弗洛伊德|荣格|阿德勒|马斯洛|MBTI|INFJ|INTP)/i, tool: "core_webSearch", confidence: 0.50 },
    { regex: /(正念|冥想|认知行为|CBT|内观)/i, tool: "core_webSearch", confidence: 0.55 },

    // 🆕 文学 — 阅读评论/写作手法/文艺分析（置信度0.70-0.80）
    { regex: /读后感|书评|书单|推荐.*书|读了.*(书|文章)/i, tool: "core_memorySearch", confidence: 0.80 },
    { regex: /(比喻|拟人|排比|修辞|写作手法)/i, tool: "core_codeEditor", confidence: 0.70 },
    { regex: /(意境|描写|散文|诗歌|小说|叙事|抒情)/i, tool: "core_memorySearch", confidence: 0.80 },
    { regex: /(人物|情节|场景|倒叙|线索|冲突)/i, tool: "core_memorySearch", confidence: 0.75 },
    { regex: /(赏析|评价|感受|体验).*(书|文章|作品|电影|诗)/i, tool: "core_memorySearch", confidence: 0.75 },

    // 🆕 逻辑推理 — 件/因果/推导/审查（置信度0.15-0.50）
    { regex: /(由此可见|综上|综上所述|论据|论证|推导)/i, tool: "core_memorySearch", confidence: 0.50 },
    { regex: /(逻辑.*错|逻辑.*谬|谬误|偷换概念|循环论证)/i, tool: "core_memorySearch", confidence: 0.40 },
    { regex: /(因为.*导致|根本原因|根因分析|追溯|归因)/i, tool: "core_memorySearch", confidence: 0.20 },
    { regex: /(只有.*才(能|会)|除非.*否则|当且仅当)/i, tool: "core_memorySearch", confidence: 0.15 },
  ];

  for (const p of patterns) {
    if (p.regex.test(kw) && p.confidence > result.confidence) {
      result.matched = true;
      result.tool = p.tool;
      result.confidence = p.confidence;
    }
  }

  return result;
}

// ====== 双树系统状态评估 ======

function routeSystem(text) {
  // Worker 级轻量系统评估
  const memUsage = process.memoryUsage();
  const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
  const rssMB = Math.round(memUsage.rss / 1024 / 1024);

  let loadLevel = "green";
  const issues = [];

  if (rssMB > 1024) { loadLevel = "yellow"; issues.push(`RSS 内存高: ${rssMB}MB`); }
  if (heapUsedMB > 512) { loadLevel = "yellow"; issues.push(`Heap 使用高: ${heapUsedMB}MB`); }
  if (rssMB > 2048) { loadLevel = "red"; }

  return {
    loadLevel,
    details: {
      rssMB,
      heapUsedMB,
      uptime: process.uptime(),
      issues,
    },
  };
}

// ====== 双树任务意图解析 ======

function routeIntent(text) {
  const kw = (text || "").toLowerCase();

  let taskType = "查询类";
  if (/搜索|查找|搜/.test(kw)) taskType = "搜索类";
  else if (/修改|修复|bug|replace|edit|删除|写入|创建/.test(kw)) taskType = "修改类";
  else if (/分析|stats|计算|聚合|比较/.test(kw)) taskType = "分析类";
  else if (/调研|研究|调查|了解|对比/.test(kw)) taskType = "调研类";
  else if (/打开|查看|看下|显示|访问/.test(kw)) taskType = "查询类";

  let urgency = "normal";
  if (/紧急|马上|立刻|尽快/.test(kw)) urgency = "high";
  if (/不急|有空|稍后/.test(kw)) urgency = "low";

  let danger = false;
  if (/删除|清空|格式化|reset|shutdown|重启|关机|关闭|关掉/.test(kw)) danger = true;

  return {
    taskType,
    intent: kw.substring(0, 200),
    scope: "local",
    urgency,
    dangerDetected: danger,
    constraints: danger ? ["需要用户确认"] : [],
  };
}

// ====== 双树能力edges界扫描 ======

function routeCapability(text) {
  // 子agent能干的关键词检测：代码修改/审查/编写/方案设计等 → 移除直接工具，强制走子agent
  const subagentKeywords = /修改|改代码|修复|bug|审查|review|write|写|创建|新建|编辑|代码|编码|设计|方案|架构|写代码|开发|实现|重构|优化|整理|生成/i;
  const isSubagentTask = subagentKeywords.test(text || "");

  const baseDirectTools = [
    "core_stats",
  ];

  return {
    directTools: baseDirectTools,
    compoundTools: ["cpu_orchestrate"],
    fallback: "subagent",
    gaps: isSubagentTask
      ? ['该任务建议派新子agent执行（子agent上下文干净，不易幻觉，且可并行）']
      : [],
  };
}

// ====== 双树策略生成 ======

function routeStrategy(quick, system, intent, capability, decompose = { decomposed: false }) {
  // 系统状态红 → 只汇报
  if (system.loadLevel === "red") {
    return {
      tree: "big",
      decision: null,
      strategy: "block",
      risk: "high",
      message: `系统负载过高 (${system.details.issues?.join(", ") || "未知"})，仅限汇报操作`,
    };
  }

  // 小树高置信度匹配 + 系统正常 → 判断是否走子agent
  if (quick.matched && quick.confidence >= 0.9 && system.loadLevel !== "red") {
    if (SUBAGENT_TOOLS.includes(quick.tool)) {
      let subagentStrategy = "parallel";
      if (system.loadLevel === "yellow") subagentStrategy = "serial";
      return {
        tree: "small",
        decision: null,
        strategy: "subagent",
        recommendedTool: quick.tool,
        risk: "low",
        message: `该工具（${quick.tool}）可通过子agent执行，派新子agent更高效`,
        subagentStrategy,
      };
    }
    let strategy = "concurrent";
    if (system.loadLevel === "yellow") strategy = "serial";
    return {
      tree: "big",
      decision: quick.tool,
      params: quick.params || {},
      confidence: quick.confidence,
      strategy,
      risk: "low",
    };
  }

  // 小树中等置信度 → 判断是否走子agent
  if (quick.matched && quick.confidence >= 0.6) {
    if (SUBAGENT_TOOLS.includes(quick.tool)) {
      return {
        tree: "small",
        decision: null,
        strategy: "subagent",
        recommendedTool: quick.tool,
        risk: "medium",
        message: `该工具（${quick.tool}）可通过子agent执行，派新子agent`,
        subagentStrategy: "serial",
      };
    }
    return {
      tree: "big",
      decision: quick.tool,
      params: quick.params || {},
      confidence: quick.confidence,
      strategy: system.loadLevel === "yellow" ? "degraded" : "serial",
      risk: "medium",
    };
  }

  // 危险操作
  if (intent.dangerDetected) {
    return {
      tree: "big",
      decision: null,
      strategy: "block",
      risk: "high",
      message: "检测到危险操作，需要用户确认",
      dangerType: intent.intent.substring(0, 100),
    };
  }

  // decompose 兜底：无工具匹配但分解结果有效 → 返回 decompose 策略
  if (decompose?.decomposed === true && (decompose?.steps?.length || 0) >= 2) {
    return {
      tree: "big",
      decision: null,
      strategy: "decompose",
      risk: "low",
      message: `任务已自动分解为 ${decompose.steps.length} 个子步骤，建议派子 agent 分步执行`,
      decompose: {
        taskId: decompose.taskId,
        steps: (decompose.steps || []).map(s => ({
          step: s.step,
          description: (s.description || '').substring(0, 120),
          action: s.action || `step-${s.step}`,
          tool: s.tool || 'spawn_subagent',
          timeoutMs: s.timeoutMs || 60000,
        })),
        recommendedConcurrency: decompose.recommendedConcurrency || 2,
      },
      recommendedConcurrency: decompose.recommendedConcurrency || 2,
    };
  }

  // 完全不匹配
  return {
    tree: "big",
    decision: null,
    strategy: "subagent",
    risk: "medium",
    message: "无直接工具匹配，建议派子 agent 兜底",
    intentType: intent.taskType,
  };
}

// ====== Worker E: 笛卡尔分解律（任务分解层） ======

/**
 * Worker E：在双树评估的大树阶段对 L5+ 任务进行深度分解。
 * 调用 lib/decomposer.js 的 routeDecompose 核心函数。
 *
 * @param {string} text - 原始任务文本
 * @returns {Promise<object>} 分解结果（含 DAG + pipeline 定义）
 */
async function routeDecompose(text) {
  try {
    const result = await decomposeTaskBody(text || '');
    // 添加 Worker 元数据
    return {
      ...result,
      workerId,
      evaluatedAt: Date.now(),
    };
  } catch (err) {
    // 解构失败 → 返回单步骤兜底
    return {
      taskId: (await import('crypto')).default.createHash('sha256').update(text || '', 'utf-8').digest('hex').substring(0, 12),
      decomposed: false,
      steps: [{ step: 1, description: (text || '').substring(0, 200), action: '完整', tool: 'spawn_subagent', timeoutMs: 120000, retryMax: 0 }],
      pipeline: null,
      filePaths: [],
      recommendedConcurrency: 1,
      note: `分解器异常: ${err.message}，降级为单步骤`,
      error: err.message,
    };
  }
}

// ====== Robocopy 辅助函数 ======

/**
 * 运行 robocopy 同步命令
 * @param {string} src - 源目录
 * @param {string} dst - 目标目录
 * @param {string[]} args - robocopy 参数列表
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string}>}
 */
// ★ 跨平台路径修复：用 SystemRoot 环境变量代替硬编码 C:\Windows
const isWin = process.platform === 'win32';
const robocopyExe = isWin
  ? join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'robocopy.exe')
  : 'rsync';

async function runRobocopy(src, dst, args) {
  return new Promise((resolve, reject) => {
    const child = execFile(robocopyExe, [src, dst, ...args], {
      timeout: 300000, // 5min超时
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      windowsHide: true,
    }, (err, stdout, stderr) => {
      // robocopy 用 exit code 表示状态：0-7 成功，8+ 错误
      const exitCode = err?.code ?? (err ? -1 : 0);
      if (err && exitCode >= 8) {
        resolve({ exitCode, stdout: stdout || '', stderr: stderr || '', error: err.message });
      } else {
        resolve({ exitCode, stdout: stdout || '', stderr: stderr || '' });
      }
    });
  });
}

// ====== 任务执行 ======

async function executeTask(task) {
  const { type, provider, modelId, text, files, keyword, minResults, priority } = task;

  switch (type) {

    case "resolve-model": {
      let ctxWindow = 131072, maxTokens = 16384;
      const found = await readModelConfig(provider, modelId);
      if (found) {
        ctxWindow = found.contextWindow || 131072;
        maxTokens = found.maxTokens || 16384;
      }
      const cleanId = modelId.includes("/") ? modelId.split("/").pop() : modelId;
      return {
        id: `${provider}/${cleanId}`, provider,
        contextWindow: ctxWindow, maxTokens,
        capabilities: { completion: true, chat: true, function_calling: true, streaming: true, vision: false },
      };
    }

    case "search-text": {
      const kw = (text ?? keyword);
      if (!kw) throw Object.assign(new Error("missing搜索关键词"), { code: "BAD_REQUEST" });
      const maxFiles = task.maxFiles ?? 50;
      const paths = (files || []).slice(0, maxFiles);
      const results = [];
      const minHits = (typeof minResults === 'number' && minResults > 0) ? minResults : (task.maxMinResults || 5);
      let totalMatches = 0;
      let stoppedEarly = false;

      for (const raw of paths) {
        // 有限理性早停：搜索达到足够匹配数后不再继续搜剩余文件
        if (totalMatches >= minHits) {
          stoppedEarly = true;
          break;
        }
        try {
          const fp = await validatePath(raw);
          const matches = await streamSearch(fp, kw);
          if (matches.length > 0) {
            results.push({ file: fp, matchCount: matches.length, matches });
            totalMatches += matches.length;
          }
        } catch (err) {
          results.push({ file: raw, error: err.message });
        }
        // 🧠 可判定终止: 探索型任务每处理一个文件就存储中间进度
        storePartial(task.jobId, {
          progress: `${results.length}/${paths.length} 文件已搜索`,
          partialMatches: totalMatches,
          filesProcessed: results.length,
          totalFiles: paths.length,
          taskType: 'search-text',
        });
      }
      return {
        keyword: kw,
        total: totalMatches,
        minResults: minHits,
        stoppedEarly,
        results,
      };
    }

    case "dialog-search": {
      const kw = (text ?? keyword);
      if (!kw) throw Object.assign(new Error("missing搜索关键词"), { code: "BAD_REQUEST" });
      const MAX_DIALOG_FILES = 50;
      const paths = (files || []).slice(0, MAX_DIALOG_FILES);
      const results = [];

      for (const raw of paths) {
        try {
          const fp = await validatePath(raw);
          // 逐行搜索并stats文件总行数
          const matches = [];
          let lineNum = 0;
          let totalLines = 0;
          let contextBuffer = [];
          const CONTEXT_WINDOW = task.withContext ? 3 : 0; // 上下文行数
          const MAX_DIALOG_MATCHES = 500;
          const kwLower = kw.toLowerCase();

          const stream = createReadStream(fp, { encoding: "utf-8", highWaterMark: 65536 });
          const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
          let foundAny = false;
          try {
            for await (const line of rl) {
              lineNum++;
              totalLines++;

              // 上下文缓存：保存最近 CONTEXT_WINDOW 行
              if (task.withContext && CONTEXT_WINDOW > 0) {
                contextBuffer.push({ lineNum, text: line });
                if (contextBuffer.length > CONTEXT_WINDOW) contextBuffer.shift();
              }

              if (line.toLowerCase().includes(kwLower)) {
                foundAny = true;
                const matchEntry = { line: lineNum, text: line.trim().substring(0, 200) };
                // 附带前文上下文
                if (task.withContext && CONTEXT_WINDOW > 0 && contextBuffer.length > 1) {
                  matchEntry.before = contextBuffer
                    .slice(0, -1)
                    .map(c => ({ line: c.lineNum, text: c.text.trim().substring(0, 200) }));
                }
                matches.push(matchEntry);
                if (matches.length >= MAX_DIALOG_MATCHES) break;
              }
            }
          } finally {
            stream.destroy();
            try { rl.close(); } catch {}
          }

          if (foundAny) {
            results.push({
              file: fp,
              matchCount: matches.length,
              totalLines,
              matches: task.withContext ? matches : matches.map(m => ({ line: m.line, text: m.text })),
            });
          }
        } catch (err) {
          results.push({ file: raw, error: err.message });
        }
        // 🧠 可判定终止: 每处理一个文件存储中间进度
        storePartial(task.jobId, {
          progress: `${results.length}/${MAX_DIALOG_FILES} 日记文件已搜索`,
          partialMatches: results.reduce((a, b) => a + (b.matchCount || 0), 0),
          filesProcessed: results.length,
          totalFiles: MAX_DIALOG_FILES,
          taskType: 'dialog-search',
        });
      }
      return {
        keyword: kw,
        total: results.reduce((a, b) => a + (b.matchCount || 0), 0),
        results,
      };
    }

    case "semantic-search": {
      const query = task.query || keyword;
      if (!query) throw Object.assign(new Error('missing搜索查询'), { code: 'BAD_REQUEST' });
      // 语义搜索已移至 bridge → usearch-bridge.js 管理
      // Worker不再直接调语义搜索，请通过 bridge.js 查询
      throw Object.assign(new Error('语义搜索请走 bridge → usearch-bridge.js'), { code: 'SEARCH_MAIN_THREAD' });
    }

    case "process-log": {
      if (!files || files.length === 0) throw Object.assign(new Error("未指定文件"), { code: "BAD_REQUEST" });
      const stats = [];
      const MAX_FILES = 20;
      const MAX_LINES = 500000;
      const paths = files.slice(0, MAX_FILES);
      for (const raw of paths) {
        try {
          const fp = await validatePath(raw);
          const { size } = await stat(fp);
          const sizeKB = Math.round(size / 1024);
          let totalLines = 0;
          const levels = { error: 0, warn: 0, info: 0, debug: 0 };
          let truncated = false;
          const stream = createReadStream(fp, { encoding: "utf-8", highWaterMark: 65536 });
          const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
          try {
            for await (const line of rl) {
              if (totalLines >= MAX_LINES) { truncated = true; break; }
              totalLines++;
              if (/^\s*(?:ERROR|Error|error|FATAL|Fatal|fatal|CRITICAL|Critical|critical)\b/.test(line) || /\[\s*(?:ERROR|Error|error|FATAL|Fatal|fatal|CRITICAL|Critical|critical)\s*\]/.test(line)) levels.error++;
              if (/^\s*(?:WARN|Warn|warn|WARNING|Warning|warning)\b/.test(line) || /\[\s*(?:WARN|Warn|warn|WARNING|Warning|warning)\s*\]/.test(line)) levels.warn++;
              if (/^\s*(?:INFO|Info|info)\b/.test(line) || /\[\s*(?:INFO|Info|info)\s*\]/.test(line)) levels.info++;
              if (/^\s*(?:DEBUG|Debug|debug|TRACE|Trace|trace)\b/.test(line) || /\[\s*(?:DEBUG|Debug|debug|TRACE|Trace|trace)\s*\]/.test(line)) levels.debug++;
            }
          } finally {
            stream.destroy();
            try { rl.close(); } catch {}
          }
          stats.push({ file: fp, totalLines, levels, sizeKB, truncated });
        } catch (err) {
          stats.push({ file: raw, error: err.message });
        }
        // 🧠 可判定终止: 每处理一个日志文件存储中间进度
        storePartial(task.jobId, {
          progress: `${stats.length}/${paths.length} 日志文件已分析`,
          filesProcessed: stats.length,
          totalFiles: paths.length,
          taskType: 'process-log',
        });
      }
      return { stats };
    }

    case "diff": {
      if (!files || files.length === 0) throw Object.assign(new Error("未指定文件"), { code: "BAD_REQUEST" });
      const MAX_FILES = 20;
      const paths = files.slice(0, MAX_FILES);
      const results = [];
      for (const raw of paths) {
        try {
          const fp = await validatePath(raw);
          const { size: fileSize } = await stat(fp);
          if (fileSize > 50 * 1024 * 1024) {
            results.push({ file: fp, error: `文件过大(${Math.round(fileSize / 1024 / 1024)}MB)，超过50MB上限` });
            continue;
          }
          const content = await readFile(fp, "utf-8");
          const lines = content.split("\n");
          let added = 0, removed = 0, changedFiles = 0;
          let currentFile = "";
          const fileChanges = [];
          for (const line of lines) {
            if (line.startsWith("diff --git")) {
              if (currentFile) fileChanges.push({ file: currentFile, added, removed });
              currentFile = line.split(" ").pop() || "";
              added = 0; removed = 0;
              changedFiles++;
            } else if (line.startsWith("+") && !line.startsWith("+++")) added++;
            else if (line.startsWith("-") && !line.startsWith("---")) removed++;
          }
          if (currentFile) fileChanges.push({ file: currentFile, added, removed });
          results.push({ file: fp, changedFiles, totalAdded: fileChanges.reduce((a, b) => a + b.added, 0), totalRemoved: fileChanges.reduce((a, b) => a + b.removed, 0), fileChanges });
        } catch (err) {
          results.push({ file: raw, error: err.message });
        }
      }
      return { totalFiles: results.length, results };
    }

    // ====== 双树决策引擎任务 ======

    case "route-quick": {
      // 小树快路径：关键词匹配，~50ms Worker 内纯计算
      return routeQuick(text || keyword || "");
    }

    case "route-system": {
      // 系统状态评估
      return routeSystem(text || "");
    }

    case "route-intent": {
      // 任务意图解析
      return routeIntent(text || keyword || "");
    }

    case "route-capability": {
      // 能力edges界扫描
      return routeCapability(text || "");
    }

    case "route-strategy": {
      // 策略生成：合并所有评估结果
      const { quick, system, intent, capability, decompose } = task;
      return routeStrategy(
        quick || { matched: false, tool: null, params: {}, confidence: 0 },
        system || { loadLevel: "green", details: {} },
        intent || { taskType: "查询类", intent: "", scope: "local", urgency: "normal", dangerDetected: false, constraints: [] },
        capability || { directTools: [], compoundTools: [], fallback: "subagent", gaps: [] },
        decompose || { decomposed: false, steps: [], note: '' },
      );
    }

    case "route-decompose": {
      // Worker E: L5+ 笛卡尔分解（task + level 参数）
      return routeDecompose(task.text || task.keyword || "");
    }

    case "ping":
      return { pong: true, worker: workerId, ts: Date.now() };

    // ====== 图片批量分析 ======

    case "image-process": {
      const { imagePath, prompt: visionPrompt } = task;
      if (!imagePath) throw Object.assign(new Error("missing imagePath"), { code: "BAD_REQUEST" });

      const fp = await validatePath(imagePath);

      // 1. Compress with sharp (resize max 1024px, JPEG quality 75)
      const tmpDir = await mkdtemp(join(tmpdir(), 'sansan-img-'));
      const compressedPath = join(tmpDir, 'compressed.jpg');

      try {
        const sharp = (await import('sharp')).default;
        await sharp(fp)
          .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 75 })
          .toFile(compressedPath);
      } catch (compressErr) {
        // Cleanup on failure
        try { await unlink(compressedPath).catch(() => {}); } catch {}
        try { await rmdir(tmpDir).catch(() => {}); } catch {}
        throw Object.assign(new Error(`压缩失败: ${compressErr.message}`), { code: "COMPRESS_FAILED" });
      }

      // 2. Read compressed image as base64
      const compressedBuffer = await readFile(compressedPath);
      const base64Image = compressedBuffer.toString('base64');

      // 3. Cleanup temp files
      try { await unlink(compressedPath).catch(() => {}); } catch {}
      try { await rmdir(tmpDir).catch(() => {}); } catch {}

      // 4. 获取视觉模型配置（从系统配置读取）
      const { embed: ollamaCfg, vision: visionCfg } = await getOllamaConfig();

      // 优先使用用户传入的 model 参数，其次 vision 配置，回退到 embedding 地址
      let visionModel = task.model;
      let ollamaUrl = '';
      let isVisionConfigured = false;

      if (visionCfg.configured) {
        // 有 vision 配置（可能是智谱 API 或 Ollama 视觉）
        // Ollama图片走原生 /api/chat（OpenAI /chat/completions 不支持image_url）
        ollamaUrl = visionCfg.baseUrl ? `${visionCfg.baseUrl.replace(/\/v\d+$/,'')}/api/chat` : `${ollamaCfg.baseUrl || 'http://127.0.0.1:11434'}/api/chat`;
        visionModel = visionModel || visionCfg.model || null;
        isVisionConfigured = true;
      } else if (ollamaCfg.baseUrl) {
        // 回退到 Ollama
        ollamaUrl = `${ollamaCfg.baseUrl}/api/chat`;
        visionModel = visionModel || null;
        isVisionConfigured = false;
      }

      if (!ollamaUrl) {
        return { file: fp, success: false, error: '视觉模型未配置，请在 openclaw.json 中配置 models.providers.vision 或 models.providers.embedding' };
      }

      // 如果 Ollama 也没指定模型，报错
      if (ollamaUrl.includes('api/chat') && !visionModel) {
        return { file: fp, success: false, error: 'Ollama 视觉模型未指定，请在 openclaw.json 中配置 models.providers.vision.models[0].id' };
      }

      const prompt = visionPrompt || '请详细描述这张图片的内容，包括物体、颜色、文字、场景等。';
      const isOpenAICompat = ollamaUrl.includes('/chat/completions');

      let description = '';
      let error = null;

      const buildPayload = () => {
        if (isOpenAICompat) {
          return {
            model: visionModel,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: prompt },
                  { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } },
                ],
              },
            ],
          };
        }
        return {
          model: visionModel,
          stream: false,
          messages: [
            {
              role: 'user',
              content: prompt,
              images: [base64Image],
            },
          ],
        };
      };

      const buildHeaders = () => {
        const headers = { 'Content-Type': 'application/json' };
        if (visionCfg.apiKey) {
          headers['Authorization'] = `Bearer ${visionCfg.apiKey}`;
        }
        return headers;
      };

      const parseResponse = (data) => {
        if (isOpenAICompat) {
          return data?.choices?.[0]?.message?.content || JSON.stringify(data);
        }
        return data?.message?.content || JSON.stringify(data);
      };

      try {
        const payload = buildPayload();
        const resp = await fetch(ollamaUrl, {
          method: 'POST',
          headers: buildHeaders(),
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(120000),
        });

        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          error = `视觉 API 返回 ${resp.status}: ${errText.substring(0, 200)}`;
        } else {
          const data = await resp.json();
          description = parseResponse(data);
        }
      } catch (fetchErr) {
        // Try fallback for Ollama: base64 in content field (some Ollama versions)
        if (!isOpenAICompat) {
          try {
            const resp2 = await fetch(ollamaUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model: visionModel,
                stream: false,
                messages: [
                  {
                    role: 'user',
                    content: [
                      { type: 'text', text: prompt },
                      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } },
                    ],
                  },
                ],
              }),
              signal: AbortSignal.timeout(120000),
            });

            if (!resp2.ok) {
              error = `视觉 API 失败: ${fetchErr.message} (fallback: ${resp2.status})`;
            } else {
              const data2 = await resp2.json();
              description = data2?.message?.content || JSON.stringify(data2);
            }
          } catch (fallbackErr) {
            error = `视觉 API 调用失败: ${fetchErr.message}; fallback: ${fallbackErr.message}`;
          }
        } else {
          error = `视觉 API 调用失败: ${fetchErr.message}`;
        }
      }

      return {
        file: fp,
        success: !error,
        description: description || undefined,
        error: error || undefined,
      };
    }

    case "sync-archive": {
      const { target, quick } = task;
      if (!target || !['E', 'G'].includes(target)) {
        throw Object.assign(new Error(`无效同步目标: ${target}`), { code: "BAD_REQUEST" });
      }

      const src = join(homedir(), ".openclaw");
      const dst = `${target}:\\\\.openclaw`;
      const roboBase = ['/ZB', '/R:5', '/W:5', '/NP', '/NDL', '/NJH', '/NJS', '/XJ'];

      if (quick) {
        // 快速模式：只同步 dialog 目录 + 核心 .md
        const dialogSrc = join(src, 'workspace', 'memory', 'dialog');
        const dialogDst = join(dst, 'workspace', 'memory', 'dialog');
        const dialogResult = await runRobocopy(dialogSrc, dialogDst, [...roboBase, '/MIR']);

        const wsSrc = join(src, 'workspace');
        const wsDst = join(dst, 'workspace');
        const wsResult = await runRobocopy(wsSrc, wsDst, [...roboBase, '/MIR', '/IF', '*.md', '/XD', 'node_modules', '.git']);

        return {
          target,
          mode: 'quick',
          dialog: { exitCode: dialogResult.exitCode, error: dialogResult.error },
          workspace: { exitCode: wsResult.exitCode, error: wsResult.error },
          timestamp: new Date().toISOString(),
        };
      }

      // 完整模式：同步全部，只排 node_modules
      const fullResult = await runRobocopy(src, dst, [...roboBase, '/MIR', '/XD', 'node_modules']);

      return {
        target,
        mode: 'full',
        exitCode: fullResult.exitCode,
        error: fullResult.error,
        timestamp: new Date().toISOString(),
      };
    }

    case "dispatch-subagent": {
      const subPrompt = task.prompt || '';
      const subModel = task.model || 'deepseek/deepseek-v4-flash';
      const subTimeout = Number(task.timeout) || 300;
      if (!subPrompt) throw Object.assign(new Error('dispatch-subagent missing prompt'), { code: "BAD_REQUEST" });
      try {
        const resp = await fetch('http://localhost:18792/spawn_subagent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: subPrompt,
            model: subModel,
            timeout: subTimeout,
            maxRounds: 100,
            taskName: task.taskName || task.name || task.description || 'dispatch-subagent',
            batchName: task.batchName || '',
            groupName: task.groupName || ''
          }),
          signal: AbortSignal.timeout((subTimeout + 10) * 1000)
        });
        if (!resp.ok) throw new Error(`Sidecar 返回 ${resp.status}`);

        // 拿到子Agent ID和结果文件路径，每15s查一次进度
        const spawnResult = await resp.json();
        const subId = spawnResult.id || '';
        const outputPath = spawnResult.outputPath || '';

        if (subId && outputPath) {
          // 异步轮询：每15s读一次结果文件，直到完成或超时
          const { readFile, stat } = await import('fs/promises');
          const { existsSync } = await import('fs');
          const pollStart = Date.now();
          const pollTimeout = (subTimeout + 5) * 1000;

          while (Date.now() - pollStart < pollTimeout) {
            await new Promise(r => setTimeout(r, 15000)); // 15s间隔

            if (existsSync(outputPath)) {
              try {
                const stateContent = await readFile(outputPath, 'utf8');
                const state = JSON.parse(stateContent);
                const s = state.status || '';
                // 只在状态变化时输出
                if (s === 'success' || s === 'completed') {
                  spawnResult._status = s;
                  spawnResult._result = state.output || state.data || {};
                  break;
                }
                if (s === 'error' || s === 'timeout' || s === 'failed') {
                  spawnResult._status = s;
                  spawnResult._error = state.error || '子Agent异常结束';
                  break;
                }
              } catch {}
            }
          }
          spawnResult._polled = (Date.now() - pollStart) + 'ms';
        }

        return spawnResult;
      } catch (e) {
        // Sidecar挂了 -> Worker自己fork子进程派兵
        try {
          const runnerPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'sidecar', 'subagent-runner.cjs');
          const subId = 'worker-' + Date.now() + '-' + Math.random().toString(36).slice(2,6);
          const diarDir = join(homedir(), '.openclaw', 'workspace', 'memory', 'dialog', 'subagent');
          const taskDir = join(homedir(), '.openclaw', 'workspace', 'memory', 'task-states');
          const outputPath = join(taskDir, subId + '.json');
          const diaryPath = join(diarDir, subId + '.md');
          const argsJson = JSON.stringify({ prompt: subPrompt, model: subModel, timeout: subTimeout, outputPath, diaryPath, maxRounds: 100 });
          const proc = spawn(process.execPath, [runnerPath, argsJson], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: (subTimeout + 10) * 1000 });
          const exitCode = await new Promise((resolve) => { proc.on('exit', resolve); proc.on('error', () => resolve(-1)); });
          if (exitCode !== 0) throw new Error('子Agent退出码: ' + exitCode);
          const { readFile } = await import('fs/promises');
          const { existsSync } = await import('fs');
          if (existsSync(outputPath)) {
            const r = JSON.parse(await readFile(outputPath, 'utf8'));
            return { id: subId, status: r.status || 'completed', outputPath, diaryPath, _fallback: 'worker-fork' };
          }
          return { id: subId, status: 'completed', _fallback: 'worker-fork' };
        } catch (fbErr) {
          throw Object.assign(new Error('派兵失败(Sidecar+Worker都挂了): ' + fbErr.message), { code: 'DISPATCH_FAIL_ALL' });
        }
      }
    }

    default:
      throw Object.assign(new Error(`未知任务类型: ${type}`), { code: "UNKNOWN_TASK" });
  }
}
