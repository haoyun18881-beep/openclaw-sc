/**
 * 🦞 sc v5.38.0 — 纯MCP架构，统一配置化
 * Worker池 + GPU加速 + MCP工具集，权限由 tools/mcp-tools.config.json 管控
 * 版本历史详见 CHANGELOG.md
 */

import { Worker } from "worker_threads";
import { spawn } from "child_process"; // 仅异步spawn
import { freemem, homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { readFile, writeFile, mkdir, readdir, unlink, stat } from "fs/promises";
import { statSync, existsSync, readdirSync } from "fs";
import { validatePath } from "./security.js";
import {
  PHYSICAL_CORES,
  CORE_RESERVED_IDLE,
  CORE_RESERVED_MIN,
  MIN_WORKERS,
  MAX_WORKERS,
  SCALE_UP_THRESHOLD,
  HEARTBEAT_MS,
  TASK_TIMEOUT_MS,
  IDLE_TERMINATE_MS,
  STATS_CACHE_TTL,
  MEM_CACHE_TTL,
  FILE_EDIT_LOCK_TIMEOUT,
  RECOVERY_COOLDOWN_MS,
  EMERGENCY_MODE_SUPPRESSION_MS,
  RATE_LIMIT_PER_SEC,
  RATE_BLOCK_DURATION_MS,
  MAX_ACTIVE_SPAWNS,
  SPAWN_HISTORY_WINDOW_MS,
  MAX_SPAWN_PER_WINDOW,
  ROUTE_GUARD_VIOLATION_DECAY_MS,
  CACHE_DISABLED,
  TASK_TIMEOUT_MAP,
  GRACE_PER_EXTRA_60S,
  MAX_GRACE_MULTIPLIER,
  SESSION_KEEP_RECENT,
  SESSION_DIR,
  SHARED_DIR,
  WARMED_MODELS_MAX,
  RESTRICTED_TOOLS,
  TOOL_ROUTE_MAP,
  CORE_TOOLS,
  ROUTE_CACHE_TTL_MS,
  ROUTE_CACHE_MAX,
  MAX_WORKER_AGE,
  MAX_WORKER_TASKS,
  ROLLING_RESTART_BATCH_RATIO,
  ROLLING_RESTART_CHECK_INTERVAL_MS,
  WORKER_REPLACEMENT_LOG,
  TASK_CATEGORY,
  TASK_CATEGORY_MAP,
  EXPLORATORY_CHECKPOINT_INTERVAL_MS,
  ROLE_CONFIG,
  TASK_TYPE_ROLE_MAP,
  getInitialRoleDistribution,
  getAdaptiveRoleDistribution,
  PREEMPT_QUEUE_THRESHOLD,
  PREEMPT_CHECK_INTERVAL_MS,
  TRAFFIC_PATTERNS_DIR,
  TRAFFIC_WINDOW_MIN,
  METABOLIC_WEIGHTS,
  METABOLIC_SMOOTH_POINTS,
  METABOLIC_RATE_MIN,
  METABOLIC_RATE_MAX,
  METABOLIC_RATE_ADJUST_STEP,
  METABOLIC_RATE_DEFAULT,
  USER_ACTIVE_TIMEOUT_MS,
  DIALOG_DIR,
  MCP_PORT,
} from './lib/constants.js';

// traffic-predictor.js (Cerebellum/小脑) — 被动扩缩容已够用，不需要预测，已移除
import {
  ensureSharedDir,
  sanitizeTaskName,
  writeSharedResult,
  readSharedResult,
  cleanupSharedDir,
  cleanupOldSessions,
  cleanupTaskStates,
  ensurePreemptDir,
  writePreemptState,
  readPreemptState,
  clearPreemptState,
} from './lib/shared-fs.js';
import {
  handleCoreStats,
  handleCoreImageBatch,
} from './lib/tool-handlers.js';
// dialog-recall.js — 仅 bridge.js 使用，index.js 不需要
// decomposer.js — 仅 bridge.js / worker.js 使用，index.js 不需要
// pipeline-engine.js — 仅 bridge.js 使用，index.js 不需要
import { register as registerToolDiscover } from './lib/tool-auto-discover.js';
// system-tools.js — 仅 bridge.js 使用，index.js 不需要
// dashboard已删除（管理员2026-05-31要求移除）
import {
  recordRouteDecision,
  update用Evidence,
  queryRouteDecisions,
  getRouteStats as getRouteEvidenceStats,
  initRouteEvidence,
} from './lib/route-evidence.js';
// config.js getDefaultChatModel — 仅 bridge.js 使用，index.js 不需要
// code-review-shared.js — 仅 bridge.js 使用，index.js 不需要
import {
  detectChain,
  getChainRoute,
  enrichRouteWithChain,
  executeDetectedChain,
  readChain,
  cleanupChainLogs,
  listChains,
} from './lib/task-chain.js';
import { evaluatePreemption, savePreemptState } from './lib/preemption.js';
import { tcell } from './lib/tcell.js';
// task-profiles.js core_pickSubagentModel — 仅 bridge.js 使用，index.js 不需要
import {
  initLogger,
  logWorker,
  logError,
  logAccess,
  logWorkerEvent,
  stopHippocampusFlush,
  getLogger,
} from './lib/log-manager.js';
// ⛔ route-audit 已物理删除 (2026-06-13)
// import { startGoedelMetaWorker, stopGoedelMetaWorker, loadKeywordWeights } from './lib/route-audit.js';
// import { auditRecentRoutes, startRouteAuditor, stopRouteAuditor } from './lib/route-auditor.js';
import {
  StewardGuard,
  TOOL_TIERS as STEWARD_TOOL_TIERS,
  sanitizeToolParams,
  buildAutoRedirectTask,
  isAutoRedirectEnabled,
} from './lib/steward-rules.js';
import {
  core_createTask,
  core_reportResult,
  core_collectResults,
  saveCheckpoint,
  readCheckpoint,
  cleanupCheckpoints,
} from './lib/task-center.js';
import { register as registerEnrichSubagent } from './lib/tool-enrich-subagent.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ====== Checkpoint 目录（由 task-center.js 管理）======

async function safeReadJson(filePath) {
  try { return JSON.parse(await readFile(filePath, "utf-8")); } catch { return null; }
}

// dynamic cores分配:资源调度强度精细平滑控制，取代离散4档模式
// 资源调度强度高→更多Worker，资源调度强度低→更少Worker（让出CPU给主线程/聊天）
function getDynamicMaxWorkers() {
  try {
    const meta = getMetabolicRateConfig();
    const stats = pool?.getStats?.();
    if (!stats) return PHYSICAL_CORES - CORE_RESERVED_MIN;
    const queueDepth = stats.queueDepth || 0;

    // 从资源调度强度平滑插值得到当前Worker上限
    // 资源调度强度0.2→maxWorkers=4, 0.5→8, 0.8→14, 1.0→20
    let maxW = meta.maxWorkers;

    // 队列深度额外加成：队列深→增加Worker（在资源调度强度基础上临时补强）
    if (queueDepth >= 20) {
      // 深度排队：最多加6个
      maxW = Math.min(PHYSICAL_CORES, maxW + 6);
    } else if (queueDepth >= 10) {
      // 排队：最多加3个
      maxW = Math.min(PHYSICAL_CORES, maxW + 3);
    }

    // 上限不超过物理核心数
    return Math.min(maxW, PHYSICAL_CORES);
  } catch {
    return PHYSICAL_CORES - CORE_RESERVED_MIN;
  }
}

// 根据内存水位 + 资源调度强度平滑插值 + Worker队列深度动态调整缓存TTL
// ⚠️ 注意:只能调 getMemoryLevel()(直接)和 pool.getStats()(直接),不能调 getCachedMemoryLevel()/getCachedStats()(有缓存会循环依赖)
function getDynamicCacheTTL() {
  const meta = getMetabolicRateConfig();

  // 近战斗模式(≥0.9)：缓存禁用
  if (meta.cacheDisabled) {
    return { stats: CACHE_DISABLED, mem: CACHE_DISABLED };
  }

  const mem = getMemoryLevel();
  const level = mem.level;

  // 熔断:不缓存
  if (level === 'meltdown') return { stats: CACHE_DISABLED, mem: CACHE_DISABLED };

  // 根据内存水位得到基础TTL
  let base;
  switch(level) {
    case 'green':  base = { stats: 30000, mem: 15000 }; break;
    case 'yellow': base = { stats: 10000, mem:  5000 }; break;
    case 'red':    base = { stats:  3000, mem:  2000 }; break;
    default:       base = { stats: 10000, mem:  5000 };
  }

  // 资源调度强度连续插值调整：cacheMult 在锚点间平滑变化
  // rest(0.2)→×3.0, balanced(0.5)→×1.0, focus(0.8)→×0.5, battle(1.0)→×0(禁用)
  const cacheMult = meta.cacheMult;
  if (cacheMult !== 1) {
    base = {
      stats: Math.max(1000, Math.round(base.stats * cacheMult)),
      mem:   Math.max(500,  Math.round(base.mem * cacheMult)),
    };
  }

  // 根据队列深度调整:空闲涨、繁忙降
  // 用 pool.getStats() 直接拿队列深度(跳过缓存绕开循环依赖)
  try {
    const stats = pool?.getStats?.();
    if (stats) {
      const queueDepth = stats.queueDepth || 0;

      if (queueDepth === 0 && level === 'green') {
        // 空闲:队列空 + 内存充足 → 缓存再加倍
        return { stats: base.stats * 2, mem: base.mem * 2 };
      }

      if (queueDepth > 3 && (level === 'yellow' || level === 'red')) {
        // 繁忙:队列深 + 内存紧张 → 缓存减半(不低于最小值)
        return {
          stats: Math.max(2000, Math.floor(base.stats / 2)),
          mem:   Math.max(1000, Math.floor(base.mem / 2)),
        };
      }
    }
  } catch {
    // 出错时走基础TTL,不中断
  }

  return base;
}

let cachedStats = null;
let cachedStatsTime = 0;

let cachedMemLevel = null;
let cachedMemTime = 0;

// ====== dual-mode状态 ======



// ====== ⛽ dashboard进程ID（模块级变量，跨activate/shutdown共享） ======
let dashboardPid = null;

// ====== 🧬 资源调度精细调节系统 ======
// 资源调度强度 ∈ [0.2, 1.0] 连续值，控制调度密度/缓存强度/Worker数
// 0.2=休息 0.5=均衡 0.8=专注 1.0=战斗 — 之间线性插值，无离散档位
let _metabolicRate = METABOLIC_RATE_DEFAULT;
let _metabolicTimer = null;
let _nu = 0.5;             // 系统活动度 ν ∈ [0.2, 1.0]（4参数加权归一化）
let _nuBias = 0;           // 中庸校正偏置 [-0.05, 0.05]
let _jointLoss = 0;        // 当前联合损失值

// 用户活跃度缓存
let _lastUserActive = true;
let _lastUserCheckTime = 0;

/**
 * 检测用户是否活跃（近20min有消息）
 * 通过检查对话日记文件最后修改时间判断
 * 缓存1min防I/O抖动
 */
function checkUserActive() {
  const now = Date.now();
  // 缓存1min
  if (now - _lastUserCheckTime < 60000) {
    return _lastUserActive;
  }
  _lastUserCheckTime = now;
  try {
    // 取今天的对话日记
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const dialogPath = join(DIALOG_DIR, `${yyyy}-${mm}-${dd}.md`);
    if (!existsSync(dialogPath)) {
      // 没有今天的日记 → 不活跃
      _lastUserActive = false;
      return false;
    }
    const mtime = statSync(dialogPath).mtimeMs;
    const elapsed = now - mtime;
    _lastUserActive = elapsed < USER_ACTIVE_TIMEOUT_MS;
    return _lastUserActive;
  } catch {
    // 无法读取时保守返回true（不降低资源调度强度）
    return true;
  }
}

function getMetabolicRate() {
  return _metabolicRate;
}

function setMetabolicRate(val) {
  const clamped = Math.max(METABOLIC_RATE_MIN, Math.min(METABOLIC_RATE_MAX, parseFloat(val) || METABOLIC_RATE_DEFAULT));
  const rounded = Math.round(clamped * 100) / 100;
  const prev = _metabolicRate;
  _metabolicRate = rounded;
  // TODO: 移除调试日志 console.log(`[sc] 🧬 metabolic rate: ${prev.toFixed(2)} → ${rounded.toFixed(2)}`);
  return { rate: rounded, prev };
}

/**
 * 线性插值：在 METABOLIC_SMOOTH_POINTS 中找到相邻两点，按比例插值
 * edges界外取端点值
 */
function interpolateMetabolicValue(rate, key) {
  const points = METABOLIC_SMOOTH_POINTS;
  if (!points || points.length === 0) return null;
  const sorted = [...points].sort((a, b) => a.rate - b.rate);

  // 低于下界取第一个点
  if (rate <= sorted[0].rate) return sorted[0][key];
  // 高于上界取最后一个点
  if (rate >= sorted[sorted.length - 1].rate) return sorted[sorted.length - 1][key];

  // 找到相邻区间
  for (let i = 0; i < sorted.length - 1; i++) {
    if (rate >= sorted[i].rate && rate <= sorted[i + 1].rate) {
      const lo = sorted[i];
      const hi = sorted[i + 1];
      const t = (rate - lo.rate) / (hi.rate - lo.rate); // [0, 1]

      // cacheDisabled 是布尔值，用阈值判定
      if (key === 'cacheDisabled') {
        // rate ≥ 0.9 才完全禁用缓存（接近战斗模式）
        return rate >= 0.9;
      }

      const loVal = lo[key];
      const hiVal = hi[key];

      // 数值插值
      if (typeof loVal === 'number' && typeof hiVal === 'number') {
        const val = loVal + (hiVal - loVal) * t;
        // 整数取整，小数保留两位
        if (Number.isInteger(loVal) && Number.isInteger(hiVal)) {
          return Math.round(val);
        }
        return Math.round(val * 100) / 100;
      }

      // 其他类型取最近
      return t < 0.5 ? loVal : hiVal;
    }
  }

  return sorted[sorted.length - 1][key];
}

/**
 * 根据当前资源调度强度返回连续插值配置
 * 取代旧的离散4档模式，任意资源调度强度值在锚点间线性插值
 */
function getMetabolicRateConfig() {
  const rate = _metabolicRate;
  const nu = _nu ?? 0.5;

  return {
    rate,
    nu,
    jointLoss: _jointLoss ?? 0,          // 🆕 联合损失值
    label: `smooth:${rate.toFixed(2)}`,
    minWorkers: interpolateMetabolicValue(rate, 'minWorkers'),
    maxWorkers: interpolateMetabolicValue(rate, 'maxWorkers'),
    cacheMult: interpolateMetabolicValue(rate, 'cacheMult'),
    cacheDisabled: interpolateMetabolicValue(rate, 'cacheDisabled'),
    rateMult: interpolateMetabolicValue(rate, 'rateMult'),
    autoWarmup: rate < 0.35, // 低资源调度强度时开启自动warmup
  };
}

/**
 * 根据工具名和任务级别计算最终超时（毫s）
 * 整合 ν 轴缩放 × 任务复杂度因子
 * ν=0 → ×2（最宽松休息模式），ν=0.5 → ×1.5（均衡），ν=1.0 → ×1.0（最紧缩战斗模式）
 *
 * @param {string} toolName - 工具名（从 TASK_TIMEOUT_MAP 取 kill 基准值）
 * @param {string} [level='L3'] - 任务 L 级别 (L0-L7)
 * @returns {number} 超时毫s数
 */
function calcTimeout(toolName, level = 'L3') {
  // 1. 基准超时（s）
  const baseEntry = TASK_TIMEOUT_MAP[toolName] || TASK_TIMEOUT_MAP.default;
  const baseSeconds = baseEntry.kill;

  // 2. ν 缩放因子：ν=0→×2(最宽松), ν=0.5→×1.5(均衡), ν=1.0→×1.0(最紧缩)
  const meta = getMetabolicRateConfig();
  const nuScale = 2 - meta.nu;

  // 3. 级别复杂度因子
  const levelNum = parseInt((level || 'L3').replace('L', ''), 10);
  const complexityMult = levelNum <= 1 ? 0.8
                       : levelNum <= 3 ? 1.0
                       : levelNum <= 5 ? 1.5
                       : 2.0;

  // 4. 计算并兜底
  const timeoutMs = Math.round(baseSeconds * 1000 * nuScale * complexityMult);
  if (!timeoutMs || timeoutMs <= 0 || !Number.isFinite(timeoutMs)) {
    return TASK_TIMEOUT_MAP.default.kill * 1000;
  }
  return timeoutMs;
}

// ====== 中庸联合损失配置 ======
const JOINT_LOSS_CONFIG = {
  alpha: 0.4,        // metabolic rate偏离"中"的惩罚权重
  beta: 0.3,         // 超时偏离平均值的惩罚权重
  gamma: 0.3,        // 耦合违反惩罚权重
  threshold: 0.15,   // 触发 ν_bias 注入的损失阈值
  biasStep: 0.02,    // 每次调节的 ν_bias 微调步长
  biasClamp: 0.05,   // ν_bias 限幅范围 [-0.05, 0.05]
};

/**
 * 计算中庸联合损失 L(η, τ)
 *
 * Loss = α(η-0.5)² + β(τ-τ_avg)² + γ×couplingTerm
 *
 * 三个约束项：
 *   1. η 偏离 0.5 的惩罚 —— 不让metabolic rate偏极端
 *   2. τ 偏离 avgTimeout 的惩罚 —— 不让超时偏极端
 *   3. 耦合项 = |Δη|×|Δτ| —— 两者同时大幅变化则惩罚
 *
 * @param {number} nu - 当前 ν 值
 * @param {number} rate - 当前metabolic rate η
 * @returns {number} 联合损失值 [0, ~1]
 */
function calcJointLoss(nu, rate) {
  const cfg = JOINT_LOSS_CONFIG;

  // 项 1: metabolic rate偏离"中"（0.5）的程度
  const etaDev = (rate - 0.5) ** 2;

  // 项 2: 超时偏离系统平均超时的程度
  // 从最近60s超时记录估算平均超时偏离
  const recentTimeouts = failContextBuffer.getRecent(60000)
    .filter(e => e.errorCode === 'TIMEOUT');
  const avgTimeoutDev = recentTimeouts.length > 0
    ? Math.min(1, recentTimeouts.length / 10)
    : 0;

  // 项 3: 耦合违反程度 — η↑时τ是否真的↓？
  // 期望超时基数 = (2 - nu)，实际超时率若偏高但 ν 偏低，说明耦合失效
  const tauBase = 2 - nu;
  const tauActual = recentTimeouts.length > 0
    ? Math.max(0.5, 1 - recentTimeouts.length / 20)
    : tauBase;
  const couplingTerm = (tauBase - tauActual) ** 2;

  // 综合损失
  const loss = cfg.alpha * etaDev + cfg.beta * avgTimeoutDev + cfg.gamma * couplingTerm;
  return Math.min(1, loss);
}

/**
 * 计算各任务类型超时stats（供 core_stats 展示）
 * 从 failContextBuffer 中取最近5min超时记录，按 tool 分组stats
 *
 * @returns {object} 按工具名分组的超时stats { toolName: { count, avgTimeoutMs, timeoutRate }, total: { count, tools } }
 */
// 🔧 BUGFIX: _lastMetabolicStep 前置声明
let _lastMetabolicStep = 0;

function computeTimeoutStats() {
  const recent5m = failContextBuffer.getRecent(300000)
    .filter(e => e.errorCode === 'TIMEOUT');

  // 按工具分组
  const byTool = {};
  for (const entry of recent5m) {
    if (!byTool[entry.tool]) {
      byTool[entry.tool] = { count: 0, tool: entry.tool };
    }
    byTool[entry.tool].count++;
  }

  // 计算总超时数
  const totalTimeouts = recent5m.length;

  // 估算总任务数（从 pool stats获取最近5min的任务分发量）
  // 使用池缓存stats中的 tasksProcessed 差值
  const now = Date.now();
  // 从 failContextBuffer 的 TIMEOUT 以外的记录估算总任务量
  const allRecent = failContextBuffer.getRecent(300000);
  const totalAbnormalEvents = allRecent.length; // ⚠️ 仅失败/异常事件，非总任务数
  const timeoutRate = totalAbnormalEvents > 0 ? +(totalTimeouts / totalAbnormalEvents).toFixed(4) : 0;

  const _totalTasks = totalAbnormalEvents; // 异常事件数作为总任务数的代理
  return {
    perTool: Object.values(byTool).map(t => ({
      tool: t.tool,
      timeoutCount: t.count,
      timeoutRate: _totalTasks > 0 ? +(t.count / _totalTasks).toFixed(4) : 0,
    })),
    total: {
      timeoutCount: totalTimeouts,
      totalTasks: _totalTasks,
      timeoutRate,
    },
  };
}

/**
 * 资源调度强度精细自动调节：基于4个实时负载指标每15s微调±0.05
 * 权重：内存水位(0.40) + 队列深度趋势(0.28) + 心跳失败率(0.17) + 用户活跃(0.15)
 * ν = 4参数加权评分归一化到 [0.2, 1.0]
 */
function autoRegulateMetabolicRate() {
  try {
    const mem = getCachedMemoryLevel();
    const stats = getCachedStats();

    // 1. 内存水位评分 [0,1]：freeGB越高越接近0（降资源调度强度）,越低越接近1（升资源调度强度）
    const freeGB = mem.freeGB || 8;
    const memScore = Math.max(0, Math.min(1, 1 - freeGB / 16));

    // 2. 队列深度趋势 [0,1]：队列深→高资源调度强度
    const qDepth = stats.queueDepth || 0;
    const qScore = Math.max(0, Math.min(1, qDepth / 30));

    // 3. 心跳失败率 [0,1]：从failContextBuffer中取最近30s的心跳失败
    const recent30s = failContextBuffer.getRecent(60000);
    const hbFails = recent30s.filter(e => e.tool === 'ping' || e.errorCode === 'HEARTBEAT_FAIL').length;
    const hbScore = Math.max(0, Math.min(1, hbFails / 5));

    // 4. 用户活跃评分 [0,1]
    // 用户在聊天 → userScore低(0) → 降资源调度强度（让出CPU给聊天体验）
    // 用户不在 → userScore高(1) → 升资源调度强度（更激进后台处理）
    const userActive = checkUserActive();
    const userScore = userActive ? 0 : 1;

    // 加权综合评分 ν [0,1]（4参数，总和=1.0，已移除timeout权重）
    const w = METABOLIC_WEIGHTS;
    const weightedScore = memScore * w.memory + qScore * w.queue + hbScore * w.heartbeat + userScore * w.userActive;

    // ν = 加权评分归一化到 [0.2, 1.0] + 中庸偏置
    const rawNu = METABOLIC_RATE_MIN + weightedScore * (METABOLIC_RATE_MAX - METABOLIC_RATE_MIN);
    _nu = Math.round(Math.max(0, Math.min(1, rawNu + _nuBias)) * 100) / 100;

    // 目标资源调度强度 = ν（4参数 ν 直接驱动资源调度强度）
    const targetRate = _nu;

    // 当前与目标的差值，步长不超过±0.05
    const diff = targetRate - _metabolicRate;
    const step = Math.max(-METABOLIC_RATE_ADJUST_STEP, Math.min(METABOLIC_RATE_ADJUST_STEP, diff));

    if (Math.abs(step) >= 0.01 || step !== _lastMetabolicStep) {
      const newRate = Math.round((_metabolicRate + step) * 100) / 100;
      if (newRate !== _metabolicRate) {
        setMetabolicRate(newRate);
      }
    }
    _lastMetabolicStep = step;

    // 7. 计算联合损失，注入 ν_bias（中庸校正）
    _jointLoss = calcJointLoss(_nu, _metabolicRate);
    if (_jointLoss > JOINT_LOSS_CONFIG.threshold) {
      // 当metabolic rate偏高(>0.7)且ν偏高(>0.6) → 往低拉；
      // 当metabolic rate偏低(<0.3)且ν偏低(<0.4) → 往高拉
      const correction = (_metabolicRate > 0.7 && _nu > 0.6) ? -1
                       : (_metabolicRate < 0.3 && _nu < 0.4) ? 1
                       : 0;
      _nuBias += correction * JOINT_LOSS_CONFIG.biasStep;
      _nuBias = Math.max(-JOINT_LOSS_CONFIG.biasClamp, Math.min(JOINT_LOSS_CONFIG.biasClamp, _nuBias));
    }
  } catch (err) {
    console.warn(`[sc] ⚠️ metabolic rate自动调节异常: ${err.message}`);
  }
}

/**
 * 启动资源调度自动调节定时器 (每15s)
 */
function startMetabolicAutoRegulation() {
  if (_metabolicTimer) clearInterval(_metabolicTimer);
  _metabolicTimer = setInterval(() => autoRegulateMetabolicRate(), 15000);
  // TODO: 移除调试日志 console.log('[sc] 🧬 metabolic rate自动调节started (每15s)');
}

/**
 * 停止资源调度自动调节定时器
 */
function stopMetabolicAutoRegulation() {
  if (_metabolicTimer) {
    clearInterval(_metabolicTimer);
    _metabolicTimer = null;
  }
}

// ====== 双通道痛觉（A-delta 快通道 + C纤维 慢通道）======

/**
 * 环形缓冲区:记录失败上下文 {tool, errorCode, paramHash?, timestamp}
 * 容量200,满则覆盖最旧记录
 */
class RingBuffer {
  constructor(capacity) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
    this.cursor = 0;
    this.filled = false;
  }
  push(item) {
    this.buffer[this.cursor] = { ...item, timestamp: item.timestamp || Date.now() };
    this.cursor = (this.cursor + 1) % this.capacity;
    if (!this.filled && this.cursor === 0) this.filled = true;
  }
  /** 返回按时间降序排列的所有记录 */
  getAll() {
    const items = this.filled
      ? [...this.buffer.slice(this.cursor), ...this.buffer.slice(0, this.cursor)]
      : this.buffer.slice(0, this.cursor);
    return items.filter(Boolean).sort((a, b) => b.timestamp - a.timestamp);
  }
  /** 返回指定毫s窗口内的记录 */
  getRecent(ms) {
    const cutoff = Date.now() - ms;
    return this.getAll().filter(item => item.timestamp >= cutoff);
  }
  /** 清空 */
  clear() { this.buffer.fill(null); this.cursor = 0; this.filled = false; }
}

