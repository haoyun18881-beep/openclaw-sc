/**
 * 🦞 triple-evidence routing决策 — 路由决策triple-evidence记录系统
 *
 * triple-evidence：
 *   本（历史经验）：过去同类任务用了什么工具、成功率、平均耗时
 *   原（实时状态）：当前 Worker 负载、队列深度、内存水位
 *   用（实践反馈）：执行结果、耗时、是否需优化
 *
 * 每次路由决策记录一个结构化 JSON 日志到 shared/route-decisions/
 * 每 100 记录做一次汇总分析
 */

import { join } from "path";
import { homedir, freemem } from "os";
import { readFile, mkdir, readdir, unlink, writeFile, appendFile, rename } from "fs/promises";

// ====== 配置 ======
const DECISIONS_DIR = join(homedir(), ".openclaw", "workspace", "memory", "shared", "route-decisions");
const SUMMARY_INTERVAL = 100; // 每 100 记录做一次汇总
// 🧠 设计决策：MAX_HISTORY_FOR_本=200。查询过去同类任务时最多回溯 200 记录。
// 200 刚好跨越 ~20 min（假设 10 /min的路由密度），覆盖一次完整会话的典型工作时长。
// 多了（500+）会拖慢 collect本() 的加载和stats，少了（<50）模糊匹配不够稳定。
// 配合 24 小时权重衰减（DEFAULT_DECAY_HOURS），老记录权重自然降低，
// 200 上限保证历史经验不会过度稀释新决策的影响。
const MAX_HISTORY_FOR_本 = 200;
const MAX_LOGS_TO_KEEP = 5000; // 最多保留 5000 决策日志
const DEFAULT_DECAY_HOURS = 24; // 过24小时的老记录权重衰减

// 计数器（进程级）
let decisionCounter = 0;
let lastSummaryCount = 0;

// ====== 原子写入辅助（先写.tmp再rename，防止写入中途崩溃导致文件损坏）======
async function atomicWrite(filePath, content, options) {
  const tmpPath = filePath + ".tmp." + Date.now();
  try {
    await writeFile(tmpPath, content, options);
    await rename(tmpPath, filePath);
  } catch (err) {
    // 清理残留.tmp文件
    try { await unlink(tmpPath); } catch {}
    throw err;
  }
}

/**
 * 原子追加到 JSONL 文件（用 fs.promises.appendFile 实现真正的原子追加）
 * 避免 read→modify→write 三步操作导致的并发写入丢失
 */
async function atomicAppendJsonl(filePath, recordJson) {
  try {
    await appendFile(filePath, recordJson + "\n", "utf-8");
  } catch (err) {
    throw err;
  }
}

// ====== 路径辅助 ======
let _dirEnsured = false;

async function ensureDecisionsDir() {
  if (_dirEnsured) return;
  try {
    await mkdir(DECISIONS_DIR, { recursive: true });
    _dirEnsured = true;
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    _dirEnsured = true;
  }
}

/**
 * 获取当天日志文件名（按天分片,防单文件过大）
 */
function getLogFileName() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `route-decisions-${y}-${m}-${d}.jsonl`;
}

/**
 * 获取汇总文件名
 */
function getSummaryFileName() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const h = String(now.getHours()).padStart(2, "0");
  return `route-summary-${y}-${m}-${d}-${h}.json`;
}

// ====== triple-evidence收集 ======

/**
 * 收集「本」证据 — 历史经验分析
 * @param {string} taskDesc - 任务描述
 * @returns {Promise<object>} 历史经验数据
 */