// 失败上下文环形缓冲（容量200）
const failContextBuffer = new RingBuffer(200);

// 快速通道（A-delta）诊断缓存
const fastChannelDiag = {
  pending: [],      // {tool, paramHash, firstSeen, lastSeen, count, diagnostic}
};

// 慢速通道（C纤维）状态
const slowChannelState = {
  lastAggregation: Date.now(),
  timer: null,
  status: 'normal',   // 'normal' | 'watch' | 'escalating' | 'critical'
  report: { trend: 'stable', hotTools: [], failureRate: 0 },
};

// 计算参数指纹（工具名+关键参数摘要 -> 定位同一个操作模式）
function computeParamHash(params) {
  if (!params) return '';
  try {
    const keys = Object.keys(params).sort();
    const parts = keys.map(k => {
      const v = params[k];
      if (typeof v === 'string') return `${k}:${v.slice(0, 20)}`;
      if (Array.isArray(v)) return `${k}:arr(${v.length})`;
      return `${k}:${String(v).slice(0, 20)}`;
    });
    return parts.join('|');
  } catch { return ''; }
}

/**
 * 推送失败上下文到环形缓冲区 + 快速通道诊断
 * @param {string} tool - 工具名
 * @param {string} errorCode - 错误码
 * @param {object} [params] - 调用参数（用于计算 paramHash）
 * @returns {{diagnostic: string|null, channel: string}} - 诊断信息, 'fast' | 'none'
 */
function pushFailContext(tool, errorCode, params) {
  const paramHash = computeParamHash(params);
  const entry = { tool, errorCode, paramHash, timestamp: Date.now() };
  failContextBuffer.push(entry);

  // 快速通道检查:同 tool + 同 errorCode + 同 paramHash 在30s内≥2次 → 输出诊断
  const recent30s = failContextBuffer.getRecent(60000);
  const samePattern = recent30s.filter(
    e => e.tool === tool && e.errorCode === errorCode && e.paramHash === paramHash
  );

  if (samePattern.length >= 2) {
    const diagnostic = `[sc] ⚡ A-delta快通道诊断: 工具 "${tool}" (${errorCode}) 在60s内连续失败${samePattern.length}次,参数模式="${paramHash.slice(0, 40)}"。建议: 检查该工具参数是否正确,或考虑调整调用方式。`;
    fastChannelDiag.pending.push({
      tool, paramHash, firstSeen: samePattern[samePattern.length - 1].timestamp,
      lastSeen: Date.now(), count: samePattern.length, diagnostic,
    });
    // 快速通道只保留最近10诊断
    if (fastChannelDiag.pending.length > 10) fastChannelDiag.pending.shift();
    console.warn(diagnostic);
    return { diagnostic, channel: 'fast' };
  }

  return { diagnostic: null, channel: 'none' };
}

/**
 * 慢速通道(C纤维)聚合分析:检测失败率趋势
 * @param {number} [windowMs] - 分析窗口(默认5min)
 * @returns {{shouldDegrade: boolean, report: object}}
 */
function slowChannelAggregate(windowMs) {
  windowMs = windowMs || 5 * 60 * 1000;
  const recent = failContextBuffer.getRecent(windowMs);

  if (recent.length === 0) {
    slowChannelState.status = 'normal';
    slowChannelState.report = { trend: 'stable', hotTools: [], failureRate: 0, totalFails: 0, windowSec: windowMs / 1000 };
    return { shouldDegrade: false, report: slowChannelState.report };
  }

  // 按工具分组计数
  const toolCounts = {};
  for (const e of recent) {
    toolCounts[e.tool] = (toolCounts[e.tool] || 0) + 1;
  }

  // 按错误码分组
  const errorCounts = {};
  for (const e of recent) {
    const key = `${e.tool}:${e.errorCode}`;
    errorCounts[key] = (errorCounts[key] || 0) + 1;
  }

  const totalFails = recent.length;
  const hotTools = Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tool, count]) => ({ tool, count, share: (count / totalFails * 100).toFixed(1) + '%' }));

  const failureRate = totalFails / (windowMs / 1000); // 次/s

  // 判断趋势等级
  let status = 'normal';
  let shouldDegrade = false;

  if (failureRate > 0.3 || totalFails >= 15) {
    // 失败率>0.3次/s 或 5min内>=15次失败 → 紧急
    status = 'critical';
    shouldDegrade = true;
  } else if (failureRate > 0.15 || totalFails >= 8) {
    // 失败率>0.15次/s 或 >=8次 → 升级中
    status = 'escalating';
  } else if (failureRate > 0.05 || totalFails >= 3) {
    // 低水平但持续失败 → 观察
    status = 'watch';
  }

  slowChannelState.status = status;
  slowChannelState.report = {
    trend: status,
    hotTools,
    failureRate: parseFloat(failureRate.toFixed(4)),
    totalFails,
    windowSec: windowMs / 1000,
    errorBreakdown: errorCounts,
  };

  if (status !== 'normal') {
    const msg = `[sc] 🔬 慢通道聚合: ${totalFails}次失败/${(windowMs/1000).toFixed(0)}s,率=${failureRate.toFixed(4)}次/s,状态=${status}` +
      `,热点工具: ${hotTools.map(t => `${t.tool}(${t.count}次)`).join(', ')}`;
    if (shouldDegrade) {
      console.warn(`[sc] 🚨 慢通道判定: 失败率飙升,建议降级 - ${msg}`);
    } else {
      console.warn(`[sc] ⚠️ 慢通道告警: ${msg}`);
    }
  }

  return { shouldDegrade, report: slowChannelState.report };
}

/**
 * 获取双通道状态摘要（供 core_stats 等工具展示）
 */
function getDualChannelStatus() {
  const bufferStatus = failContextBuffer.getAll().slice(0, 5).map(e => ({
    tool: e.tool,
    errorCode: e.errorCode,
    ago: ((Date.now() - e.timestamp) / 1000).toFixed(0) + 's',
  }));
  return {
    fastChannel: {
      activeDiagnostics: fastChannelDiag.pending.length,
      recent: fastChannelDiag.pending.slice(-3).map(d => ({
        tool: d.tool, count: d.count, paramHash: d.paramHash.slice(0, 30),
        ago: ((Date.now() - d.lastSeen) / 1000).toFixed(0) + 's',
      })),
    },
    slowChannel: {
      status: slowChannelState.status,
      trend: slowChannelState.report.trend,
      failureRate: slowChannelState.report.failureRate,
      totalFails: slowChannelState.report.totalFails,
      hotTools: slowChannelState.report.hotTools,
    },
    bufferRecent: bufferStatus,
  };
}





// ====== 内存水位 ======
function getMemoryLevel() {
  const freeGB = freemem() / 1024 / 1024 / 1024;
  const heapUsedMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  if (freeGB > 8) return { level: 'green', freeGB, heapUsedMB, action: 'normal' };
  if (freeGB >= 4) return { level: 'yellow', freeGB, heapUsedMB, action: 'reduce' };
  if (freeGB >= 2) return { level: 'red', freeGB, heapUsedMB, action: 'block_subagent' };
  return { level: 'meltdown', freeGB, heapUsedMB, action: 'block_all' };
}

// ====== 双树路由最后结果(供 before_tool_call 矛盾检测)======
const lastRouteTask = { recommendedTool: null, confidence: 0, bigTreeResult: null, timestamp: 0 };
// ====== enrichment layer：给任务描述加工具推荐说明 ======
/**
 * 我（主agent）调 core_routeTask 后复制 enrichedTask 到 sessions_spawn 的 task 参数
 * 这样子agent拿到的prompt自带工具推荐，不用自己瞎猜
 *
 * 注：tool-enrich-subagent.js 里也有一个同名的 buildEnrichedTask，
 * 那个版本更完整支持结构化推荐列表和话术enrichment layer格式。本函数是精简版，
 * 只接收单个 decision 字符串。两个互不冲突，各有各的调用链。
 */
function buildEnrichedTask(taskDesc, decision, confidence, toolNote) {
  if (!taskDesc || !decision) return taskDesc;
  const confidencePct = (confidence * 100).toFixed(0);
  const noteClean = toolNote ? toolNote.replace(/[🔴🟢🟡🛡️⚡🧠🌊📌✅❌🔥💡🫡🤡💚🦞🏛️🧬💾🔐🧠🖼️🔧🩺⚙️🌡️🚨ℹ️⚠️☀️]/g, '').trim().substring(0, 60) : '';
  const noteSuffix = noteClean ? `（${noteClean}）` : '';
  return `${taskDesc}\n\n📌 推荐工具：${decision}（置信度${confidencePct}%）${noteSuffix}`;
}

// ====== 工具调用计数器 ======
let toolCallCounter = 0;
const TOOL_HISTORY_MAX = 15;

// ====== 工具速率限制(BUG-9) ======
const toolCallRate = {};
const rateBlockedUntil = {};

// ====== 工具速率限制检查函数(BUG-9) ======
/**
 * 检查指定工具是否超过速率限制(>RATE_LIMIT_PER_SEC次/s)
 * 超过则熔断RATE_BLOCK_DURATION_MS毫s
 * @param {string} toolName - 工具名
 * @param {boolean} [skip=false] - 为true时跳过限流检查
 * @throws {Error} 如果被限流
 */
function checkRateLimit(toolName) {
  const now = Date.now();

  // 检查是否正处于熔断期
  const blockedUntil = rateBlockedUntil[toolName];
  if (blockedUntil && now < blockedUntil) {
    const remainingSec = Math.ceil((blockedUntil - now) / 1000);
    throw new Error(`[ratelimit] 工具 ${toolName} 被限流中(还差 ${remainingSec} s自动恢复)，请稍后retry`);
  }

  // 熔断期已过，清理状态
  if (blockedUntil && now >= blockedUntil) {
    delete rateBlockedUntil[toolName];
    delete toolCallRate[toolName];
  }

  // 初始化调用记录
  if (!toolCallRate[toolName]) {
    toolCallRate[toolName] = [];
  }

  // 清理1s窗口外的记录
  const windowStart = now - 1000;
  toolCallRate[toolName] = toolCallRate[toolName].filter(t => t > windowStart);

  // 资源调度强度精细平滑集成：rateMult在锚点间线性插值
  // rest(0.2)→×0.5, balanced(0.5)→×1.0, focus(0.8)→×1.5, battle(1.0)→×2.0
  const meta = getMetabolicRateConfig();
  const effectiveRateLimit = Math.max(1, Math.round(RATE_LIMIT_PER_SEC * meta.rateMult));

  // 超限 → 熔断（熔断时间随资源调度强度平滑变化）
  // 资源调度强度越高→熔断时间越短（对高负载容忍更高）
  if (toolCallRate[toolName].length >= effectiveRateLimit) {
    // 基于资源调度强度的平滑熔断时间系数：资源调度强度0.2→×2.0, 0.5→×1.0, 0.8→×0.67, 1.0→×0.5
    const blockMult = Math.max(0.5, Math.min(2.0, 2.0 - meta.rate * 1.5));
    const blockDuration = Math.max(5000, Math.round(RATE_BLOCK_DURATION_MS * blockMult));
    rateBlockedUntil[toolName] = now + blockDuration;
    throw new Error(`[ratelimit] 工具 ${toolName} 调用过频(>${effectiveRateLimit}次/s)，已熔断 ${blockDuration/1000} s`);
  }

  // 记录本次调用
  toolCallRate[toolName].push(now);
}

// ====== 子agent spawn 计数(BUG-8) ======
const activeSpawns = new Map(); // toolCallTime → toolName 记录
let activeSpawnCount = 0;

// ====== 基于sessions.json的活跃子agent计数（带缓存）======
let cachedActiveSubagentCount = -1;
let cachedActiveSubagentTime = 0;
const ACTIVE_SUBAGENT_CACHE_TTL_MS = 2000; // 2s缓存

/**
 * 从 sessions.json 读取真实活跃子agent数
 * @returns {Promise<number>} 活跃子agent数, -1表示无法读取
 */
async function countActiveSubagentsFromFile() {
  const now = Date.now();
  if (cachedActiveSubagentCount >= 0 && (now - cachedActiveSubagentTime) < ACTIVE_SUBAGENT_CACHE_TTL_MS) {
    return cachedActiveSubagentCount;
  }
  try {
    const { readFile } = await import('fs/promises');
    // 先尝试新版 sessions/ 目录下的 sessions.json，再回退旧版 sessions.json
    // 设计原因：OpenClaw 新版将 session 数据从根目录 sessions.json 移入 sessions/sessions.json
    const SESSION_PATH_NEW = join(SESSION_DIR, 'sessions.json');
    const SESSION_PATH_OLD = SESSION_DIR + '.json';
    const raw = await readFile(existsSync(SESSION_PATH_NEW) ? SESSION_PATH_NEW : SESSION_PATH_OLD, 'utf-8');
    const data = JSON.parse(raw);
    let count = 0;
    for (const key of Object.keys(data)) {
      if (key.includes(':subagent:')) count++;
    }
    cachedActiveSubagentCount = count;
    cachedActiveSubagentTime = now;
    return count;
  } catch {
    // 文件不存在或解析失败 → 不清洗缓存,降级为无法计数
    cachedActiveSubagentCount = -1;
    return -1;
  }
}

// ====== 工具路由守卫 ======
// 主agent不应直接调用的工具列表(应由子agent执行)
// TOOL_ROUTE_MAP imported from ./lib/constants.js

// 通行证系统已删除（v5.38.0）—— StewardGuard autoRedirect 替代了通行证机制
// routeGuardState 只保留计数器，不需要 passes Map
const routeGuardState = {
  consecutiveViolations: 0,
  lastViolationTool: null,
  violationCount: {},
  totalInterceptions: 0,
  lastViolationTime: 0,
};

// ====== 子agent监控状态 ======
// 🧠 设计决策：子agent监控间隔90s。不小于60s避免每次监控
// 都挤占主线程（读sessions.json是同步IO），不大于120s以免
// 卡死子agent太久才发现。卡死阈值120s给对方留30s缓冲。
// 自己间隔90s意味着卡死30s后就能检测到卡了2min以上。
let monitorState = {
  active: false,
  timer: null,
  intervalSeconds: 90,
  maxStalledSeconds: 120,
  autoKill: false,
  alertOnly: true,
  lastSnapshot: null,
  stalledHistory: new Map(), // sessionId → { firstStalledAt, alertSent }
};

// ====== 监控通知路径（杉哥通知文件）======
// 让主agent在收到子agent完成事件后能读到异步告警
const MONITOR_ALERT_FILE = join(SHARED_DIR, 'monitor-alert.json');
// 🔧 BUGFIX: 从DIALOG_DIR移出防污染
const MONITOR_NOTIFY_LOG = join(SHARED_DIR, 'monitor-notifications.md');
// 已通知过的告警sessionId集合（防跨轮次重复通知）
const notifiedAlertIds = new Set();

function getMonitorState() {
  return {
    active: monitorState.active,
    intervalSeconds: monitorState.intervalSeconds,
    maxStalledSeconds: monitorState.maxStalledSeconds,
    autoKill: monitorState.autoKill,
    alertOnly: monitorState.alertOnly,
    trackedSessions: monitorState.lastSnapshot?.subagents?.length || 0,
  };
}

// ====== 任务类型差异化超时阈值 ======
// TASK_TIMEOUT_MAP imported from ./lib/constants.js

// ====== 阶梯式宽限常量 ======
// GRACE_PER_EXTRA_60S, MAX_GRACE_MULTIPLIER imported from ./lib/constants.js

// ====== 路由缓存自适应加权常量 ======
const SYNAPSE_HALF_LIFE_MS = 3600000;        // 时间衰减半周期1小时
const SYNAPSE_WEIGHT_HOT_THRESHOLD = 50;      // 热点阈值:weight>50得2倍TTL

// ====== 路由热缓存(路由缓存自适应加权版) ======
const routeCache = new Map();
// ROUTE_CACHE_TTL_MS, ROUTE_CACHE_MAX imported from ./lib/constants.js

// ====== 缓存加权权重计算 ======
function calculateSynapticWeight(entry) {
  const elapsed = Date.now() - entry.lastAccess;
  const timeDecay = Math.exp(-elapsed / SYNAPSE_HALF_LIFE_MS * Math.LN2);
  return Math.max(1, Math.round(entry.accessCount * (1 + timeDecay)));
}

function updateEntryWeight(entry) {
  const prevWeight = entry.weight;
  entry.weight = calculateSynapticWeight(entry);
  if (entry.weight > prevWeight && prevWeight >= 1) {
    entry.hot = true;  // 权重持续增长=hot path
  }
}

function evictLowestWeightEntry() {
  let lowestWeight = Infinity;
  let lowestKey = undefined;
  for (const [key, entry] of routeCache) {
    updateEntryWeight(entry);
    if (entry.weight < lowestWeight) {
      lowestWeight = entry.weight;
      lowestKey = key;
    }
  }
  if (lowestKey !== undefined) routeCache.delete(lowestKey);
}

// ====== 路由缓存辅助函数(路由缓存自适应加权版) ======
function routeCacheSet(key, value) {
  const existing = routeCache.get(key);
  if (existing) {
    // 更新已有目:保留访问历史和权重
    existing.result = value.result;
    existing.timestamp = Date.now();
    existing.accessCount++;
    existing.lastAccess = Date.now();
    updateEntryWeight(existing);
  } else {
    // 新目:初始化权重
    const newEntry = {
      result: value.result,
      timestamp: Date.now(),
      accessCount: 1,
      lastAccess: Date.now(),
      weight: 1,
      hot: false
    };
    routeCache.set(key, newEntry);
  }
  // 淘汰:按最低权重驱逐(而非LRU插入顺序)
  if (routeCache.size > ROUTE_CACHE_MAX) {
    evictLowestWeightEntry();
  }
}

// 提取公共函数:创建大树异步校对Promise
function createBigTreePromise(quickResult, taskDesc) {
  lastRouteTask.recommendedTool = quickResult.tool;
  lastRouteTask.confidence = quickResult.confidence;
  lastRouteTask.bigTreeResult = null;
  lastRouteTask.timestamp = Date.now();

  return Promise.all([
    pool.exec({ type: 'route-system', text: taskDesc }, 'low').catch(() => null),
    pool.exec({ type: 'route-intent', text: taskDesc }, 'low').catch(() => null),
    pool.exec({ type: 'route-capability', text: taskDesc }, 'low').catch(() => null),
  ]).then(([system, intent, capability]) => {
    return pool.exec({
      type: 'route-strategy',
      quick: quickResult,
      system: system || { loadLevel: 'green', details: {} },
      intent: intent || { taskType: '查询类', intent: '', scope: 'local', dangerDetected: false, constraints: [] },
      capability: capability || { directTools: [], compoundTools: [], fallback: 'subagent', gaps: [] },
    }, 'low').catch(() => null);
  }).then((result) => {
    lastRouteTask.bigTreeResult = result;
    if (result && result.strategy === 'block') {
      // TODO: 移除调试日志 console.log(`[sc] 大树校对发现冲突,建议拦截: recommended=${quickResult.tool} risk=${result.risk}`);
    }
  }).catch((err) => { console.warn('[sc] 大树异步校对失败:', err?.message); });
}

// SHARED_DIR, SESSION_DIR, SESSION_KEEP_RECENT imported from ./lib/constants.js
// ensureSharedDir, sanitizeTaskName, writeSharedResult, readSharedResult,
// cleanupSharedDir, cleanupOldSessions - all imported from ./lib/shared-fs.js

// ====== 紧急停止 ======
async function cpuAbort() {
  console.warn('[sc] 🚨 紧急停止: 终止所有Worker');

  // 1. 设关闭标志
  isShuttingDown = true;
  // 2. 终止所有Worker线程
  for (const entry of workers) {
    try {
      if (entry.worker && !entry.terminating) {
        entry.terminating = true;
        await entry.worker.terminate();
      }
    } catch {}
  }
  workers.length = 0;
  // 3. 清空队列
  taskQueues.high = [];
  taskQueues.normal = [];
  taskQueues.low = [];
  // 4. 拒绝所有 pendingJobs
  for (const [jobId, job] of pendingJobs) {
    try { job.reject(new Error('[sc] 🚨 被用户手动终止')); } catch {}
  }
  pendingJobs.clear();
  // 5. 关闭心跳和伸缩定时器
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (scaleTimer) clearInterval(scaleTimer);
  // 6. 清理共享文件
  try {
    const { readdir, unlink } = await import('fs/promises');
    const files = await readdir(SHARED_DIR).catch(() => []);
    for (const f of files) {
      await unlink(join(SHARED_DIR, f)).catch((err) => { console.warn('[sc] 异步错误:', err?.message); });
    }
  } catch {}
  // 7. 清理 suppressionTimer

  // 8. 清掉路由缓存,防矛盾检测拿到脏数据
  lastRouteTask.timestamp = 0;
  // 9. 恢复Worker池(杀完再重建,不是永久死亡)
  isShuttingDown = false;
  try {
    pool.restart(MIN_WORKERS);
    readyPromise = Promise.resolve(true);
    warmupDone = false;
    // 异步warmup模型缓存
    pool.warmup().catch(() => {});
    // TODO: 移除调试日志 console.log(`[sc] ✅ cpuAbort 后恢复: ${MIN_WORKERS} 个 Worker started`);
  } catch (e) {
    console.error('[sc] ❌ cpuAbort 后恢复失败:', e.message);
  }
  console.warn('[sc] 🚨 cpuAbort 完成');
}

// ====== 全局 ID 生成器 ======
let nextWorkerId = 0;
function genWorkerId() { return nextWorkerId++; }

// ====== 状态 ======
const workers = [];
const pendingJobs = new Map();
const taskQueues = { high: [], normal: [], low: [] };

// ====== 队列老化阈值: 低优先级任务排队超过 15 s自动提升一级，防止饿死 ======
const AGING_THRESHOLD_MS = 15000;

let isShuttingDown = false;
let warmupDone = false;
// ====== 模型warmup LRU 缓存(防膨胀) ======
// key=modelId, value={insertedAt, lastAccess}
// WARMED_MODELS_MAX imported from ./lib/constants.js
const warmedModels = new Map();

/** 检查模型是否已warmup,并标记为最近使用(LRU touch) */
function isModelWarmed(modelId) {
  if (warmedModels.has(modelId)) {
    // Touch: 更新最后访问时间,确保 LRU 淘汰准确
    warmedModels.set(modelId, {
      insertedAt: warmedModels.get(modelId).insertedAt,
      lastAccess: Date.now()
    });
    return true;
  }
  return false;
}

/** 标记模型已warmup,超过上限时淘汰最近最少使用的目 */
function markModelWarmed(modelId) {
  const now = Date.now();
  warmedModels.set(modelId, { insertedAt: now, lastAccess: now });
  if (warmedModels.size > WARMED_MODELS_MAX) {
    // LRU淘汰: 找最近最少访问(lastAccess 最小的)
    let lruKey = null;
    let lruTime = Infinity;
    for (const [k, v] of warmedModels) {
      if (v.lastAccess < lruTime) {
        lruTime = v.lastAccess;
        lruKey = k;
      }
    }
    if (lruKey) warmedModels.delete(lruKey);
  }
}
let heartbeatTimer = null;
let scaleTimer = null;

let readyPromise;

// ====== 子agent监控核心逻辑 ======

/**
 * 从 sessions.json 读取所有会话数据
 */
/**
 * 读取 sessions.json — 支持新旧两种路径格式
 * 
 * OpenClaw 新版将 sessions.json 移入了 sessions/ 目录下
 * （~/.openclaw/agents/main/sessions/sessions.json），
 * 旧版在 sessions 目录同级（~/.openclaw/agents/main/sessions.json）。
 * 此处优先读新版路径，失败时自动降级到旧版路径，
 * 避免后续 OpenClaw 版本升级/回滚导致路径失效。
 */
async function readSessionsJson() {
  const { readFile, access } = await import('fs/promises');
  const _paths = [
    join(SESSION_DIR, 'sessions.json'),  // 新版路径（OpenClaw 2026.5+）
    SESSION_DIR + '.json'                 // 旧版路径（兼容降级）
  ];
  for (const _p of _paths) {
    try {
      await access(_p);
      const raw = await readFile(_p, 'utf-8');
      return JSON.parse(raw);
    } catch { /* 路径不存在，试下一个 */ }
  }
  return null;
}

/**
 * 写回 sessions.json (用于强杀)
 */
async function writeSessionsJson(data) {
  const { writeFile, mkdir: mkd } = await import('fs/promises');
  const tmpPath = SESSION_DIR + '.json.tmp';
  try {
    await writeFile(tmpPath, JSON.stringify(data), 'utf-8');
    const { rename } = await import('fs/promises');
    await rename(tmpPath, SESSION_DIR + '.json');
    // 🔧 v5.31.0: 同时写新版 sessions/sessions.json（OpenClaw 2026.5+ 路径）
    try {
      await mkd(SESSION_DIR, { recursive: true });
      await writeFile(join(SESSION_DIR, 'sessions.json'), JSON.stringify(data), 'utf-8');
    } catch { /* 新版路径写入失败不阻塞 */ }
    return true;
  } catch {
    return false;
  }
}