async function collect本(taskDesc) {
  const entries = await loadRecentDecisions(MAX_HISTORY_FOR_本);

  // 分工具stats
  const toolStats = {};
  let totalDecisions = entries.length;

  for (const entry of entries) {
    const tool = entry.decision?.recommendedTool || entry.decision?.decision || "unknown";
    if (!toolStats[tool]) {
      toolStats[tool] = { count: 0, success: 0, timeout: 0, error: 0, totalTimeMs: 0 };
    }
    toolStats[tool].count++;

    const 用 = entry.evidence?.用 || {};
    if (用.status === "success") toolStats[tool].success++;
    else if (用.status === "timeout") toolStats[tool].timeout++;
    else if (用.status === "error") toolStats[tool].error++;

    if (typeof 用.durationMs === "number") {
      toolStats[tool].totalTimeMs += 用.durationMs;
    }
  }

  // 计算成功率
  const toolSummary = Object.entries(toolStats).map(([tool, stats]) => {
    const finished = stats.success + stats.timeout + stats.error;
    return {
      tool,
      total: stats.count,
      successRate: finished > 0 ? (stats.success / finished) : 0,
      avgDurationMs: stats.count > 0 ? Math.round(stats.totalTimeMs / stats.count) : 0,
      failureBreakdown: {
        timeout: stats.timeout,
        error: stats.error,
      },
    };
  }).sort((a, b) => b.total - a.total);

  // 模糊匹配相似任务描述（过去200中找关键词重叠）
  const keywords = extractKeywords(taskDesc);
  let similarTasks = [];
  if (keywords.length > 0) {
    similarTasks = entries
      .filter(e => {
        const kws = extractKeywords(e.task || "");
        return kws.some(k => keywords.includes(k));
      })
      .slice(0, 20)
      .map(e => ({
        task: (e.task || "").substring(0, 80),
        tool: e.decision?.recommendedTool || e.decision?.decision || "unknown",
        confidence: e.decision?.confidence || 0,
        status: e.evidence?.用?.status || "unknown",
        durationMs: e.evidence?.用?.durationMs || null,
      }));
  }

  return {
    totalDecisions,
    toolHistory: toolSummary.slice(0, 15),
    similarTasks: similarTasks.length > 0 ? similarTasks : undefined,
    recentToolCount: toolSummary.length,
  };
}

/**
 * 从任务描述中提取关键词
 */
function extractKeywords(text) {
  if (!text || typeof text !== "string") return [];
  // 过滤停用词，提取有意义的2-4字中文词和英文词
  const stopWords = new Set([
    "的", "了", "是", "在", "有", "和", "就", "不", "人", "都", "一",
    "一个", "上", "也", "很", "到", "说", "要", "去", "你", "会", "着",
    "没有", "看", "好", "自己", "这", "他", "她", "它", "们", "那",
    "the", "a", "an", "is", "are", "was", "were", "be", "been",
    "to", "of", "in", "for", "on", "with", "at", "by", "from",
  ]);
  const words = text.toLowerCase().split(/[\s,，。；;：:、！!？?()（）\[\]【】{}\"'"“”«»《》\/\\]+/);
  const significant = words
    .map(w => w.trim())
    .filter(w => w.length >= 2 && !stopWords.has(w))
    .filter((w, i, arr) => arr.indexOf(w) === i); // 去重
  return significant.slice(0, 10);
}

/**
 * 收集「原」证据 — 当前实时状态
 * @param {object} pool - Worker 池实例
 * @returns {Promise<object>} 实时状态数据
 */
function collect原(pool) {
  const stats = pool?.getStats ? pool.getStats() : {};
  const mem = process.memoryUsage();
  const freeGB = freemem() / 1024 / 1024 / 1024;

  let memLevel = "green";
  if (freeGB < 2) memLevel = "meltdown";
  else if (freeGB < 4) memLevel = "red";
  else if (freeGB < 8) memLevel = "yellow";

  return {
    timestamp: Date.now(),
    pool: {
      totalWorkers: stats.total || 0,
      busyWorkers: stats.busy || 0,
      inFlight: stats.inFlight || 0,
      queueDepth: stats.queueDepth || 0,
      queueHigh: stats.queueHigh || 0,
      queueNormal: stats.queueNormal || 0,
      queueLow: stats.queueLow || 0,
      maxWorkers: stats.maxWorkers || 0,
    },
    memory: {
      freeGB: Math.round(freeGB * 100) / 100,
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      rssMB: Math.round(mem.rss / 1024 / 1024),
      level: memLevel,
    },
    loadLevel: stats.queueDepth > 10 ? "high" : stats.queueDepth > 5 ? "medium" : "low",
  };
}

/**
 * 创建「用」证据占位
 * @param {string} status - pending|success|timeout|error
 * @param {number|null} durationMs - 执行耗时
 * @param {string|null} optimization - 优化建议
 * @returns {object} 实践反馈数据
 */
function create用(status = "pending", durationMs = null, optimization = null) {
  return {
    status,
    durationMs,
    optimization,
    timestamp: Date.now(),
  };
}

// ====== 记录写入 ======

/**
 * 记录一次路由决策（triple-evidence完整写入）
 * @param {object} routeResult - core_routeTask 返回的路由结果
 * @param {string} taskDesc - 原始任务描述
 * @param {object} pool - Worker 池实例（用于收集「原」）
 * @returns {Promise<string>} 记录 ID
 */