/**
 * 获取当前所有子agent的快照
 * @param {number} maxStalledSeconds - 卡死判定阈值（s）
 * @returns {{ subagents: Array, stalled: Array, total: number, alive: number }}
 */
async function snapshotSubagents(maxStalledSeconds) {
  const data = await readSessionsJson();
  if (!data) {
    return { subagents: [], stalled: [], total: 0, alive: 0, error: '无法读取会话数据' };
  }

  const now = Date.now();
  const thresholdMs = (maxStalledSeconds || 120) * 1000;
  const subagents = [];
  const stalled = [];
  let aliveCount = 0;

  for (const [key, session] of Object.entries(data)) {
    if (!key.includes(':subagent:')) continue;

    const updatedAt = session.updatedAt || 0;
    const sessionStartedAt = session.sessionStartedAt || updatedAt;
    const ageMs = now - updatedAt;
    const runtimeMs = now - sessionStartedAt;
    const isStalled = ageMs > thresholdMs;
    const kind = session.subagentRole || (key.includes('spawn-child') ? 'spawn-child' : 'direct');

    // 🩺 判断卡死vs超时:
    // 卡死 = session状态标示进程已死(done/failed/timeout) → 需要清理session
    // 超时 = 进程可能还活着但没响应(lastUpdate>阈值) → 发告警，不杀
    const sessionStatus = session.status || (session.abortedLastRun ? 'aborted' : null);
    const isStuck = isStalled && (sessionStatus === 'done' || sessionStatus === 'failed' || sessionStatus === 'timeout' || sessionStatus === 'aborted');

    const entry = {
      key,
      sessionId: session.sessionId,
      spawnedBy: session.spawnedBy || 'unknown',
      ageSec: Math.round(ageMs / 1000),
      runtimeSec: Math.round(runtimeMs / 1000),
      updatedAt,
      startedAt: sessionStartedAt,
      model: session.model || 'unknown',
      thinkingLevel: session.thinkingLevel || 'unknown',
      kind,
      stalled: isStalled,
      stuck: isStuck,      // true=卡死(进程已死), false=超时(进程可能还活着)
      sessionStatus,         // 原始status值,供日志使用
    };

    subagents.push(entry);
    if (!isStalled) aliveCount++;
    if (isStalled) stalled.push(entry);
  }

  // 按 age 降序排序（最老的在前）
  subagents.sort((a, b) => b.ageSec - a.ageSec);
  stalled.sort((a, b) => b.ageSec - a.ageSec);

  return { subagents, stalled, total: subagents.length, alive: aliveCount };
}


/**
 * 强杀指定的子agent
 * @param {string} sessionId - 要杀的 sessionId
 * @param {string} sessionKey - 要杀的 session key
 * @returns {{ success: boolean, message: string }}
 */
async function killSubagent(sessionId, sessionKey) {
  try {
    // ⚡ 强杀前自动保存 checkpoint
    try { await saveCheckpoint(sessionId, { taskName: sessionKey }); } catch {}

    const data = await readSessionsJson();
    if (!data) return { success: false, message: '无法读取会话数据' };

    let removed = false;
    let removedKey = null;

    // 优先按 sessionId 匹配
    for (const [key, session] of Object.entries(data)) {
      if (session.sessionId === sessionId) {
        delete data[key];
        removed = true;
        removedKey = key;
        break;
      }
    }

    // 其次按 sessionKey 匹配
    if (!removed && sessionKey && data[sessionKey]) {
      delete data[sessionKey];
      removed = true;
      removedKey = sessionKey;
    }

    if (!removed) {
      return { success: false, message: `未找到 sessionId=${sessionId}` };
    }

    const wrote = await writeSessionsJson(data);
    if (wrote) {
      // TODO: 移除调试日志 console.log(`[sc] ? 已强杀子agent: ${removedKey}`);
      return { success: true, message: `已强杀子agent: ${removedKey}`, killedKey: removedKey };
    }
    return { success: false, message: '写入会话文件失败' };
  } catch (err) {
    return { success: false, message: `强杀失败: ${err.message}` };
  }
}

/**
 * 将监控告警推送到杉哥可见的通知文件和对话日志
 * @param {Array} alerts - 本轮超时提醒列表
 * @param {Array} killed - 保留参数（已弃用，不再强杀），传空数组
 */
async function tryWriteMonitorNotification(alerts, killed) {
  if (!alerts.length) return;

  try {
    const now = new Date();
    const ts = now.toISOString().replace('T', ' ').substring(0, 19);
    const { appendFile, writeFile } = await import('fs/promises');

    // 过滤已有通知的告警sessionId（跨轮次去重）
    const newAlerts = alerts.filter(a => !notifiedAlertIds.has(a.sessionId));
    for (const a of newAlerts) notifiedAlertIds.add(a.sessionId);

    if (!newAlerts.length) return;

    // 构造人可读通知文本
    let msg = `\n\n---\n⏰ **子agent超时提醒** (${ts})\n`;
    if (newAlerts.length > 0) {
      msg += `⚠️ 超时通知 (${newAlerts.length}个):\n`;
      for (const a of newAlerts) {
        const levelLabel = a.action === 'warning_3' ? '三级(10min)' : a.action === 'warning_2' ? '二级(5min)' : a.action === 'warning_1' ? '一级(2min)' : a.action;
        msg += `  - ${a.key || a.sessionId} 已卡死${a.ageSec}s (${levelLabel}) — 未强杀，持续关注\n`;
      }
    }

    // 1️. 写入对话日志目录下的监控通知文件（主agent可读）
    await appendFile(MONITOR_NOTIFY_LOG, msg, 'utf-8').catch(() => {});

    // 2️. 写入结构化JSON（latest only，供程序化读取）
    await writeFile(MONITOR_ALERT_FILE, JSON.stringify({
      timestamp: ts,
      alerts: newAlerts,
      killed: [],
      summary: `子agent超时提醒: ${newAlerts.length}个（三级分级，未强杀）`,
    }, null, 2), 'utf-8').catch(() => {});

    // TODO: 移除调试日志 console.log(`[sc] \u{1F4E2} 子agent超时提醒: ${newAlerts.length}个（未强杀）`);
  } catch (err) {
    console.warn(`[sc] \u26A0\uFE0F 写入超时提醒通知失败: ${err.message}`);
  }
}

/**
 * 执行一次完整的监控轮次
 */