export async function recordRouteDecision(routeResult, taskDesc, pool) {
  await ensureDecisionsDir();

  decisionCounter++;

  const recordId = `rd_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

  // 并行收集triple-evidence
  const [历史经验] = await Promise.all([
    collect本(taskDesc),
    // collect原 is synchronous, no need to await
  ]);

  const 实时状态 = collect原(pool);

  const record = {
    id: recordId,
    counter: decisionCounter,
    timestamp: new Date().toISOString(),
    task: (taskDesc || "").substring(0, 500),
    decision: {
      tree: routeResult.tree || "unknown",
      recommendedTool: routeResult.recommendedTool || routeResult.decision || null,
      confidence: routeResult.confidence || 0,
      strategy: routeResult.strategy || "unknown",
      risk: routeResult.risk || "unknown",
      params: routeResult.params || {},
      note: routeResult.note || "",
    },
    evidence: {
      本: {
        totalDecisions: 历史经验.totalDecisions || 0,
        toolHistory: (历史经验.toolHistory || []).slice(0, 10),
        similarTasks: (历史经验.similarTasks || []).slice(0, 5),
        recentToolCount: 历史经验.recentToolCount || 0,
      },
      原: 实时状态,
      用: create用("pending"),
    },
  };

  // 原子追加到当天日志文件
  const logFile = join(DECISIONS_DIR, getLogFileName());
  try {
    await atomicAppendJsonl(logFile, JSON.stringify(record));
  } catch (err) {
    console.warn(`[route-evidence] write failed: ${err.message}`);
  }

  // 每 SUMMARY_INTERVAL 做一次汇总
  if (decisionCounter - lastSummaryCount >= SUMMARY_INTERVAL) {
    lastSummaryCount = decisionCounter;
    try {
      await generateSummary();
    } catch (err) {
      console.warn(`[route-evidence] merge failed: ${err.message}`);
    }
  }

  // 限制日志数量
  if (decisionCounter % 50 === 0) {
    try {
      await limitLogFiles();
    } catch {}
  }

  return recordId;
}

/**
 * 更新「用」证据（实践反馈）
 * @param {string} recordId - 之前记录的 ID
 * @param {string} status - success|timeout|error
 * @param {number|null} durationMs - 执行耗时
 * @param {string|null} optimization - 优化建议
 */
export async function update用Evidence(recordId, status, durationMs = null, optimization = null) {
  await ensureDecisionsDir();

  const todayFile = join(DECISIONS_DIR, getLogFileName());
  try {
    const content = await readFile(todayFile, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    let found = false;

    const updated = lines.map(line => {
      try {
        const record = JSON.parse(line);
        if (record.id === recordId) {
          record.evidence.用 = create用(status, durationMs, optimization);
          found = true;
        }
        return JSON.stringify(record);
      } catch {
        return line;
      }
    });

    if (found) {
      // 写临时文件→rename 原子替换模式，避免并发读取竞态
      const tmpPath = todayFile + ".tmp." + Date.now();
      await writeFile(tmpPath, updated.join("\n") + "\n", "utf-8");
      await rename(tmpPath, todayFile);
    }

    return found;
  } catch (err) {
    console.warn(`[route-evidence] update evidence failed: ${err.message}`);
    return false;
  }
}

// ====== 日志加载与查询 ======

/**
 * 加载最近的决策记录
 * @param {number} limit - 最多加载多少
 * @returns {Promise<Array>} 决策记录数组
 */
async function loadRecentDecisions(limit = 100) {
  await ensureDecisionsDir();

  try {
    const files = await readdir(DECISIONS_DIR);
    const logFiles = files
      .filter(f => f.startsWith("route-decisions-") && f.endsWith(".jsonl"))
      .sort()
      .reverse();

    const entries = [];

    for (const file of logFiles) {
      if (entries.length >= limit) break;
      const fp = join(DECISIONS_DIR, file);
      try {
        const content = await readFile(fp, "utf-8");
        const lines = content.split("\n").filter(Boolean).reverse();
        for (const line of lines) {
          if (entries.length >= limit) break;
          try {
            entries.push(JSON.parse(line));
          } catch {}
        }
      } catch {}
    }

    return entries;
  } catch (err) {
    console.warn(`[route-evidence] load history failed: ${err.message}`);
    return [];
  }
}

// ====== 汇总分析 ======

/**
 * 生成汇总分析报告
 * 分析最近 1000 记录，输出工具使用排名、成功率、瓶颈识别
 */
async function generateSummary() {
  await ensureDecisionsDir();

  const entries = await loadRecentDecisions(SUMMARY_INTERVAL);
  if (entries.length === 0) return;

  const toolStats = {};
  const strategyStats = {};
  let totalSuccess = 0;
  let totalFinished = 0;
  const levelRanges = { green: 0, yellow: 0, red: 0, meltdown: 0 };
  let peakQueueDepth = 0;
  let avgQueueDepth = 0;
  const durations = [];

  for (const entry of entries) {
    const tool = entry.decision?.recommendedTool || entry.decision?.decision || "unknown";
    const strategy = entry.decision?.strategy || "unknown";
    const 用 = entry.evidence?.用 || {};
    const 原 = entry.evidence?.原 || {};

    // 工具stats
    if (!toolStats[tool]) toolStats[tool] = { count: 0, success: 0, timeout: 0, error: 0, pending: 0, totalTimeMs: 0 };
    toolStats[tool].count++;
    if (用.status === "success") { toolStats[tool].success++; totalSuccess++; }
    else if (用.status === "timeout") toolStats[tool].timeout++;
    else if (用.status === "error") toolStats[tool].error++;
    else if (用.status === "pending") toolStats[tool].pending++;

    if (用.status !== "pending") totalFinished++;

    if (typeof 用.durationMs === "number") {
      toolStats[tool].totalTimeMs += 用.durationMs;
      durations.push(用.durationMs);
    }

    // 策略stats
    if (!strategyStats[strategy]) strategyStats[strategy] = 0;
    strategyStats[strategy]++;

    // 状态stats
    const memLevel = 原.memory?.level || "green";
    levelRanges[memLevel] = (levelRanges[memLevel] || 0) + 1;

    const qd = 原.pool?.queueDepth || 0;
    peakQueueDepth = Math.max(peakQueueDepth, qd);
    avgQueueDepth += qd;
  }
  avgQueueDepth = avgQueueDepth / entries.length;

  // 计算平均耗时（成功任务）
  const avgDuration = durations.length > 0
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : null;

  // 工具排名（按调用次数降序）
  const toolRanking = Object.entries(toolStats)
    .map(([tool, stats]) => {
      const finished = stats.success + stats.timeout + stats.error;
      return {
        tool,
        calls: stats.count,
        successRate: finished > 0 ? Math.round((stats.success / finished) * 100) : null,
        avgDurationMs: stats.count > 0 && stats.totalTimeMs > 0
          ? Math.round(stats.totalTimeMs / (stats.success || 1))
          : null,
        pending: stats.pending,
        failures: stats.timeout + stats.error,
      };
    })
    .sort((a, b) => b.calls - a.calls);

  // 瓶颈识别
  const bottlenecks = [];
  for (const rank of toolRanking) {
    if (rank.successRate !== null && rank.successRate < 60) {
      bottlenecks.push({
        tool: rank.tool,
        issue: `成功率仅 ${rank.successRate}%`,
        failures: rank.failures,
        suggestion: "建议检查该工具实现或增加retry机制",
      });
    }
  }

  if (peakQueueDepth > 10) {
    bottlenecks.push({
      tool: "system",
      issue: `队列峰值深度 ${peakQueueDepth}，可能过载`,
      suggestion: "建议增加 Worker 数或限流",
    });
  }

  const summary = {
    id: `summary_${Date.now()}`,
    timestamp: new Date().toISOString(),
    period: {
      analyzedRecords: entries.length,
      from: entries[entries.length - 1]?.timestamp || "unknown",
      to: entries[0]?.timestamp || "unknown",
    },
    overview: {
      totalDecisions: entries.length,
      totalFinished,
      totalSuccess,
      overallSuccessRate: totalFinished > 0
        ? Math.round((totalSuccess / totalFinished) * 100)
        : null,
      avgDurationMs: avgDuration,
      peakQueueDepth,
      avgQueueDepth: Math.round(avgQueueDepth * 10) / 10,
    },
    toolRanking: toolRanking.slice(0, 15),
    strategyDistribution: strategyStats,
    memoryDistribution: levelRanges,
    bottlenecks: bottlenecks.length > 0 ? bottlenecks : undefined,
    recommendation: bottlenecks.length > 0
      ? `检测到 ${bottlenecks.length} 个瓶颈点，建议关注: ${bottlenecks.map(b => b.tool).join(", ")}`
      : "系统运行良好，未发现明显瓶颈",
  };

  // 原子写入汇总文件
  const summaryFile = join(DECISIONS_DIR, getSummaryFileName());
  await atomicWrite(summaryFile, JSON.stringify(summary, null, 2), "utf-8");

  return summary;
}

// ====== 日志管理 ======

/**
 * 限制日志文件数量，删除最旧的超量文件
 */
async function limitLogFiles() {
  try {
    const files = await readdir(DECISIONS_DIR);
    const logFiles = files
      .filter(f => f.startsWith("route-decisions-") && f.endsWith(".jsonl"))
      .sort()
      .reverse();

    if (logFiles.length < 10) return; // 留够10天的量

    const toDelete = logFiles.slice(10);
    for (const f of toDelete) {
      const fp = join(DECISIONS_DIR, f);
      try {
        // 检查文件行数（粗略估算是否需要彻底删）
        const content = await readFile(fp, "utf-8");
        const lineCount = content.split("\n").filter(Boolean).length;
        await unlink(fp);
        // TODO: 移除调试日志 console.log(`[route-evidence] 🧹 清理旧日志: ${f} (${lineCount} 记录)`);
      } catch {}
    }
  } catch {}
}

// ====== 查询接口 ======

/**
 * 查询路由决策历史
 * @param {object} options - { tool, limit }
 * @returns {Promise<Array>} 匹配的决策记录
 */
export async function queryRouteDecisions(options = {}) {
  const { tool, strategy, limit = 20 } = options;
  const entries = await loadRecentDecisions(200);

  let filtered = entries;

  if (tool) {
    filtered = filtered.filter(e =>
      e.decision?.recommendedTool === tool || e.decision?.decision === tool
    );
  }

  if (strategy) {
    filtered = filtered.filter(e => e.decision?.strategy === strategy);
  }

  return filtered.slice(0, limit).map(e => ({
    id: e.id,
    timestamp: e.timestamp,
    task: (e.task || "").substring(0, 100),
    decision: e.decision,
    原: {
      queueDepth: e.evidence?.原?.pool?.queueDepth,
      memoryLevel: e.evidence?.原?.memory?.level,
    },
    用: e.evidence?.用,
  }));
}

/**
 * 获取最新汇总报告
 */
export async function getLatestSummary() {
  await ensureDecisionsDir();

  try {
    const files = await readdir(DECISIONS_DIR);
    const summaryFiles = files
      .filter(f => f.startsWith("route-summary-") && f.endsWith(".json"))
      .sort()
      .reverse();

    if (summaryFiles.length === 0) return null;

    const latest = join(DECISIONS_DIR, summaryFiles[0]);
    const content = await readFile(latest, "utf-8");
    return JSON.parse(content);
  } catch (err) {
    console.error("[route-evidence] getLatestSummary read summary failed:", err?.message || err);
    return null;
  }
}

/**
 * 获取整体stats（供 cpu_stats 等集成）
 */
export async function getRouteStats() {
  await ensureDecisionsDir();

  const files = await readdir(DECISIONS_DIR).catch(() => []);
  const logFiles = files.filter(f => f.startsWith("route-decisions-") && f.endsWith(".jsonl"));
  const summaryFiles = files.filter(f => f.startsWith("route-summary-") && f.endsWith(".json"));

  // 快速估算总记录数（仅读最新文件的行数）
  let totalApprox = 0;
  if (logFiles.length > 0) {
    try {
      const latest = join(DECISIONS_DIR, logFiles.sort().reverse()[0]);
      const content = await readFile(latest, "utf-8");
      totalApprox += content.split("\n").filter(Boolean).length;
    } catch {}
    // 每个日志文件大约 SUMMARY_INTERVAL 
    totalApprox += (logFiles.length - 1) * SUMMARY_INTERVAL;
  }

  const latestSummary = await getLatestSummary();

  return {
    totalDecisionsLogged: totalApprox,
    logFiles: logFiles.length,
    summaryFiles: summaryFiles.length,
    decisionsDir: DECISIONS_DIR,
    latestSummary,
    threeEvidences: {
      "本": "历史经验 - 工具调用频率/成功率/平均耗时",
      "原": "实时状态 - Worker负载/队列深度/内存水位",
      "用": "实践反馈 - 执行结果/耗时/优化建议",
    },
  };
}

// ====== 初始化 ======

/**
 * 初始化决策目录并清理过期数据
 */
export async function initRouteEvidence() {
  await ensureDecisionsDir();

  // 启动时清理超 24 小时的汇总文件（保留最新2份）
  try {
    const files = await readdir(DECISIONS_DIR);
    const summaryFiles = files
      .filter(f => f.startsWith("route-summary-") && f.endsWith(".json"))
      .sort()
      .reverse();

    if (summaryFiles.length > 2) {
      const toDelete = summaryFiles.slice(2);
      for (const f of toDelete) {
        try { await unlink(join(DECISIONS_DIR, f)); } catch {}
      }
    }
  } catch {}

  // TODO: 移除调试日志 console.log(`[route-evidence] 🏛️ triple-evidence ready → ${DECISIONS_DIR}`);
  return true;
}

export default {
  recordRouteDecision,
  update用Evidence,
  queryRouteDecisions,
  getLatestSummary,
  getRouteStats,
  generateSummary,
  initRouteEvidence,
};