async function runMonitorCycle() {
  const maxSec = monitorState.maxStalledSeconds;
  const snapshot = await snapshotSubagents(maxSec);
  monitorState.lastSnapshot = snapshot;

  const alerts = [];
  const killed = [];

  if (snapshot.stalled.length > 0) {
    for (const stalled of snapshot.stalled) {
      const sid = stalled.sessionId;

      // ════════════════════════════════════════
      // 💀 卡死处理：进程已死(done/failed/timeout状态)
      //    直接 killSubagent 清理session，不写通知
      // ════════════════════════════════════════
      if (stalled.stuck) {
        killed.push({ sessionId: sid, key: stalled.key, ageSec: stalled.ageSec, runtimeSec: stalled.runtimeSec, action: 'stuck_kill', reason: `session状态=${stalled.sessionStatus}` });
        const killResult = await killSubagent(sid, stalled.key).catch(err => ({ success: false, message: err.message }));
        if (killResult.success) {
          // TODO: 移除调试日志 console.log(`[sc] 💀 卡死子agent已强杀: ${stalled.key || sid} (${stalled.sessionStatus}, 已卡死${stalled.ageSec}s)`);
        } else {
          console.warn(`[sc] ⚠️ 卡死子agent强杀失败: ${sid} - ${killResult.message}`);
        }
        // 卡死不写通知，从stalledHistory移除
        monitorState.stalledHistory.delete(sid);
        continue;
      }

      // ════════════════════════════════════════
      // ⏰ 超时处理：进程可能还活着但超过120s没反应
      //    写alert文件供主agent读，不强杀
      // ════════════════════════════════════════
      const prev = monitorState.stalledHistory.get(sid);

      if (!prev) {
        // 首次超时检测
        monitorState.stalledHistory.set(sid, { firstStalledAt: Date.now(), alertSent: false });
        alerts.push({ sessionId: sid, key: stalled.key, ageSec: stalled.ageSec, runtimeSec: stalled.runtimeSec, action: 'detected' });
        continue;
      }

      if (!prev.alertSent) {
        prev.alertSent = true;
        alerts.push({ sessionId: sid, key: stalled.key, ageSec: stalled.ageSec, runtimeSec: stalled.runtimeSec, action: 'alert' });
      }

      // 多级超时提醒
      const stalledDurationSec = stalled.ageSec;
      if (stalledDurationSec >= 600) {
        // 三级警告：超600s（10min）
        const alertKey = `warning-3-${sid}`;
        if (!notifiedAlertIds.has(alertKey)) {
          notifiedAlertIds.add(alertKey);
          alerts.push({ sessionId: sid, key: stalled.key, ageSec: stalled.ageSec, runtimeSec: stalled.runtimeSec, action: 'warning_3', message: '⏰ 子agent超600s(10min)，请人工关注（未强杀）' });
        }
      } else if (stalledDurationSec >= 300) {
        // 二级警告：超300s（5min）
        const alertKey = `warning-2-${sid}`;
        if (!notifiedAlertIds.has(alertKey)) {
          notifiedAlertIds.add(alertKey);
          alerts.push({ sessionId: sid, key: stalled.key, ageSec: stalled.ageSec, runtimeSec: stalled.runtimeSec, action: 'warning_2', message: '⏰ 子agent超300s(5min)，持续卡死中（未强杀）' });
        }
      } else if (stalledDurationSec >= 120) {
        // 一级提醒：超120s（2min）
        const alertKey = `warning-1-${sid}`;
        if (!notifiedAlertIds.has(alertKey)) {
          notifiedAlertIds.add(alertKey);
          alerts.push({ sessionId: sid, key: stalled.key, ageSec: stalled.ageSec, runtimeSec: stalled.runtimeSec, action: 'warning_1', message: '⏰ 子agent超120s(2min)，已发提醒（未强杀）' });
        }
      }
    }

    // 清理已恢复的子agent记录
    const aliveIds = new Set(snapshot.subagents.filter(s => !s.stalled).map(s => s.sessionId));
    for (const [sid] of monitorState.stalledHistory) {
      if (!aliveIds.has(sid)) {
        monitorState.stalledHistory.delete(sid);
      }
    }
  }

  // ====== 系统状态报告：汇总本次轮询所有状态，写一份完整报告到 shared/tasks/ ======
  try {
    const poolStats = pool.getStats();
    const mem = getMemoryLevel();
    const aliveCount = snapshot.subagents ? snapshot.subagents.filter(s => !s.terminated).length : 0;
    const totalCount = snapshot.subagents ? snapshot.subagents.length : 0;
    const longRunning = snapshot.subagents ? snapshot.subagents.filter(s => !s.terminated && s.runtimeSec > 120) : [];
    const stuckItems = killed.filter(a => a.action === 'stuck_kill');
    const timeoutItems = alerts.filter(a => a.action.startsWith('warning'));

    const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);

    let output = `📊 系统状态报告 (${ts})\n`;
    output += `━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

    // 小弟概览
    output += `\n👥 子agent: 共${totalCount}个 | 活跃${aliveCount}个`;
    if (longRunning.length > 0) output += ` | 超时${longRunning.length}个`;
    if (stuckItems.length > 0) output += ` | 💀卡死强杀${stuckItems.length}个`;
    if (timeoutItems.length > 0) output += ` | ⏰超时告警${timeoutItems.length}个`;
    output += `\n`;

    // Worker池状态
    output += `\n⚙️ Worker池: 共${poolStats.total}个 | 忙碌${poolStats.busy}个 | 队列${poolStats.queueDepth}个 | 飞行中${poolStats.inFlight}个\n`;

    // 内存 & 紧急模式
    const memIcons = { green: '🟢', yellow: '🟡', red: '🔴', meltdown: '💥' };
    output += `\n💾 内存: ${memIcons[mem.level] || '❓'} ${mem.level} | 空闲${mem.freeGB.toFixed(1)}GB | 堆${mem.heapUsedMB}MB\n`;
    output += `🚨 紧急模式: ${emergency ? '🔴 已触发' : '🟢 正常'}\n`;

    // 超2min的小弟明细
    if (longRunning.length > 0) {
      output += `\n⏰ 跑超2min的小弟:\n`;
      for (const s of longRunning) {
        output += `  - ${s.key || s.taskName || s.sessionId} 已跑${s.runtimeSec}s\n`;
      }
    }

    // 💀 卡死强杀明细
    if (stuckItems.length > 0) {
      output += `\n💀 卡死强杀:\n`;
      for (const a of stuckItems) {
        output += `  - ${a.key || a.sessionId} ${a.reason||'进程已死'}，已卡死${a.ageSec}s，已强杀清理\n`;
      }
    }

    // ⏰ 超时告警明细（不杀，只告警）
    const stallWarnings = alerts.filter(a => a.action.startsWith('warning'));
    if (stallWarnings.length > 0) {
      output += `\n⏰ 超时告警（不杀，只告警）:\n`;
      for (const a of stallWarnings) {
        const levelMap = { warning_3: '三级(10min)', warning_2: '二级(5min)', warning_1: '一级(2min)' };
        output += `  - ${a.key || a.sessionId} 卡死${a.ageSec}s (已跑${a.runtimeSec}s) — ${levelMap[a.action] || a.action}提醒\n`;
      }
    }

    const reportId = `monitor-report-${Date.now()}`;
    writeSharedResult(reportId, { status: 'info', output }).catch(() => {});

    // ====== ? 用户通知：检测到异常时通知杉哥 ======
    // ⏰ 通知所有超时提醒（warning_1/warning_2/warning_3）
    // 💀 卡死强杀事件不通知（直接杀，不写文件）
    const userAlerts = alerts.filter(a => a.action.startsWith('warning'));
    if (userAlerts.length > 0) {
      tryWriteMonitorNotification(userAlerts, []);
    }
  } catch (err) {
    console.warn(`[sc] ⚠️ 生成监控报告失败: ${err.message}`);
  }

  return { snapshot, alerts, killed };
}

/**
 * 启动后台监控循环
 */
function startMonitorBackground() {
  if (monitorState.timer) {
    clearInterval(monitorState.timer);
    monitorState.timer = null;
  }
  monitorState.active = true;

  // 立即跑一轮
  runMonitorCycle().catch(err => {
    console.warn(`[sc] ⚠️ 监控首轮失败: ${err.message}`);
  });

  monitorState.timer = setInterval(() => {
    if (!monitorState.active) {
      clearInterval(monitorState.timer);
      monitorState.timer = null;
      return;
    }
    runMonitorCycle().catch(err => {
      console.warn(`[sc] ⚠️ 监控轮询失败: ${err.message}`);
    });
  }, monitorState.intervalSeconds * 1000);

  // TODO: 移除调试日志 console.log(`[sc] ? 子agent监控started (interval=${monitorState.intervalSeconds}s, 阈值=${monitorState.maxStalledSeconds}s, 💀卡死强杀+⏰超时告警)`);
}

/**
 * 停止后台监控循环
 */
function stopMonitorBackground() {
  monitorState.active = false;
  if (monitorState.timer) {
    clearInterval(monitorState.timer);
    monitorState.timer = null;
  }
  monitorState.stalledHistory.clear();
  notifiedAlertIds.clear();
  // TODO: 移除调试日志 console.log('[sc] ? 子agent监控已停止');
}

// ====== Worker 替换日志 ======
async function logWorkerReplacement(workerId, reason, detail = '') {
  try {
    const { appendFile } = await import('fs/promises');
    const ts = new Date().toISOString();
    const line = `[${ts}] Worker-${workerId} 替换: ${reason}${detail ? ' | ' + detail : ''}\n`;
    await appendFile(WORKER_REPLACEMENT_LOG, line, 'utf-8');
  } catch (err) {
    console.warn(`[sc] ⚠️ 写入替换日志失败: ${err.message}`);
  }
}

// ====== Worker 池 ======
class CpuWorkerPool {
  constructor() {
    // 初始化角色计数
    // 从 ROLE_CONFIG 动态初始化所有角色计数（含扩增角色）
    this._roleCounts = Object.fromEntries(Object.keys(ROLE_CONFIG).map(k => [k, 0]));
    this._preemptCheckTimer = null;
    this._preemptedCount = 0;

    this._initPool(MIN_WORKERS);
    this._startHeartbeat();
    this._startScaleTimer();
    this._startRollingRestartTimer();
    this._readyTimer = null;

    // 确保 preempt 目录ready
    ensurePreemptDir().catch(() => {});
    readyPromise = new Promise((resolve) => {
      const READY_TIMEOUT_MS = 30000;
      const timeout = setTimeout(() => {
        console.warn(`[sc] ⏱ Worker 池 ${READY_TIMEOUT_MS/1000}s 超时,降级运行(alive=${workers.filter(w => w.alive).length}/${MIN_WORKERS})`);
        resolve(false);
      }, READY_TIMEOUT_MS);
      const check = () => {
        if (isShuttingDown) { clearTimeout(timeout); resolve(false); return; }
        if (workers.filter(w => w.alive).length >= MIN_WORKERS) {
          clearTimeout(timeout);
          resolve(true);
          // 池ready后自动清理旧session + 孤儿任务元数据
          cleanupOldSessions().catch((err) => { console.warn('[sc] 异步错误:', err?.message); });
          cleanupTaskStates().catch((err) => { console.warn('[sc] 异步错误:', err?.message); });
        } else {
          this._readyTimer = setTimeout(check, 100);
        }
      };
      check();
    });
    // TODO: 移除调试日志 console.log(`[sc] worker pool started:MIN=${MIN_WORKERS} MAX=${MAX_WORKERS}(动态)`);
  }

  _initPool(count) {
    const workerPath = join(__dirname, "workers", "worker.js");
    const roleDistribution = getInitialRoleDistribution();
    const roleKeys = ["scanner", "compute", "router", "stemcell"];

    // 先按最小配置分配
    for (const role of roleKeys) {
      const target = roleDistribution[role];
      for (let i = 0; i < target; i++) {
        this._spawnWorker(workerPath, role);
      }
    }

    // 剩余Worker作为backupWorker（兜底角色）
    // 🧬 设计决策: backupWorker 是保底角色，任一角色(scanner/compute/router)全崩时自动分化填补
    // 不是多余复杂度，是专业分工的核心设计。见 known-design-decisions.md → Worker 池设计
    const spawned = workers.length;
    for (let i = spawned; i < count; i++) {
      this._spawnWorker(workerPath, "stemcell");
    }
  }

  _spawnWorker(workerPath, role) {
    role = role || "stemcell";
    try {
      const actualId = genWorkerId();
      const w = new Worker(workerPath, { workerData: { id: actualId } });
      const entry = {
        id: actualId,
        role,
        worker: w,
        busy: false,
        idleSince: Date.now(),
        alive: true,
        crashCount: 0,
        lastCrash: 0,
        currentJobId: null,
        currentJobStartTime: null,
        hbPending: false,
        terminating: false,
        startTime: Date.now(),
        completedTasks: 0,
        partialResult: null,
      };

      this._roleCounts[role] = (this._roleCounts[role] || 0) + 1;

      w.on("message", (msg) => this._onWorkerMessage(entry, msg));
      w.on("error", (err) => this._onWorkerCrash(entry, err, workerPath, "crash"));
      w.on("exit", (code) => this._onWorkerCrash(entry, new Error(`Worker exited with code ${code}`), workerPath, "exit"));

      workers.push(entry);
      // 日志: Worker 创建事件
      const lg = global.__sansanLogger;
      if (lg) lg.logWorkerEvent(actualId, 'SPAWN', `role=${role} 已创建 (池中共${workers.length}个)`).catch(() => {});
      return entry;
    } catch (e) {
      console.error("[sc] spawnWorker 失败:", e.message);
      return null;
    }
  }

  /**
   * 获取任务类型对应的角色
   * @param {string} taskType - 任务类型
   * @returns {string} 角色名: scanner/compute/router/stemcell
   */
  _getTaskRole(taskType) {
    return TASK_TYPE_ROLE_MAP[taskType] || 'stemcell';
  }

  /**
   * 找最适合处理该任务的空闲Worker
   * 优先匹配角色，然后stemcell兜底
   * @param {string} role - 目标角色
   * @returns {object|null} Worker entry
   */
  _findAvailableWorker(role) {
    // 第一优先：同角色空闲Worker
    const roleWorkers = workers.filter(w => w.alive && !w.busy && !w.hbPending && !w.terminating && w.role === role);
    if (roleWorkers.length > 0) return roleWorkers.sort((a, b) => (a.idleSince || 0) - (b.idleSince || 0))[0];

    // 第二优先：stemcell 兜底
    if (role !== 'router') {
      const stemcells = workers.filter(w => w.alive && !w.busy && !w.hbPending && !w.terminating && w.role === 'stemcell');
      if (stemcells.length > 0) return stemcells.sort((a, b) => (a.idleSince || 0) - (b.idleSince || 0))[0];
    }

    // 第三优先：其他角色空闲Worker跨角色帮忙（弹性转岗：所有角色都能转）
    // 谁闲着就拉谁干活，不挑角色
    const anyIdle = workers.filter(w => w.alive && !w.busy && !w.hbPending && !w.terminating);
    if (anyIdle.length > 0) {
      const picked = anyIdle.sort((a, b) => (a.idleSince || 0) - (b.idleSince || 0))[0];
      // 标记这位Worker借调到了别的角色
      picked._borrowedRole = role;
      return picked;
    }

    return null;
  }

  /**
   * 高优任务抢占触发
   * 评估所有活跃任务，抢占最低优先级分的任务
   * 抢占成功后：序列化状态到 shared/preempt/，将任务重新加入队列头部等待恢复
   * @returns {Promise<boolean>} 是否成功preempt
   */
  async _triggerPreemption() {
    if (isShuttingDown) return false;

    const aliveBusy = workers.filter(w => w.alive && w.busy && !w.terminating && w.currentJobId);
    const totalQueued = Object.values(taskQueues).reduce((a, b) => a + b.length, 0);

    // 阈值：所有Worker忙碌 + 队列 > 5
    if (aliveBusy.length < workers.filter(w => w.alive && !w.terminating).length || totalQueued <= PREEMPT_QUEUE_THRESHOLD) {
      return false;
    }

    // 用独立的 evaluatePreemption 函数计算优先级分
    const evalResult = evaluatePreemption(
      { getStats: () => this.getStats() },
      taskQueues,
      workers
    );

    if (!evalResult.shouldPreempt || !evalResult.target) {
      return false;
    }

    const target = evalResult.target;
    const we = target.workerEntry;

    // 标记Worker已被preempt
    we._preempted = true;

    // TODO: 移除调试日志 console.log('[sc] 资源抢占: Worker ' + we.id + '(' + we.role + ') 任务 ' + target.task.type + ' 被抢占 (优先级分=' + target.score.toFixed(3) + ')');

    // 1. 序列化状态
    const stateSaved = await savePreemptState(target);
    if (!stateSaved) {
      delete we._preempted;
      console.warn('[sc] preempt状态保存失败，取消preempt');
      return false;
    }

    // 2. 从 pendingJobs 摘除
    const jobId = target.jobId;
    const pending = pendingJobs.get(jobId);
    if (pending) {
      clearTimeout(pending.timeout);
      pendingJobs.delete(jobId);
    }

    // 3. 将任务重新加入队列头部
    const recoveryTask = {
      ...target.task,
      _preempted: true,
      _preemptedJobId: jobId,
      _preemptedAt: Date.now(),
      _originalRole: we.role,
    };

    taskQueues.high.unshift({
      task: recoveryTask,
      resolve: target.pendingJob.resolve,
      reject: target.pendingJob.reject,
    });

    // 4. 清理Worker状态
    we.busy = false;
    we.currentJobId = null;
    we.currentJobStartTime = null;
    we.idleSince = Date.now();
    delete we._preempted;

    this._preemptedCount++;

    // 5. 立即处理队列
    setImmediate(() => this._processQueue());

    return true;
  }

  _onWorkerCrash(entry, err, workerPath, reason = "crash") {
    if (entry.killedByScaleDown) {
      // alive=false 已由scale down逻辑设置,但 pendingJobs 仍需回收
      const toReject = [];
      for (const [jobId, p] of pendingJobs) {
        if (p.workerId === entry.id) {
          clearTimeout(p.timeout);
          pendingJobs.delete(jobId);
          toReject.push(p);
        }
      }
      for (const p of toReject) {
        p.reject(new Error(`[sc] Worker ${entry.id} 被scale down`));
      }
      const idx = workers.indexOf(entry);
      if (idx >= 0) workers.splice(idx, 1);
      return;
    }

    if (entry.isHeartbeatKill) {
      delete entry.isHeartbeatKill;
      entry.alive = false;
      entry.busy = false;
      entry.currentJobId = null;
      // BUG-FIX: 心跳强杀Worker时回收该Worker的pendingJobs
      const toRejectHb = [];
      for (const [jobId, p] of pendingJobs) {
        if (p.workerId === entry.id) {
          clearTimeout(p.timeout);
          pendingJobs.delete(jobId);
          toRejectHb.push(p);
        }
      }
      for (const p of toRejectHb) {
        p.reject(new Error(`[sc] Worker ${entry.id} 心跳超时被强杀`));
      }
      const idx = workers.indexOf(entry);
      if (idx >= 0) workers.splice(idx, 1);
      if (!isShuttingDown) {
        setTimeout(() => {
          if (isShuttingDown) return;
          let aliveCount = workers.filter(w => w.alive && !w.terminating).length;
          if (aliveCount < getDynamicMaxWorkers()) {
            const e = this._spawnWorker(workerPath);
            if (e) aliveCount++;
          }
          while (aliveCount < MIN_WORKERS) {
            const e = this._spawnWorker(workerPath);
            if (!e) break;
            aliveCount++;
          }
          this._processQueue();
        }, 0);
      }
      return;
    }

    if (!entry.alive) return;

    if (reason === "crash") console.error(`[sc] Worker ${entry.id} 崩溃:`, err.message);
    else console.warn(`[sc] Worker ${entry.id} 离线 (${reason}): ${err.message}`);
    // 日志: Worker 崩溃事件
    const lg = global.__sansanLogger;
    if (lg) lg.logWorkerEvent(entry.id, 'CRASH', `${reason}: ${err.message.substring(0, 100)}`).catch(() => {});
    entry.alive = false;
    entry.busy = false;
    const deadIdx = workers.indexOf(entry);
    if (deadIdx >= 0) workers.splice(deadIdx, 1);
    entry.currentJobId = null;
    entry.terminating = false;

    // 清理探索型 checkpoint 定时器（Worker崩溃）
    if (entry._exploratoryTimer) {
      clearInterval(entry._exploratoryTimer);
      entry._exploratoryTimer = null;
    }

    if (isShuttingDown) return;

    const toReject = [];
    for (const [jobId, p] of pendingJobs) {
      if (p.workerId === entry.id) {
        clearTimeout(p.timeout);
        pendingJobs.delete(jobId);
        toReject.push(p);
      }
    }
    for (const p of toReject) {
      p.reject(new Error(`[sc] Worker ${entry.id} 已崩溃/退出`));
    }

    this._processQueue();

    const now = Date.now();
    // # FIXED: V2 - 改用基于时间的衰减:30min内连续崩溃才累加,超时自动归零
    if (now - entry.lastCrash < 30000) {
      entry.crashCount = Math.min(entry.crashCount + 1, 6); // 上限6次避免无限
    } else {
      entry.crashCount = Math.min(1, Math.max(0, entry.crashCount - 2)); // 衰减2级
    }
    entry.lastCrash = now;

    const delay = Math.min(1000 * Math.pow(2, entry.crashCount - 1), 30000);
    // TODO: 移除调试日志 console.log(`[sc] Worker ${entry.id} 第 ${entry.crashCount} 次崩溃,${delay}ms 后重启`);

    // # FIXED: V2 - 新Worker不从旧Worker继承 crashCount/lastCrash,指数退避可衰减
    setTimeout(() => {
      if (isShuttingDown) return;

      let aliveCount = workers.filter(w => w.alive && !w.terminating).length;

      if (aliveCount < getDynamicMaxWorkers()) {
        const newEntry = this._spawnWorker(workerPath);
        if (newEntry) {
          // 新Worker从0开始计数,旧crashCount仅用于指数退避delay计算
          newEntry.crashCount = 0;
          newEntry.lastCrash = 0;
          aliveCount++;
        }
      }

      while (aliveCount < MIN_WORKERS) {
        const e = this._spawnWorker(workerPath);
        if (e) aliveCount++;
        else break;
      }

      this._processQueue();
    }, delay);
  }

  _startScaleTimer() {
    // 🧬 设计决策: 5s间隔刚好平衡响应速度和开销
    // 扩容延迟不超过5s，且每次调用开销<1ms
    // 见 known-design-decisions.md → 魔法数字
    scaleTimer = setInterval(() => this._autoScale(), 5000);
  }

  _autoScale() {
    if (isShuttingDown) return;

    // 内存红灯时主动scale down
    const memLevel = getCachedMemoryLevel();
    if (memLevel.level === 'red' || memLevel.level === 'meltdown') {
      // 强制缩到 MIN_WORKERS
      const current = workers;
      let removed = 0;
      for (let i = current.length - 1; i >= 0 && current.length > MIN_WORKERS; i--) {
        const entry = current[i];
        if (!entry.busy && !entry.hbPending) {
          entry.killedByScaleDown = true;
          entry.terminating = true;
          entry.alive = false;
          entry.worker.terminate().catch(() => {});
          current.splice(i, 1);
          removed++;
        }
      }
      if (removed > 0) {
        const nuLog = getMetabolicRateConfig().nu;
        // TODO: 移除调试日志 console.log(`[sc] 内存${memLevel.level} 强制scale down -${removed} → ${current.filter(w => w.alive).length}/${getDynamicMaxWorkers()} (ν=${nuLog.toFixed(2)})`);
      }
      return;
    }

    const alive = workers.filter(w => w.alive);
    const activeCount = alive.filter(w => !w.terminating).length;
    const totalQueued = Object.values(taskQueues).reduce((a, b) => a + b.length, 0);
    const queueRatio = totalQueued / Math.max(1, activeCount);

    // 资源调度强度平滑精细控制：基于连续资源调度强度值而非离散档位
    const meta = getMetabolicRateConfig();
    const effectiveMinWorkers = meta.minWorkers;
    const effectiveMaxWorkers = meta.maxWorkers;

    // 低资源调度强度(≈休息)：主动scale down到最低Worker数
    if (meta.rate < 0.3) {
      const toRemove = Math.max(0, activeCount - effectiveMinWorkers);
      if (toRemove > 0) {
        const idleForRest = alive.filter(w => !w.busy && !w.hbPending && !w.terminating);
        const toKill = idleForRest.slice(0, toRemove);
        for (const e of toKill) {
          e.killedByScaleDown = true;
          e.terminating = true;
          e.alive = false;
          e.worker.terminate().catch((err) => { console.warn('[sc] 异步错误:', err?.message); });
        }
        if (toKill.length > 0) console.log(`[sc] 💤 低metabolic ratescale down -${toKill.length} → ${activeCount - toKill.length}/${effectiveMinWorkers} (ν=${meta.nu.toFixed(2)})`);
      }
      // 低资源调度强度warmupWorker
      if (meta.autoWarmup) {
        this.warmup().catch(() => {});
      }
      return;
    }

    // 平滑扩容阈值：资源调度强度越高→扩容越激进（阈值越低，一次扩越多）
    // 资源调度强度0.3→SCALE_UP_THRESHOLD×1.0, 0.8→×0.5, 1.0→×0.3
    const thresholdFactor = Math.max(0.3, Math.min(1.0, 1.0 - (meta.rate - 0.3) / 0.7 * 0.7));
    const scaleThreshold = Math.max(0.3, SCALE_UP_THRESHOLD * thresholdFactor);

    // 动态扩容批量：资源调度强度越高→一次扩越多
    // 资源调度强度0.3→扩2个, 0.5→扩2个, 0.8→扩3个, 1.0→扩4个
    const addBatchSize = Math.min(4, Math.max(2, Math.round(meta.rate * 4)));

    if (queueRatio > scaleThreshold && activeCount < effectiveMaxWorkers) {
      const toAdd = Math.min(addBatchSize, effectiveMaxWorkers - activeCount);
      let actualAdded = 0;
      for (let i = 0; i < toAdd; i++) {
        if (this._spawnWorker(join(__dirname, "workers", "worker.js"))) actualAdded++;
      }
      if (actualAdded > 0) {
        const newTotal = activeCount + actualAdded;
        // TODO: 移除调试日志 console.log(`[sc] 📈 扩容 +${actualAdded} → ${newTotal}/${effectiveMaxWorkers} (metabolic rate=${meta.rate.toFixed(2)} ν=${meta.nu.toFixed(2)})`);
      }
      this._processQueue();
      return;
    }

    // 后台学习已删除（管理员2026-05-31要求移除）
    const idleWorkers = alive.filter(w => !w.busy && !w.hbPending && !w.terminating);

    if (alive.length > effectiveMinWorkers) {
      const idle = idleWorkers.filter(w => (Date.now() - w.idleSince) > IDLE_TERMINATE_MS);
      const canRemove = Math.min(idle.length, alive.length - effectiveMinWorkers);
      if (canRemove > 0) {
        const toKill = idle.slice(0, canRemove);
        for (const e of toKill) {
          e.killedByScaleDown = true;
          e.terminating = true;
          e.alive = false;
          e.worker.terminate().catch((err) => { console.warn('[sc] 异步错误:', err?.message); });
        }
        // TODO: 移除调试日志 console.log(`[sc] 📉 scale down -${toKill.length} (metabolic rate=${meta.rate.toFixed(2)} ν=${meta.nu.toFixed(2)})`);
      }
    }

    // Worker寿命管理: 空闲老年Worker置换(不计数在scale down中,由单独逻辑管理)
    this._replaceAgedWorkers().catch(err => {
      console.warn(`[sc] ⚠️ 自动Worker寿命置换检查失败: ${err.message}`);
    });

    // 🕐 派兵进度检查(复用5s _autoScale 循环,0额外开销)
    this._checkSpawnProgress().catch(() => {});
  }

  // ====== Worker 寿命管理（Worker寿命管理）======

  /**
   * Worker寿命管理设计: Worker 6小时/2000任务寿命上限，防内存泄漏累积
   * 超过上限即标记为aged，由_replaceAgedWorkers()滚动置换
   * 设计决策见: memory/known-design-decisions.md → Worker 池设计
   */
  _isWorkerAged(entry) {
    if (!entry || !entry.alive || entry.terminating) return false;
    const age = Date.now() - (entry.startTime || Date.now());
    const tasks = entry.completedTasks || 0;
    return age >= MAX_WORKER_AGE || tasks >= MAX_WORKER_TASKS;
  }

  /** Rolling Restart: replace aged idle workers, max 1/3 at a time */
  async _replaceAgedWorkers() {
    if (isShuttingDown) return;

    const aliveWorkers = workers.filter(w => w.alive && !w.terminating);
    if (aliveWorkers.length <= MIN_WORKERS) return; // minimum safety net

    // Only replace IDLE aged workers, never busy ones
    const agedIdle = aliveWorkers.filter(w => !w.busy && !w.hbPending && this._isWorkerAged(w));
    if (agedIdle.length === 0) return;

    // Rolling Restart: max 1/3 of current live workers per batch
    // 🧬 设计决策: 每次最多置换1/3，保证任何时候至少2/3 Worker可用
    // 不是效率低，是故意保守。全部同时重启会导致服务降级
    const maxReplace = Math.max(1, Math.floor(aliveWorkers.length * ROLLING_RESTART_BATCH_RATIO));
    const toReplace = agedIdle.slice(0, maxReplace);
    if (toReplace.length === 0) return;

    const workerPath = join(__dirname, "workers", "worker.js");

    for (const entry of toReplace) {
      const age = Date.now() - entry.startTime;
      const tasks = entry.completedTasks || 0;
      const reason = age >= MAX_WORKER_AGE
        ? `年龄超限(${(age / 3600000).toFixed(1)}h)`
        : `任务超限(${tasks}任务)`;

      entry.killedByScaleDown = true;
      entry.terminating = true;
      entry.alive = false;
      entry.worker.terminate().catch(() => {});

      const idx = workers.indexOf(entry);
      if (idx >= 0) workers.splice(idx, 1);

      logWorkerReplacement(entry.id, reason, `年龄=${(age / 3600000).toFixed(1)}h, 任务=${tasks}`);
      // TODO: 移除调试日志 console.log(`[sc] 🔄 老年Worker ${entry.id} 优雅下线: ${reason}`);
    }

    // Spawn replacements
    for (let i = 0; i < toReplace.length; i++) {
      this._spawnWorker(workerPath);
    }

    // TODO: 移除调试日志 console.log(`[sc] 🔄 Rolling Restart: 替换 ${toReplace.length} 个老年Worker`);
  }

  /**
   * 🕐 派兵进度检查 — 每5s_autoScale循环调用
   *
   * 扫 shared/tasks/ 下registered的multi_aspect子agent状态文件，
   * 状态变更时写 shared/progress-report.json，
   * 主agent下一轮对话自动读到并汇报。
   *
   * 设计：
   *   - 复用 _autoScale() 的 5 s循环，0 额外定时开销
   *   - 轻量：只读文件元数据 + 状态比较，不调AI
   *   - 分级汇报：5s→15s→30s→60s逐步深入
   */
  async _checkSpawnProgress() {
    if (isShuttingDown) return;
    try {
      const tasksDir = join(homedir(), '.openclaw', 'workspace', 'memory', 'shared', 'tasks');
      const progressFile = join(homedir(), '.openclaw', 'workspace', 'memory', 'shared', 'progress-report.json');

      // 确保目录存在
      try { await mkdir(join(homedir(), '.openclaw', 'workspace', 'memory', 'shared'), { recursive: true }); } catch {}

      // 读已完成/失败/超时的任务文件
      let files = [];
      try { files = await readdir(tasksDir); } catch { return; }

      const taskFiles = files.filter(f =>
        f.endsWith('.json') &&
        !f.endsWith('.meta.json') &&
        !f.endsWith('.tmp') &&
        !f.endsWith('.reading.json')
      );
      if (taskFiles.length === 0) return;

      // 读上次进度
      let prevProgress = { checkedTasks: [], checkedAt: 0 };
      try {
        prevProgress = JSON.parse(await readFile(progressFile, 'utf-8'));
      } catch {}

      const now = Date.now();
      const checkedSet = new Set(prevProgress.checkedTasks || []);
      const newDone = [];
      const newFailed = [];

      for (const f of taskFiles) {
        if (checkedSet.has(f)) continue; // 已检查过的不重复
        try {
          const st = await stat(join(tasksDir, f));
          const ageSec = (now - st.mtimeMs) / 1000;
          if (ageSec < 3) continue; // 文件太新，等稳定

          const raw = await readFile(join(tasksDir, f), 'utf-8');
          const task = JSON.parse(raw);
          if (task.status === 'done') newDone.push(task);
          else if (task.status === 'failed' || task.status === 'timeout') newFailed.push(task);
        } catch {}
      }

      if (newDone.length === 0 && newFailed.length === 0) return;

      // 写进度报告
      const report = {
        updatedAt: now,
        done: newDone.map(t => ({ taskId: t.taskId, summary: t.output?.summary || t.output?.conclusion || '已完成' })),
        failed: newFailed.map(t => ({ taskId: t.taskId, error: t.errors?.[0] || '未知错误' })),
        checkedTasks: [...checkedSet, ...newDone.map(t => t.taskId + '.json'), ...newFailed.map(t => t.taskId + '.json')],
        checkedAt: now,
      };
      await writeFile(progressFile, JSON.stringify(report, null, 2), 'utf-8');

      if (newDone.length > 0) {
        // TODO: 移除调试日志 console.log(`[sc] 🕐 派兵进度: ${newDone.length}个完成, ${newFailed.length}个失败`);
      }
    } catch (err) {
      // 静默失败，不阻塞_autoScale
      if (getEnv('NODE_ENV') !== 'production') {
        console.warn(`[sc] ⚠️ _checkSpawnProgress: ${err.message}`);
      }
    }
  }

  _startRollingRestartTimer() {
    this._rollingRestartTimer = setInterval(() => {
      this._replaceAgedWorkers().catch(err => {
        console.warn(`[sc] ⚠️ Rolling Restart 检查失败: ${err.message}`);
      });
    }, ROLLING_RESTART_CHECK_INTERVAL_MS);
    // TODO: 移除调试日志 console.log(`[sc] 🔄 Rolling Restart 定时器started (interval=${ROLLING_RESTART_CHECK_INTERVAL_MS/1000}s)`);
  }

  _startHeartbeat() {
    this._hbRunning = false;
    heartbeatTimer = setInterval(() => this._heartbeat(), HEARTBEAT_MS);
  }

  async _heartbeat() {
    if (this._hbRunning || isShuttingDown) return;
    this._hbRunning = true;
    try {
      const idle = workers.filter(w => w.alive && !w.busy);
      await Promise.allSettled(idle.map(async (e) => {
        if (!e.alive || e.busy || e.hbPending || e.terminating) return;
        e.hbPending = true;
        const jobId = crypto.randomUUID();
        let rejectFn;
        const p = new Promise((res, rej) => {
          rejectFn = rej;
          const t = setTimeout(() => { pendingJobs.delete(jobId); rej(new Error("心跳超时")); }, 5000);
          pendingJobs.set(jobId, { resolve: res, reject: rej, timeout: t, workerId: e.id, kind: "heartbeat" });
        });
        try {
          e.worker.postMessage({ jobId, type: "ping" });
        } catch (postErr) {
          const rec = pendingJobs.get(jobId);
          if (rec) { clearTimeout(rec.timeout); pendingJobs.delete(jobId); }
          rejectFn(postErr);
        }
        try {
          await p;
          e.crashCount = 0;
        } catch {
          e.alive = false;
          e.terminating = true;
          e.isHeartbeatKill = true;
          e.worker.terminate().catch((err) => { console.warn('[sc] 异步错误:', err?.message); });
        } finally {
          e.hbPending = false;
          if (e.alive && !e.terminating && !e.busy) this._processQueue();
        }
      }));
    } finally {
      this._hbRunning = false;
    }
  }

  _onWorkerMessage(entry, msg) {
    if (isShuttingDown) return;
    const { jobId, type, data, error } = msg;
    if (!jobId) return;

    const pending = pendingJobs.get(jobId);

    if (pending?.kind === "heartbeat") {
      clearTimeout(pending.timeout);
      pendingJobs.delete(jobId);
      entry.crashCount = 0;
      if (type === "result") pending.resolve(data);
      else pending.reject(new Error("heartbeat failed"));
      return;
    }

    if (entry.currentJobId !== null && jobId !== entry.currentJobId) return;

    // 被抢占的Worker忽略旧消息
    if (entry._preempted) {
      return;
    }

    // 🧠 可判定终止: 探索型任务 partialResult 实时写入（不终止任务）
    if (type === "partialResult") {
      if (data) {
        entry.partialResult = data;
        // 立即写一次 checkpoint 确保中间结果不丢
        const cpName = `exploratory-${data.taskType || 'unknown'}-${jobId.substring(0, 8)}`;
        writeSharedResult(cpName, {
          taskType: data.taskType || 'unknown',
          jobId,
          workerId: entry.id,
          status: 'running',
          lastHeartbeat: Date.now(),
          partialResult: data,
        }).catch(() => {});
      }
      return; // ⚡ 不清理 pendingJobs — 任务仍在运行
    }

    if (!pending) {
      if (entry.currentJobId === null) {
        entry.busy = false;
        entry.idleSince = Date.now();
      }
      this._processQueue();
      return;
    }

    clearTimeout(pending.timeout);
    pendingJobs.delete(jobId);
    entry.busy = false;
    entry.idleSince = Date.now();
    entry.currentJobId = null;
    entry.crashCount = 0;

    // 清理探索型 checkpoint 定时器（任务完成）
    if (entry._exploratoryTimer) {
      clearInterval(entry._exploratoryTimer);
      entry._exploratoryTimer = null;
    }

    if (type === "result") {
      entry.completedTasks = (entry.completedTasks || 0) + 1;
      pending.resolve(data);
    }
    else if (type === "error") {
      let errMsg = error;
      try { const e = JSON.parse(error); errMsg = e.message || error; } catch {}
      pending.reject(new Error(errMsg || "Worker task failed"));
    } else {
      pending.reject(new Error(`Unknown worker message type: ${type}`));
    }
    this._processQueue();
  }

  _processQueue() {
    if (isShuttingDown) return;
    // BUG-FIX: 可重入时用setImmediateretry而非静默return，避免调度丢失
    if (this._reentering) {
      setImmediate(() => this._processQueue());
      return;
    }
    this._reentering = true;
    let _escapeCount = 0;
    try {
      for (;;) {
      // 逃生门:超过Worker数×2次迭代强制退出,防postMessage抛异常后busy永远无法恢复
      if (++_escapeCount > workers.length * 3 + 10) {
        console.warn('[sc] _processQueue 逃生门触发: 超过最大迭代次数');
        return;
      }

      // ====== 三级老化防饥饿: 低优先级任务排队超过 15 s自动提升一级 ======
      const _agingNow = Date.now();
      // low → normal
      for (let _ai = taskQueues.low.length - 1; _ai >= 0; _ai--) {
        const _item = taskQueues.low[_ai];
        if (_item._enqueuedAt && (_agingNow - _item._enqueuedAt) > AGING_THRESHOLD_MS) {
          taskQueues.low.splice(_ai, 1);
          taskQueues.normal.push(_item);
        }
      }
      // normal → high
      for (let _ai = taskQueues.normal.length - 1; _ai >= 0; _ai--) {
        const _item = taskQueues.normal[_ai];
        if (_item._enqueuedAt && (_agingNow - _item._enqueuedAt) > AGING_THRESHOLD_MS) {
          taskQueues.normal.splice(_ai, 1);
          taskQueues.high.push(_item);
        }
      }

      // 角色感知分发：先找可匹配的Worker
      let available = null;

      for (const level of ["high", "normal", "low"]) {
        if (taskQueues[level].length > 0) {
          const candidateTask = taskQueues[level][0];
          const taskType = candidateTask.task?.type || "";
          const targetRole = this._getTaskRole(taskType);
          const candidateWorker = this._findAvailableWorker(targetRole);
          if (candidateWorker) {
            available = candidateWorker;
            break;
          }
        }
      }

      if (!available) {
        // 没有空闲Worker -> 高优任务抢占评估
        this._triggerPreemption().catch(err => {
          console.warn('[sc] preempt检查失败: ' + err.message);
        });
        return;
      }

      let dispatched = false;
      try {
      for (const level of ["high", "normal", "low"]) {
        if (taskQueues[level].length > 0) {
          // 双重检查可用性
          if (!available.alive || available.terminating) continue;
          const next = taskQueues[level].shift();
          available.busy = true;
          this._runOnWorker(next.task, available).then(next.resolve).catch(next.reject);
          dispatched = true;
          break;
        }
      }
      } catch (dispatchErr) {
        console.warn('[sc] _processQueue 分发异常:', dispatchErr.message);
        if (available) { available.busy = false; }
        return;
      }
      if (!dispatched) return;
    }
    } finally {
      this._reentering = false;
    }
  }

  _runOnWorker(task, targetWorker) {
    return new Promise((resolve, reject) => {
      const we = targetWorker;
      if (!we || !we.alive || we.hbPending || we.terminating) {
        if (we) { we.busy = false; we.currentJobId = null; we.idleSince = Date.now(); }
        reject(new Error("[sc] 目标 Worker 不可用"));
        this._processQueue();
        return;
      }

      we.currentJobId = null;

      if (isShuttingDown) {
        we.busy = false;
        reject(new Error("[sc] 正在关闭"));
        return;
      }

      const jobId = crypto.randomUUID();
      we.currentJobId = jobId;
      we.currentJobStartTime = Date.now(); // 记录任务开始时间,供preempt评估使用
      we.idleSince = Date.now(); // 记录任务开始时间,供监控使用

      // 探索型任务自动写 partialResult checkpoint (每30s)
      if (we._exploratoryTimer) {
        clearInterval(we._exploratoryTimer);
        we._exploratoryTimer = null;
      }
      const taskType = task.type;
      if (TASK_CATEGORY_MAP[taskType] === TASK_CATEGORY.EXPLORATORY) {
        const jobIdPrefix = jobId.substring(0, 8);
        we._exploratoryTimer = setInterval(() => {
          // 🧠 可判定终止: 先向Worker请求实时进度,再写入shared/
          if (we.alive && !we.terminating && we.currentJobId === jobId) {
            try {
              we.worker.postMessage({ jobId, type: "requestPartialResult" });
            } catch {}
          }
          // 回退: 直接写入池端缓存的 partialResult (可能滞后一轮)
          writeSharedResult(`exploratory-${taskType}-${jobIdPrefix}`, {
            taskType,
            jobId,
            workerId: we.id,
            status: 'running',
            startedAt: we.idleSince,
            lastHeartbeat: Date.now(),
            partialResult: we.partialResult || null,
          }).catch((err) => {
            console.warn('[sc] ⚠️ 探索型partial结果write failed:', err?.message);
          });
        }, EXPLORATORY_CHECKPOINT_INTERVAL_MS);
      }
      // Phase 2: calcTimeout 使用 ν 轴（真实 _nu，含 ν_bias 校正）
      const _nu = getMetabolicRateConfig().nu;
      const _calcLevel = task.level || 'L3';
      const calculatedTimeout = calcTimeout(task.type, _calcLevel);
      // Phase 3: 超时计算日志（含 ν 和复杂度因子）
      const _timeoutLevelNum = parseInt((_calcLevel || 'L3').replace('L', ''), 10);
      const _timeoutComplexity = _timeoutLevelNum <= 1 ? 0.8
                               : _timeoutLevelNum <= 3 ? 1.0
                               : _timeoutLevelNum <= 5 ? 1.5
                               : 2.0;
      // 🧠 设计决策：timeout日志不用emoji。正常超时计算是DEBUG信息，不是warn。实际超时才打warn。
      // 正常超时计算是DEBUG信息，已降级不刷屏
      const timeout = setTimeout(() => {
        const rec = pendingJobs.get(jobId);
        if (!rec) return;
        pendingJobs.delete(jobId);
        console.warn(`[sc] Worker ${we.id} 任务超时 ${(calculatedTimeout/1000).toFixed(1)}s (ν=${_nu.toFixed(2)}, level=${_calcLevel}),强制终止`);
        // Phase 3: 记录超时到失败上下文（供 timeoutStats 和 联合损失使用）
        pushFailContext(task.type, 'TIMEOUT', { level: _calcLevel });
        we.terminating = true;
        we.currentJobId = null;
        we.worker.terminate().catch((err) => { console.warn('[sc] 异步错误:', err?.message); }).finally(() => { we.busy = false; });
        // 清理探索型 checkpoint 定时器
        if (we._exploratoryTimer) {
          clearInterval(we._exploratoryTimer);
          we._exploratoryTimer = null;
          // 超时时刻写一次 checkpoint 记录超时
          const taskType = task.type;
          writeSharedResult(`exploratory-${taskType}-${jobId.substring(0, 8)}`, {
            taskType,
            jobId,
            workerId: we.id,
            startedAt: we.idleSince,
            status: 'timeout',
            lastHeartbeat: Date.now(),
            partialResult: we.partialResult || null,
          }).catch(() => {});
        }
        // LEARN-5: 超时后尝试返回部分结果
        if (we.partialResult) {
          resolve({ status: 'partial', data: we.partialResult, warning: '任务超时,返回部分结果' });
        } else {
          rec.reject(new Error(`[sc] Worker ${we.id} 超时 ${(calculatedTimeout/1000).toFixed(1)}s (ν=${_nu.toFixed(2)}, level=${_calcLevel}) 被强杀`));
        }
      }, calculatedTimeout);

      pendingJobs.set(jobId, { resolve, reject, timeout, workerId: we.id });

      try {
        we.worker.postMessage({ ...task, jobId });
      } catch (e) {
        clearTimeout(timeout);
        pendingJobs.delete(jobId);
        we.busy = false;
        we.currentJobId = null;
        reject(e);
        this._processQueue();
      }
    });
  }

  // ====== 公开 API ======

  exec(task, priority = "normal") {
    if (isShuttingDown) return Promise.reject(new Error("[sc] 正在关闭"));

    const level = (priority === "high" || priority === "low") ? priority : "normal";
    const limits = { high: 50, normal: 80, low: 100 };

    if (taskQueues[level].length >= limits[level]) {
      return Promise.reject(new Error(`[sc] ${level} 队列已满`));
    }

    return new Promise((resolve, reject) => {
      taskQueues[level].push({ task, resolve, reject, _enqueuedAt: Date.now() });
      this._processQueue();
    });
  }

  getStats() {
    const alive = workers.filter(w => w.alive);
    const totalQueued = Object.values(taskQueues).reduce((a, b) => a + b.length, 0);
    const inFlight = [...pendingJobs.values()].filter(p => p.kind !== "heartbeat").length;
    // 角色细粒度stats
    const roleBreakdown = {};
    for (const w of alive) {
      const r = w.role || "unknown";
      if (!roleBreakdown[r]) roleBreakdown[r] = { total: 0, busy: 0 };
      roleBreakdown[r].total++;
      if (w.busy) roleBreakdown[r].busy++;
    }
    return {
      total: alive.length,
      busy: alive.filter(w => w.busy).length,
      inFlight,
      queueDepth: totalQueued,
      queueHigh: taskQueues.high.length,
      queueNormal: taskQueues.normal.length,
      queueLow: taskQueues.low.length,
      maxWorkers: getDynamicMaxWorkers(),
      minWorkers: MIN_WORKERS,
      physicalCores: PHYSICAL_CORES,
      roleBreakdown,
      preemptedCount: this._preemptedCount,
    };
  }

  async shutdown() {
    isShuttingDown = true;
    clearInterval(heartbeatTimer);
    clearInterval(scaleTimer);
    if (this._rollingRestartTimer) {
      clearInterval(this._rollingRestartTimer);
      this._rollingRestartTimer = null;
    }
    if (this._readyTimer) clearTimeout(this._readyTimer);

    for (const [jobId, p] of pendingJobs) { clearTimeout(p.timeout); p.reject(new Error("[sc] 正在关闭")); }
    pendingJobs.clear();
    for (const q of Object.values(taskQueues)) {
      for (const item of q) {
        item.reject(new Error("[sc] 正在关闭"));
      }
      q.length = 0;
    }

    // 老年Worker优先下线,再终止剩余Worker
    const sortedWorkers = [...workers].sort((a, b) => {
      const aAged = this._isWorkerAged(a) ? 1 : 0;
      const bAged = this._isWorkerAged(b) ? 1 : 0;
      if (aAged !== bAged) return bAged - aAged;
      return (a.completedTasks || 0) - (b.completedTasks || 0);
    });
    await Promise.allSettled(
      sortedWorkers.map(async w => { w.alive = false; try { await w.worker.terminate(); } catch {} })
    );
    workers.length = 0;
    // TODO: 移除调试日志 console.log("[sc] 已关闭");
  }

  /**
   * 🔧 v5.31.0: 公开重启方法，替代 cpuAbort 直接调私有API
   * @param {number} count - Worker数量
   */
  restart(count) {
    this._hbRunning = false;
    this._initPool(count);
    this._startHeartbeat();
    this._startScaleTimer();
  }

  async warmup() {
    if (isShuttingDown) return { warmed: false, newlyWarmed: 0, warmedCount: warmedModels.size, totalTargets: 0 };
    // TODO: 移除调试日志 console.log("[sc] 🔥 warmup...");
    const cache = globalThis.__oc_embedded_auth_cache__;
    const cfg = await safeReadJson(join(homedir(), ".openclaw", "openclaw.json"));
    const targets = [];
    if (cfg?.models?.providers) {
      for (const [provider, pcfg] of Object.entries(cfg.models.providers)) {
        for (const m of (pcfg.models || [])) {
          if (m.id && !m.id.startsWith("glm")) targets.push(`${provider}/${m.id}`);
        }
      }
    }
    // 如果没有配置任何模型，尝试从环境变量读取默认模型；没有也不硬编码默认值
    if (targets.length === 0) {
      const envDefault = getEnv('OPENCLAW_DEFAULT_MODEL', '');
      if (envDefault) {
        targets.push(envDefault);
      }
      // 无默认模型时不推硬编码值，由调用方处理缺失配置
    }
    const unique = [...new Set(targets)].slice(0, 20);
    let newlyWarmed = 0;
    for (const model of unique) {
      if (isModelWarmed(model)) continue;
      try {
        const [p, m] = model.split("/");
        const r = await this.exec({ type: "resolve-model", provider: p, modelId: m }, "high");
        if (cache && typeof cache.set === "function") cache.set(model, r);
        markModelWarmed(model);
        newlyWarmed++;
      } catch (err) { console.warn(`  ⚠️ ${model}: ${err.message}`); }
    }
    const allWarmed = unique.every(m => isModelWarmed(m));
    warmupDone = allWarmed;
    return { warmed: allWarmed, warmedCount: warmedModels.size, newlyWarmed, totalTargets: unique.length };
  }

  get ready() { return readyPromise; }
}

// ====== 单例 ======
const pool = new CpuWorkerPool();

// ====== 缓存包装函数(优化性能)======
function getCachedStats() {
  const now = Date.now();
  const ttl = getDynamicCacheTTL().stats;
  if (ttl === CACHE_DISABLED) { // 不缓存,实时读取
    cachedStats = pool.getStats();
    cachedStatsTime = now;
    return cachedStats;
  }
  if (cachedStats && (now - cachedStatsTime < ttl)) {
    return cachedStats;
  }
  cachedStats = pool.getStats();
  cachedStatsTime = now;
  return cachedStats;
}

function getCachedMemoryLevel() {
  const now = Date.now();
  const ttl = getDynamicCacheTTL().mem;
  if (ttl === CACHE_DISABLED) { // 不缓存,实时读取
    cachedMemLevel = getMemoryLevel();
    cachedMemTime = now;
    return cachedMemLevel;
  }
  if (cachedMemLevel && (now - cachedMemTime < ttl)) {
    return cachedMemLevel;
  }
  cachedMemLevel = getMemoryLevel();
  cachedMemTime = now;
  return cachedMemLevel;
}

/**
 * 🔍 compressTaskDescription - 子agent任务描述去冗余+checksum校验
 *
 * 压缩规则：
 * 1. 保留头部（🏃 模式、思考行）
 * 2. 提取核心指令（任务、步骤、输出路径、验收标准）
 * 3. 移除模板尾巴（⚡ 规则段落、熔断、compaction、安全约束等）
 * 4. 已压缩的单行规则（⚡ 规则：...）保留
 * 5. 末尾添加SHA256 checksum（前100字）
 *
 * @param {string} taskStr - 原始任务描述
 * @returns {{ compressed: string, originalLen: number, compressedLen: number, ratio: number, checksum: string }}
 */
function compressTaskDescription(taskStr) {
  if (!taskStr || typeof taskStr !== 'string') {
    return { compressed: taskStr || '', originalLen: 0, compressedLen: 0, ratio: 0, checksum: '' };
  }
  if (taskStr.length < 50) {
    // 太短无需压缩，加校验即可
    const shortChecksum = crypto.createHash('sha256').update(taskStr, 'utf-8').digest('hex').substring(0, 16);
    const annotated = taskStr + `\n\n[checksum:${shortChecksum}]`;
    return { compressed: annotated, originalLen: taskStr.length, compressedLen: annotated.length, ratio: -Math.round((annotated.length - taskStr.length) / taskStr.length * 100), checksum: shortChecksum };
  }

  const originalLen = taskStr.length;
  const lines = taskStr.split('\n');
  const kept = [];
  let skipMode = 0; // 0=normal, 1=in-rules-block, 2=in-example-block
  let hasHeader = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // ---- 模式1: 检测并保留头部 ----
    if (trimmed.startsWith('🏃') || trimmed.startsWith('🏃') ||
        trimmed.match(/^模式\s*[:：]/) || trimmed.match(/^思考\s*[:：]/)) {
      kept.push(line);
      hasHeader = true;
      continue;
    }

    // ---- 模式2: 检测规则段落入口 ----
    if (trimmed.startsWith('⚡') && (
        trimmed.includes('子 agent') ||
        trimmed.includes('运行规则') ||
        trimmed.includes('永久生效') ||
        trimmed.includes('不可省略') ||
        trimmed.match(/规则\s*\(/) ||
        trimmed.match(/模板.*运行规则/)
      )) {
      skipMode = 1;
      continue;
    }

    // ---- 模式3: 检测示例段落入口 ----
    if (trimmed.startsWith('成功示例：') ||
        trimmed.startsWith('超时示例：') ||
        trimmed.startsWith('失败示例：') ||
        trimmed.startsWith('死命令：') ||
        trimmed.startsWith('结果规范：') ||
        trimmed.includes('直接以') && trimmed.includes('{') && trimmed.includes('结尾')) {
      skipMode = 2;
      continue;
    }

    // ---- 跳过规则段落内容 ----
    if (skipMode === 1) {
      // 检测规则段落的结束标记
      if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('---') ||
          trimmed.startsWith('任务：') || trimmed.startsWith('步骤：') ||
          trimmed.startsWith('输出路径：') || trimmed.startsWith('验收标准：') ||
          trimmed.startsWith('结果') || trimmed.startsWith('---')) {
        // 空行可能是段落分割，但如果后面还是规则就继续
        if (trimmed === '' && i + 1 < lines.length) {
          const next = lines[i + 1].trim();
          if (next.match(/^\d+\./) || next.startsWith('三级') || next.startsWith('Tool') ||
              next.startsWith('安全') || next.startsWith('工具调用') || next.startsWith('禁止')) {
            continue;
          }
        }
        skipMode = 0;
        // 不输出空行，减少冗余
        if (trimmed && !trimmed.startsWith('⚡')) kept.push(line);
      }
      continue;
    }

    // ---- 跳过示例段落内容 ----
    if (skipMode === 2) {
      if (trimmed === '' || trimmed.match(/^(?:任务|步骤|输出|验收|结果|\{|```)/)) {
        skipMode = 0;
        if (trimmed) kept.push(line);
      }
      continue;
    }

    // ---- 模式4: 跳过已知的独立模板行 ----
    const skipLinePatterns = [
      /^⚡\s*子\s*agent\s*运行规则/i,
      /^⚡\s*规则(?!：)/i,
      /^⚡\s*子\s*agent\s*模板/i,
      /^⚡\s*安全约束/i,
      /^三级熔断/i,
      /^Tool Output Compaction/i,
      /安全约束.*永久生效/i,
      /工具调用合并/i,
      /^禁止.*browser/i,
      /^禁止.*message/i,
      /禁止使用browser/i,
      /禁止使用message/i,
      /exec.*工作区/i,
      /使?用前.*(?:调|core_routeTask)/i,
      /末尾.*MEMORY\.md/i,
      /结构化返回/i,
      /死命令：/i,
      /成功示例：/i,
      /超时示例：/i,
      /失败示例：/i,
      /非.*JSON.*崩溃/i,
      /\[\+\d+ more characters/i,
      /rerun with narrower/i,
    ];
    let isSkip = false;
    for (const pat of skipLinePatterns) {
      if (pat.test(trimmed)) { isSkip = true; break; }
    }
    if (isSkip) continue;

    // ---- 模式5: 跳过规则编号行 ----
    if (trimmed.match(/^\d+\.\s*(?:三级熔断|Tool Output|安全约束|禁止browser|禁止message|禁止使用|工具调用|结构化|返回接口|建议|MEMORY\.md)/i)) {
      continue;
    }

    // ---- 模式6: 检测已压缩的规则单行，直接保留 ----
    if (trimmed.startsWith('⚡ 规则：') || trimmed.match(/^⚡\s*规则：/)) {
      kept.push(line);
      continue;
    }

    // ---- 核心内容：保留 ----
    kept.push(line);
  }

  // 合并连续的空行为最多一个
  let compressed = kept.join('\n');
  compressed = compressed.replace(/\n{3,}/g, '\n\n').trim();

  const compressedLen = compressed.length;
  const ratio = originalLen > 0 ? Math.round((1 - compressedLen / originalLen) * 100) : 0;

  // 生成checksum: 对整个compressed做SHA256
  const checksumSource = compressed;
  const checksum = crypto.createHash('sha256').update(checksumSource, 'utf-8').digest('hex').substring(0, 16);

  compressed += '\n\n[checksum:' + checksum + ']';

  return { compressed, originalLen, compressedLen, ratio, checksum };
}

let mcpServerHandle = null;

// ====== OpenClaw 插件生命周期钩子 ======
function register(ctx) {
  ctx.logger.info("sc v5.38.0 registered (dual-mode + 缓存 + 动态batchSize + dynamic cores)");



  // 初始化triple-evidenceroute audit路由证据系统

  // ⛔ route-audit 已物理删除 (2026-06-13)
  initRouteEvidence().then((ok) => {
    if (ok) ctx.logger.info('[sc] 🏛️ triple-evidence routing system ready');
  }).catch(err => {
    ctx.logger.warn(`[sc] ⚠️ triple-evidenceinit failed: ${err.message}`);
  });

  // 🧠 USearch HNSW — bridge.js 按需加载，内存映射索引
  // 见 vector/usearch-bridge.js — 首次搜索冷加载模型，之后 ~7ms
  // ====== 🧬 evolution engine + 🛡️ 快速路径缓存 注册 ======

  

  // 🧬 进化参数注入辅助函数：在所有路由结果中添加进化策略参数



  // ====== 多核并行决策引擎工具 ======

  

  // ====== triple-evidenceroute audit路由证据查询工具 ======

  // ====== 🧠 负载模式预测状态查询 ======
  

  // ====== 🔗 任务链检测与执行 ======
  

  // ====== triple-evidenceroute audit路由证据查询工具 ======

  

  // ====== 原有工具 ======

  

  

  

  

  

  

  // ====== 🧠 子 agent 模型分配器 ======
  

  

  

  // ====== ? Checkpoint 恢复 ======
  

  

  

  

  

  

  

  

  

  

  

  

  

  // ====== 🧠 语义搜索（基于 embedding 模型，从 openclaw.json 读取配置）======
  

  // ====== 🏃 快速执行器 - 零LLM机械操作(L0级) ======
  





  // ====== cpu_apiQueue — API请求队列 ======
  

  // ====== 🦞 Task Center 工具注册 ======
  

  

  

    // ====== 失败原因分类器 + circuit breaker log ======
  // 工具自身问题（不retry，直接换路）vs 瞬时问题（允许retry）
  const TOOL_OWN_ISSUE_PATTERNS = [
    // HTTP 状态码
    /40[134]/i,          // 400/401/403/404
    /50[0-9]/i,          // 500-509
    // 工具缺失/无效
    /not found/i,
    /does not exist/i,
    /is not a function/i,
    /invalid/i,
    /unknown/i,
    /unexpected/i,
    /missing/i,
    /required/i,
    // 能力不足
    /insufficient/i,
    /not supported/i,
    /unavailable/i,
    /cannot/i,
    /refused to/i,
    /denied/i,
    /拒绝/i,
    /不支持/i,
    /不存在/i,
    /无效/i,
    // 超时（工具自身）
    /timed?out/i,
    /timeout/i,
    /超时/i,
    // 语法/解析错误
    /syntax/i,
    /parse/i,
    /malformed/i,
  ];

  const TRANSIENT_ISSUE_PATTERNS = [
    // 网络抖动
    /ECONNRESET/i,
    /ETIMED?OUT/i,
    /ECONNREFUSED/i,
    /ENOTFOUND/i,
    /EAI_AGAIN/i,
    /EPIPE/i,
    /socket/i,
    /network/i,
    /网络/i,
    /连接/i,
    // 文件锁
    /EBUSY/i,
    /EACCES/i,
    // 临时限流
    /429/i,
    /ratelimit/i,
    /rate.?limit/i,
    /too many/i,
    /throttl/i,
    // 临时不可用
    /retry again/i,
    /try again/i,
    /temporarily/i,
    /暂时/i,
    /稍后/i,
    /busy/i,
  ];

  function classifyFailure(error) {
    const msg = (error?.message || error?.toString() || '').toString();

    // 优先检查瞬时模式
    for (const p of TRANSIENT_ISSUE_PATTERNS) {
      if (p.test(msg)) return { type: 'transient', reason: msg.substring(0, 120) };
    }

    // 再检查工具自身问题
    for (const p of TOOL_OWN_ISSUE_PATTERNS) {
      if (p.test(msg)) return { type: 'tool_own', reason: msg.substring(0, 120) };
    }

    // 默认:未知问题算瞬时,允许retry
    return { type: 'transient', reason: msg.substring(0, 120), classification: 'default_transient' };
  }

  async function writeCircuitBreakerLog(entry) {
    try {
      const { readFile, writeFile } = await import('fs/promises');
      const { join: jn } = await import('path');
      const logPath = jn(SHARED_DIR, 'circuit-breaker-log.json');

      let log = [];
      try {
        const raw = await readFile(logPath, 'utf-8');
        log = JSON.parse(raw);
      } catch {}

      if (!Array.isArray(log)) log = [];

      entry.timestamp = new Date().toISOString();
      log.push(entry);

      // 保留最近 100 
      if (log.length > 100) log = log.slice(-100);

      await writeFile(logPath, JSON.stringify(log, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[sc] ⚠️ circuit breaker logwrite failed:', err.message);
    }
  }

  // ?? MCP Server — 立即启动
  // 不用 setImmediate：OpenClaw 的 bundle-mcp 在当前事件循环就查端口18790，
  // setImmediate 推送到下轮事件循环会导致 bundle-mcp 先拿到 ECONNREFUSED。
  // 防二次 register()（OpenClaw 可能在加载工具策略后再次注册插件）
  if (mcpServerHandle) { return; }
  import('./tools/bridge.js').then(bridge => {
    bridge.setCpuInstance({
      pool,
      getStats: () => getCachedStats(),
      getMemoryLevel,
    });
    bridge.startMcpServer(MCP_PORT).then(h => {
      mcpServerHandle = h;
      ctx.logger.info("sc MCP Server started (http://127.0.0.1:" + h.port + "/sse)");
    }).catch(e => {
      if (e?.code === 'EADDRINUSE') {
        ctx.logger.info("sc MCP Server 端口已被占用（旧实例在服务），跳过启动");
      } else {
        ctx.logger.warn("sc MCP Server start skipped: " + e.message);
      }
    });
  }).catch(e => {
    ctx.logger.warn("sc MCP Server 不可用: " + e.message);
  });
}

async function activate(ctx) {
  ctx.logger.info("sc v5.38.0 Worker 池已激活 (" + getCachedStats().total + "/" + getCachedStats().maxWorkers + ")");
  pool.warmup().catch(e => ctx.logger.error("sc warmup失败: " + e.message));

  // 🗄️ memory/shared/ 目录初始化
  ensureSharedDir().catch((err) => { console.warn('[sc] 异步错误:', err?.message); });
  ctx.logger.info("✅ memory/shared/ 目录ready");

  // 🦞 初始化独立日志系统 + hippocampus集成
  initLogger().then(logger => {
    global.__sansanLogger = logger;
    ctx.logger.info('📋 日志系统已初始化 (logs/, 轮转5MB×5, hippocampus15min)');
  }).catch(err => {
    ctx.logger.warn(`[sc] ⚠️ 日志系统init failed: ${err.message}`);
  });



  // 🛡️ 高频任务快速路径初始化
  tcell.init().then(() => {
    ctx.logger.info('🛡️ fast-path cachestarted');
    const tcellStats = tcell.getStats();
    ctx.logger.info(`🛡️ fast-path cache: ${tcellStats.totalEntries} 缓存, 命中率 ${tcellStats.hitRate}`);
  }).catch(err => {
    ctx.logger.warn(`🛡️ fast-path cacheinit failed: ${err.message}`);
  });

  // 🧹 每小时清理 >1小时未读的共享文件
  cleanupSharedDir(3600000).catch((err) => { console.warn('[sc] 异步错误:', err?.message); });
  // 🧹 启动时清理过期 checkpoint
  cleanupCheckpoints().catch((err) => { console.warn('[sc] 异步错误:', err?.message); });
  const cleanupTimer = setInterval(() => {
    cleanupSharedDir(3600000).catch((err) => { console.warn('[sc] 异步错误:', err?.message); });
    cleanupCheckpoints().catch((err) => { console.warn('[sc] 异步错误:', err?.message); });
    cleanupChainLogs().catch((err) => { console.warn('[chain scheduler] 异步错误:', err?.message); });
  }, 3600000);
  global.__sansanCpuCleanupTimer = cleanupTimer;

  // 🔗 任务链日志清理（集成到 cleanupTimer）
  // 第一小时内先执行一次
  cleanupChainLogs().catch(err => {
    console.warn('[chain scheduler] ⚠️ 初始链日志清理失败:', err.message);
  });

  // 🔬 启动慢通道聚合(每5min检测失败趋势)
  slowChannelState.timer = setInterval(() => {
    slowChannelAggregate();
  }, 5 * 60 * 1000);
  ctx.logger.info("🔬 慢通道聚合started (间隔5min)");

  // 🧬 启动资源调度自动调节(每15s)
  startMetabolicAutoRegulation();
  ctx.logger.info(`🧬 metabolic rate系统started (初始=${_metabolicRate.toFixed(2)}, 自动调节每15s)`);

  // 🤵 初始化steward rules engine (2026-06-21: 同步，不读外部文件)
  StewardGuard.init();



  // 🔗 每小时清理任务链日志
  // 已集成到 cleanupTimer 中

  // 🧰 加载custom tools（从 tools/custom/ 扫描注册）
  import('./lib/tool-registry.js').then(({ loadCustomTools }) => {
    loadCustomTools(ctx).catch(err => {
      ctx.logger.warn(`[tool-registry] ⚠️ custom tools加载失败: ${err.message}`);
    });
  }).catch(err => {
    ctx.logger.warn(`[tool-registry] ⚠️ 加载 tool-registry 模块失败: ${err.message}`);
  });

  // 🛡️ 注册enrichment layer(cpu_enrichSubagentTask) — 子agent任务话术enrichment layer
  try {
    await registerEnrichSubagent(ctx, { pool });
    ctx.logger.info('🛡️ cpu_enrichSubagentTask enrichment layerregistered');
  } catch (err) {
    ctx.logger.warn(`[sc] ⚠️ enrichment layercpu_enrichSubagentTask注册失败: ${err.message}`);
  }

  // 🔍 注册tool auto-discover(core_toolDiscover) — 自动捕获新工具并加入推荐
  try {
    await registerToolDiscover(ctx, {});
    ctx.logger.info('🔍 core_toolDiscover tool auto-discoverregistered');
  } catch (err) {
    ctx.logger.warn(`[sc] ⚠️ tool auto-discovercore_toolDiscover注册失败: ${err.message}`);
  }

  // 📊 dashboard自动启动：启动后1min弹窗，延迟启动防挤占启动资源
  // 🧠 设计决策：不跟Gateway同时启动，等Worker池和MCP稳定后再弹。
  // shutdown时同步杀掉dashboard进程（见 shutdown() 函数）。
  // dashboard自动启动，失败后每30sretry，最多5次（防MCP热重载导致启动失败）
  // ★ 自动探测 Python 安装路径：先遍历 Python 目录取最高版本，再兜底 PATH
  const findPythonExe = () => {
    const pythonDir = join(homedir(), 'AppData', 'Local', 'Programs', 'Python');
    try {
      const entries = readdirSync(pythonDir);
      // 匹配 PythonXXX 格式的版本目录，按版本号降序排列
      const pyDirs = entries
        .filter(e => /^Python\d+$/.test(e))
        .sort((a, b) => parseInt(b.replace('Python', ''), 10) - parseInt(a.replace('Python', ''), 10));
      for (const dir of pyDirs) {
        const exe = join(pythonDir, dir, 'pythonw.exe');
        if (existsSync(exe)) {
          ctx.logger.info(`[sc] 📊 自动探测到 Python: ${exe}`);
          return exe;
        }
      }
    } catch {}
    // 兜底：PATH 中找 pythonw
    try {
      spawnSync('pythonw', ['--version'], { timeout: 3000, stdio: 'pipe' });
      ctx.logger.info('[sc] 📊 使用 PATH 中的 pythonw');
      return 'pythonw';
    } catch {}
    ctx.logger.warn('[sc] ⚠️ 未找到 pythonw 可执行文件，请安装 Python');
    return null;
  };

  /**
   * 启动dashboard（内部函数，可被自动计时器或手动触发调用）
   * 捕获 stderr 代替静默 stdio:ignore，启动5s后验证进程存活
   */
  const launchDashboard = (attempt = 1, maxAttempts = 5) => {
    const pyw = findPythonExe();
    if (!pyw) {
      ctx.logger.error(`[sc] 📊 dashboard启动失败: 未找到 Python 环境`);
      return;
    }
    const script = join(__dirname, 'tools', 'dashboard', 'tk-dashboard.py');
    try {
      // stdio: pipe 捕获 stderr — 不再静默吞掉错误
      const proc = spawn(pyw, [script], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
      dashboardPid = proc.pid;

      // 捕获 stderr — Python 运行时错误不再被吞掉
      let stderrBuf = '';
      proc.stderr.on('data', (d) => { stderrBuf += d.toString(); });
      proc.stderr.on('end', () => {
        if (stderrBuf.trim()) {
          ctx.logger.warn(`[sc] 📊 dashboard stderr (PID=${proc.pid}): ${stderrBuf.trim().slice(0, 500)}`);
        }
      });

      // 捕获进程级错误（如 ENOENT — spawn 不可达）
      let recovered = false;
      proc.on('error', (err) => {
        ctx.logger.warn(`[sc] 📊 dashboard进程错误 (第${attempt}次): ${err.message}`);
        dashboardPid = null;
        if (!recovered && attempt < maxAttempts) {
          recovered = true;
          setTimeout(() => launchDashboard(attempt + 1, maxAttempts), 30 * 1000);
        }
      });

      // 进程退出时清理 pid，异常退出则自动重启
      proc.on('exit', (code) => {
        ctx.logger.info(`[sc] 📊 dashboard进程已退出 (PID=${proc.pid}, code=${code})`);
        if (dashboardPid === proc.pid) dashboardPid = null;
        if (!recovered && code !== 0 && attempt < maxAttempts) {
          recovered = true;
          ctx.logger.info(`[sc] 📊 dashboard异常退出，30s后自动重启 (尝试 ${attempt+1}/${maxAttempts})`);
          setTimeout(() => launchDashboard(attempt + 1, maxAttempts), 30 * 1000);
        }
      });

      ctx.logger.info(`[sc] 📊 dashboardstarted (PID=${proc.pid})`);
      proc.unref();

      // 启动后 5 s验证进程是否存活（只当 exit/error 未触发retry时）
      setTimeout(() => {
        if (recovered || dashboardPid !== proc.pid) return;
        try {
          const check = spawnSync('tasklist', ['/FI', `PID eq ${proc.pid}`, '/NH'], { timeout: 3000, stdio: 'pipe', encoding: 'utf-8' });
          if (!check.stdout.includes(String(proc.pid))) {
            ctx.logger.warn(`[sc] 📊 dashboard进程 (PID=${proc.pid}) 似乎已消失，标记为retry`);
            if (dashboardPid === proc.pid) dashboardPid = null;
            if (!recovered && attempt < maxAttempts) {
              recovered = true;
              setTimeout(() => launchDashboard(attempt + 1, maxAttempts), 30 * 1000);
            }
          } else {
            ctx.logger.info(`[sc] ✅ dashboard进程存活确认 (PID=${proc.pid})`);
          }
        } catch (e) { /* tasklist check non-critical */ }
      }, 5000);

    } catch (err) {
      ctx.logger.warn(`[sc] 📊 dashboard启动失败 (第${attempt}次): ${err.message}`);
      if (attempt < maxAttempts) {
        setTimeout(() => launchDashboard(attempt + 1, maxAttempts), 30 * 1000);
      } else {
        ctx.logger.error(`[sc] 📊 dashboard启动失败，已retry${maxAttempts}次，放弃。`);
      }
    }
  };
  // 自动启动：Gateway启动1min后
  setTimeout(() => launchDashboard(), 60 * 1000);

  /**
   * 公开启动dashboard函数供外部手动触发（杉哥说"开dashboard"时调用）
   * 通过 globalThis 暴露给custom tools使用
   */


   () => launchDashboard(1, 3);
  globalThis.__sansanCpu_dashboard = {
    launch: () => launchDashboard(1, 3),
    get pid() { return dashboardPid; },
  };
  // 同步 dashboardPid 到可读的 global getter
  Object.defineProperty(globalThis, '__sansanCpu_dashboard_pid', {
    get: () => dashboardPid,
    configurable: true,
    enumerable: true,
  });

  // ? 自动启动子agent后台监控（防止子agent卡死不退出），启动后2min开启
  setTimeout(() => {
    startMonitorBackground();
    ctx.logger.info('? 子agent后台监控已自动启动 (interval=90s, 阈值=120s, 💀卡死强杀+⏰超时告警)');
  }, 2 * 60 * 1000);
}

export default {
  register,
  activate,
  pool,
  exec: (task, priority) => pool.exec(task, priority),
  warmup: () => pool.warmup(),
  ready: pool.ready,
  getStats: () => getCachedStats(),
  getMemoryLevel,
  cleanupSharedDir,
  cleanupOldSessions,
  ensureSharedDir,
  writeSharedResult,
  readSharedResult,
  snapshotSubagents,
  killSubagent,
  cpuAbort,
  getMonitorState,
  compressTaskDescription,
  tcell,
  getMetabolicRate,
  setMetabolicRate,
  getMetabolicRateConfig,
  startMetabolicAutoRegulation,
  stopMetabolicAutoRegulation,
  shutdown: () => {
    // 停止资源调度自动调节
    stopMetabolicAutoRegulation();
    // 清理共享文件定时器
    const timer = global.__sansanCpuCleanupTimer;
    if (timer) { clearInterval(timer); global.__sansanCpuCleanupTimer = null; }

    // 停止子agent监控
    if (monitorState.timer) {
      clearInterval(monitorState.timer);
      monitorState.timer = null;
      monitorState.active = false;
    }
    monitorState.stalledHistory.clear();

    // 清理C纤维慢通道定时器
    if (slowChannelState.timer) {
      clearInterval(slowChannelState.timer);
      slowChannelState.timer = null;
    }

    // 停止工具自动内化自动self-check


    // 杀掉dashboard进程（同步关闭，避免重启后残留旧窗口）
    if (dashboardPid) {
      try {
        spawnSync('taskkill', ['/PID', String(dashboardPid), '/F'], { stdio: 'ignore', timeout: 3000 });
        dashboardPid = null;
      } catch (e) { console.error("[sc] shutdown 杀dashboard进程失败:", e.message); /* 进程可能已经自己退出了 */ }
    }

    if (mcpServerHandle) {
      try { mcpServerHandle.shutdown(); } catch {}
      mcpServerHandle = null;
    }

    // 清理残留子进程：关闭sc后如果还有node子进程残留，强制杀掉
    try {
      const childPids = execSync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe' AND CommandLine LIKE '%sc%' AND CommandLine NOT LIKE '%sidecar-server%' AND ProcessId != ${process.pid}\" | Select-Object -ExpandProperty ProcessId"`,
        { timeout: 5000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      if (childPids?.trim()) {
        const pids = childPids.trim().split('\n').filter(Boolean);
        for (const pid of pids) {
          try { spawnSync('taskkill', ['/f', '/pid', pid.trim()], { timeout: 3000 }); } catch (err) { console.error("[sc] shutdown taskkill子进程失败:", err.message); }
        }
      }
    } catch (err) { console.error("[sc] shutdown 查残留子进程失败:", err.message); }

    // 🧠 停止日志系统 + hippocampus最终刷入
    try {
      const logger = global.__sansanLogger;
      if (logger) {
        stopHippocampusFlush();
      }
    } catch (err) {
      console.error('[sc] shutdown 日志停止异常:', err.message);
    }

    return pool.shutdown();
  },
  mcpPort: MCP_PORT,
};

// ====== 直接运行时（非OpenClaw插件模式）自动启动MCP Server ======
const isDirectRun = typeof process !== 'undefined' && process.argv[1] &&
  (process.argv[1].replace(/\\/g, '/').endsWith('index.js') ||
   process.argv[1].replace(/\\/g, '/').endsWith('sc/index.js'));
if (isDirectRun) {
  // TODO: 移除调试日志 console.log('[sc] 直接运行模式，自动启动 MCP Server...');
  import('./tools/bridge.js').then(bridge => {
    bridge.setCpuInstance({
      pool,
      getStats: () => ({}),
      getMemoryLevel: () => 'normal',
    });
    bridge.startMcpServer(MCP_PORT).then(h => {
      mcpServerHandle = h;
      // TODO: 移除调试日志 console.log('[sc] MCP Server started (http://127.0.0.1:' + h.port + '/sse)');
    }).catch(e => {
      if (e?.code === 'EADDRINUSE') {
        // TODO: 移除调试日志 console.log('[sc] MCP Server 端口已被占用（旧实例在服务），跳过启动');
      } else {
        console.warn('[sc] MCP Server start skipped:', e.message);
      }
    });
  }).catch(e => {
    console.warn('[sc] MCP Server unavailable:', e.message);
  });
}
