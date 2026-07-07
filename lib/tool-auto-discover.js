/**
 * 🔍 新tool auto-discover — 自动捕获外部的(非cpu_) OpenClaw 新安装工具并加入推荐
 *
 * 🎯 设计意图：
 *   管理员装了新插件/新工具后，sc 不知道自己不认识它，子 agent
 *   可能调了这个工具却得不到路由推荐。
 *   本模块通过 after_tool_call hook 默默监视外部工具调用，
 *   当某个外部工具被调 ≥3 次且成功率 >60% 时，自动将其加入 CORE_TOOLS 白名单，
 *   标注为"新工具待验证"并赋予初始 confidence=0.5。
 *
 * 🧠 为什么用 after_tool_call 而不是 before_tool_call：
 *   before_tool_call 拦截发生在路由之前，外部工具根本不会走到那里，
 *   只有 OpenClaw 原生已知的工具才有 before 事件。但 after_tool_call
 *   是在 OpenClaw 原生执行完成后触发的全局钩子，不管工具是不是sc
 *   认识的，都会触发这个事件。所以能捕获到所有外部工具调用。
 *
 * 🧠 为什么不用开机全量扫描：
 *   OpenClaw 工具系统没有"枚举所有已注册工具"的 API。ctx.registerTool()
 *   只能注册新工具，没有 listAllTools() 或类似反射 API。全量扫描要
 *   翻 node_modules 目录枚举 .js 文件然后猜是不是工具——太重、太脆弱。
 *   监听运行时真实调用才是正确路径。
 *
 * v1.0 — 2026-06-01
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { CORE_TOOLS, TASK_TIMEOUT_MAP } from './constants.js';
import { registerToolTier } from './steward-rules.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ====== persist路径 ======
// 🧠 设计决策：数据放在 memory/shared/tool-discover/ 而不是 lib/ 下。
// persist数据应该和运行时代码分离，这样升级插件时旧数据不丢失。
const DATA_DIR = join(homedir(), '.openclaw', 'workspace', 'memory', 'shared', 'tool-discover');
const DATA_FILE = join(DATA_DIR, 'discovered-tools.json');

// ====== 常量 ======
// 🧠 设计决策：PROMOTE_THRESHOLD=3（≥3次调用且成功率>60%才加入白名单）。
// 1次可能是偶然，2次也可能是试水，3次才说明稳定使用。成功率>60%防屎山工具吃资源。
const PROMOTE_THRESHOLD = 3;          // 调用≥3次才考虑注册
const MIN_SUCCESS_RATE = 0.6;         // 成功率>60%才推荐
// 🧠 设计决策：CONFIDENCE_INIT=0.5（初始置信度0.5，中等）。
// 不留0.0（永不推荐），不留1.0（过度自信）。0.5="新工具待验证"，要靠后续反馈修正。
const CONFIDENCE_INIT = 0.5;          // 首次推荐置信度
const CONFIDENCE_DECAY = 0.1;         // 每次失败-0.1
const CONFIDENCE_BOOST = 0.05;        // 每次成功+0.05
// 🧠 设计决策：CHECK_INTERVAL_MS=60000（60s检查一次够快了）。
// 工具调用是s级频率，没必要每次hook触发都扫描全量。1min扫描一次足够的。
const CHECK_INTERVAL_MS = 60000;      // 定时注册检查间隔
// 🧠 设计决策：PERSIST_DELAY_MS=5000（节流5s不写盘）。
// 多次工具调用密集触发时，每次写盘太费I/O。5s窗口内合并为一次写盘。
const PERSIST_DELAY_MS = 5000;        // persist节流窗口

// ====== 运行时状态 ======
// 🧠 设计决策：trackedTools 是 Map 而非对象。Map 遍历顺序确定，keys() 可以提前筛出
// 符合晋升件的候选，比 for...in 快且干净。
const trackedTools = new Map();
// trackedTools 每的结构：
//   toolName → {
//     callCount: number,         // 总调用次数
//     successCount: number,      // 成功次数
//     failCount: number,         // 失败次数
//     firstSeen: number,         // 首次发现时间戳
//     lastSeen: number,          // 最近一次调用时间戳
//     promoted: boolean,         // 是否已注册
//     promotedAt: number|null,   // 注册时间戳
//     confidence: number,        // 推荐置信度 0.0-1.0
//   }

let _ctx = null;              // 插件上下文引用
let timerId = null;           // 定时检查句柄
let _persistTimer = null;     // persist节流句柄
let _needsPersist = false;    // 是否有待写入的数据
let _initialized = false;     // 是否已加载persist数据
let _discoveryCount = 0;      // 累计发现新工具数（用于日志）
let _lastPromotedTool = '';   // 最近一次注册的工具名（用于去重日志）
let _persistLock = Promise.resolve();       // 🔧 Bug1: 串行化写盘 Promise 链，防并发覆盖
const discoveredTools = new Set(CORE_TOOLS); // 🔧 Bug3: 独立 Set，不污染 CORE_TOOLS 常量数组

// ====== 目录/文件初始化 ======

async function ensureDataDir() {
  try {
    await mkdir(DATA_DIR, { recursive: true });
  } catch {}
}

async function loadPersistedData() {
  try {
    const raw = await readFile(DATA_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      for (const entry of data) {
        if (entry.toolName) {
          trackedTools.set(entry.toolName, {
            callCount: entry.callCount || 0,
            successCount: entry.successCount || 0,
            failCount: entry.failCount || 0,
            firstSeen: entry.firstSeen || 0,
            lastSeen: entry.lastSeen || 0,
            promoted: entry.promoted || false,
            promotedAt: entry.promotedAt || null,
            confidence: entry.confidence ?? CONFIDENCE_INIT,
          });
        }
      }
      // TODO: 移除调试日志 console.log(`[tool auto-discover] 📂 已加载 ${trackedTools.size} 个已追踪工具`);
    }
  } catch {
    // 文件不存在或格式错误 — 从头开始，正常情况
  }
}

/**
 * 节流写盘：工具调用频繁触发时，合并为每5s写一次
 * 🔧 Bug1: 使用 _persistLock Promise 链串行化，防并发覆盖
 */
function schedulePersist() {
  _needsPersist = true;
  if (_persistTimer) return; // 已有定时器在等

  _persistTimer = setTimeout(async () => {
    _persistTimer = null;
    if (!_needsPersist) return;
    _needsPersist = false;
    // 🔧 Bug1: 通过 Promise 链串行化写盘
    await _persist();
  }, PERSIST_DELAY_MS);
}

/**
 * 🔧 Bug1: 通过 Promise 链串行化的实际写盘函数
 * 确保 schedulePersist 的定时回调和 shutdown 不会并发写同一文件
 */
async function _persist() {
  const prevLock = _persistLock;
  _persistLock = prevLock.then(() => _doWritePersist());
  return _persistLock;  // 🔧 BUGFIX: 返回新链而非旧Promise，确保 await 等待实际写盘完成
}

/**
 * 🔧 Bug1: 实际的写盘 I/O（从 _persist 中分离出来，供 Promise 链调用）
 */
async function _doWritePersist() {
  try {
    await ensureDataDir();
    const data = [];
    for (const [toolName, info] of trackedTools) {
      if (info.callCount > 0) {
        data.push({ toolName, ...info });
      }
    }
    await writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.warn(`[tool auto-discover] ⚠️ persist失败: ${err.message}`);
  }
}

// ====== 核心逻辑 ======

/**
 * 记录一次外部工具调用（由 after_tool_call hook 触发）
 *
 * 🧠 只追踪非 cpu_ 的工具。cpu_ 工具已经是sc自家工具了，
 * 不需要自己推荐自己。但注意：这个函数对 cpu_ 工具直接返回，
 * 所以必须在 after_tool_call 里先判断再调用，避免 CPU 工具被误记录。
 *
 * @param {string} toolName - 被调用的工具名
 * @param {boolean} success - 本次调用是否成功
 * @param {number} durationMs - 调用耗时(ms)
 */
export function recordExternalToolCall(toolName, success, durationMs) {
  if (!toolName || toolName.startsWith('cpu_')) return;

  // 首次发现：创建记录
  let info = trackedTools.get(toolName);
  if (!info) {
    info = {
      callCount: 0,
      successCount: 0,
      failCount: 0,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      promoted: false,
      promotedAt: null,
      confidence: CONFIDENCE_INIT,
    };
    trackedTools.set(toolName, info);
    // TODO: 移除调试日志 console.log(`[tool auto-discover] 👀 新外部工具发现: ${toolName}`);
  }

  // 更新调用stats
  info.callCount++;
  info.lastSeen = Date.now();

  if (success) {
    info.successCount++;
    // 🧠 设计决策：成功+0.05 置信度，上限1.0。
    // 加法累积不会跳跃，连续成功更多次才上得去，比较平滑。
    info.confidence = Math.min(1.0, info.confidence + CONFIDENCE_BOOST);
  } else {
    info.failCount++;
    // 🧠 设计决策：失败-0.1 置信度，下限0.0（直接排除推荐）。
    // 失败惩罚是成功奖励的2倍——失败比成功更值得注意。
    info.confidence = Math.max(0.0, info.confidence - CONFIDENCE_DECAY);
  }

  // 自动注册检查（仅当未注册时）
  if (!info.promoted && info.callCount >= PROMOTE_THRESHOLD) {
    const successRate = info.callCount > 0
      ? info.successCount / info.callCount
      : 0;
    if (successRate >= MIN_SUCCESS_RATE) {
      registerDiscoveredTool(toolName, info);
    }
  }

  schedulePersist();
}

/**
 * 注册新发现的工具 — 给新工具配超时和管家规则，不涉及路由守卫的白名单
 *
 * 这个函数只负责给新工具配超时和管家规则。
 * 白名单在 constants.js 的 CORE_TOOLS 数组里，由开发者手动维护。
 *
 * 🧠 做了什么：
 *   1. discoveredTools Set 追加名字（仅模块内跟踪，不参与路由守卫）
 *   2. TASK_TIMEOUT_MAP 加默认超时 → 超时监控
 *   3. Steward 管家规则注册 → 安全等级 safe
 *   4. 标记 promoted → 不再重复检查注册
 *   5. 置信度初始0.5保持不变 → 后续靠反馈调
 *
 * @param {string} toolName - 被发现的工具名
 * @param {object} info - 该工具的运行时状态对象（会被直接修改）
 */
function registerDiscoveredTool(toolName, info) {
  // 重复保护
  if (info.promoted) return;

  // 1. 追加到白名单（使用独立 Set，不污染 CORE_TOOLS 常量数组）
  // 🔧 Bug3: 改为 discoveredTools.add()，不污染共享常量
  if (!discoveredTools.has(toolName)) {
    discoveredTools.add(toolName);
  }

  // 2. 添加超时配置（使用默认值，站长可以之后手动调优）
  if (!TASK_TIMEOUT_MAP[toolName]) {
    try {
      TASK_TIMEOUT_MAP[toolName] = { warn: 60, kill: 120, label: '自动发现工具' };
    } catch {}
  }

  // 3. 注册管家规则（safe 等级，放行）
  try {
    registerToolTier(toolName, 'safe');
  } catch (err) {
    // 管家规则注册失败不阻断升白
    console.warn(`[tool auto-discover] ⚠️ 管家规则注册失败 (${toolName}): ${err.message}`);
  }

  // 4. 标记已晋升
  info.promoted = true;
  info.promotedAt = Date.now();
  _discoveryCount++;

  // 去重日志：同一个工具不刷屏
  if (_lastPromotedTool !== toolName) {
    _lastPromotedTool = toolName;
    const successRate = (info.successCount / info.callCount * 100).toFixed(1);
    // TODO: 移除调试日志
    // console.log(
    //   `[tool auto-discover] ⭐ 新工具自动升白: ${toolName}` +
    //   ` (调用${info.callCount}次, 成功率${successRate}%, 置信度${info.confidence.toFixed(2)})`
    // );
  }
}

/**
 * 定时检查所有已追踪但未晋升的工具，看是否有满足件的
 * （兜底检查，不依赖每次 recordExternalToolCall 触发）
 */
function periodicCheck() {
  if (!_initialized) return;

  let promoted = 0;
  for (const [toolName, info] of trackedTools) {
    if (info.promoted) continue;
    if (info.callCount < PROMOTE_THRESHOLD) continue;

    const successRate = info.callCount > 0
      ? info.successCount / info.callCount
      : 0;
    if (successRate >= MIN_SUCCESS_RATE) {
      registerDiscoveredTool(toolName, info);
      promoted++;
    }
  }

  if (promoted > 0) {
    schedulePersist();
  }
}

// ====== 工具导出：core_toolDiscover ======

/**
 * core_toolDiscover - 查询自动发现的工具清单
 *
 * 管理员和子 agent 都能调这个工具，查看当前发现了哪些外部工具、
 * 各个工具的调用stats（次数/成功率/置信度）、以及是否已升白。
 *
 * 参数：无或 { filter: "pending|promoted|all" }
 * 返回：{ summary, discovered }
 */
async function toolDiscoverExecute(params) {
  const filter = (params?.filter || 'all').toLowerCase();
  const now = Date.now();
  const entries = [];
  let pendingCount = 0;
  let promotedCount = 0;

  for (const [toolName, info] of trackedTools) {
    if (filter === 'pending' && info.promoted) continue;
    if (filter === 'promoted' && !info.promoted) continue;

    const successRate = info.callCount > 0
      ? (info.successCount / info.callCount * 100).toFixed(1) + '%'
      : 'N/A';

    entries.push({
      toolName,
      callCount: info.callCount,
      successCount: info.successCount,
      failCount: info.failCount,
      successRate,
      confidence: info.confidence,
      promoted: info.promoted,
      promotedAt: info.promotedAt ? new Date(info.promotedAt).toISOString() : null,
      firstSeen: info.firstSeen ? new Date(info.firstSeen).toISOString() : null,
      lastSeen: info.lastSeen ? new Date(info.lastSeen).toISOString() : null,
      daysSinceFirstSeen: info.firstSeen ? Math.round((now - info.firstSeen) / 86400000) : 0,
      // 🧠 建议标签：根据置信度和天数给用户建议
      suggestion: info.promoted ? '✅ 已纳入推荐' :
                  info.confidence < 0.3 ? '⚠️ 置信度低' :
                  info.callCount < PROMOTE_THRESHOLD ? '🔍 观察中' :
                  '⚡ 快到升白阈值',
    });

    if (info.promoted) promotedCount++;
    else pendingCount++;
  }

  // 按调用次数降序排列
  entries.sort((a, b) => b.callCount - a.callCount);

  return {
    summary: {
      totalTracked: trackedTools.size,
      promotedCount,
      pendingCount,
      totalDiscoveries: _discoveryCount,
    },
    filter,
    discovered: entries,
  };
}

// ====== 注册入口 ======

/**
 * 注册tool auto-discover系统
 *
 * 必须在 activate() 中调用，传 ctx 和 deps。
 *
 * @param {object} ctx - OpenClaw 插件上下文
 * @param {object} deps - 依赖注入
 */
export async function register(ctx, deps = {}) {
  _ctx = ctx;

  // 1. 加载persist数据
  await loadPersistedData();

  // 🔧 Bug2: 重启后，对persist中已 promoted 的工具重新升白
  // CORE_TOOLS/TASK_TIMEOUT_MAP/管家规则在内存中重建，需要从持久数据恢复
  let rePromotedCount = 0;
  for (const [toolName, info] of trackedTools) {
    if (info.promoted) {
      // 临时取消 promoted 标记以通过重复保护检查
      info.promoted = false;
      registerDiscoveredTool(toolName, info);
      // registerDiscoveredTool 内部会再次将 info.promoted 设为 true
      rePromotedCount++;
    }
  }
  if (rePromotedCount > 0 && ctx.logger) {
    ctx.logger.info(`🔍 tool auto-discover: 已恢复 ${rePromotedCount} 个已升白工具`);
  }

  // 🔧 Bug3: after_tool_call hook 已移除 —— 统一由 index.js 的 after_tool_call hook 调用
  //    recordExternalToolCall() 处理外部工具记录,避免两个 hook 重复执行。
  //    导出函数由 index.js 的已有 hook 调用。

  // 2. 🪄 导入历史数据：从 deps.getToolStats 读取已有的 7 天stats
  try {
    if (deps.getToolStats && typeof deps.getToolStats === 'function') {
      const allStats = deps.getToolStats();
      if (allStats && typeof allStats === 'object') {
        let imported = 0;
        for (const [toolName, stat] of Object.entries(allStats)) {
          if (toolName.startsWith('cpu_')) continue;
          if (trackedTools.has(toolName)) continue; // 已有记录，不覆盖
          if (stat.calls < 1) continue;

          // 从内部化stats导入初始数据
          trackedTools.set(toolName, {
            callCount: stat.calls || 0,
            successCount: stat.successes || 0,
            failCount: stat.failures || 0,
            firstSeen: Date.now() - 7 * 86400000, // 保守估计7天前
            lastSeen: Date.now(),
            promoted: false,
            promotedAt: null,
            confidence: CONFIDENCE_INIT,
          });
          imported++;

          // 导入时也检查升白件
          const ratio = stat.calls > 0 ? stat.successes / stat.calls : 0;
          if (ratio >= MIN_SUCCESS_RATE && stat.calls >= PROMOTE_THRESHOLD) {
            const info = trackedTools.get(toolName);
            registerDiscoveredTool(toolName, info);
          }
        }
        if (imported > 0) {
          ctx.logger.info(`🔍 tool auto-discover: 已导入 ${imported} 个历史工具记录`);
        }
      }
    }
  } catch (e) {
    ctx.logger.warn(`🔍 tool auto-discover: 历史数据导入失败: ${e.message}`);
  }

  // 3. 注册 core_toolDiscover 工具
  try {
    ctx.registerTool({
      name: 'core_toolDiscover',
      description: '🔍 查询自动发现的外部工具清单。返回已追踪但未升白/已升白的所有工具及其调用stats和置信度。',
      parameters: {
        type: 'object',
        properties: {
          filter: {
            type: 'string',
            enum: ['all', 'pending', 'promoted'],
            description: '筛选件: all(全部), pending(待升白), promoted(已升白)',
          },
        },
        required: [],
      },
      execute: toolDiscoverExecute,
    });

    // 追加到 CORE_TOOLS（让 before_tool_call 放行）
    if (!CORE_TOOLS.includes('core_toolDiscover')) {
      CORE_TOOLS.push('core_toolDiscover');
    }
    // 超时配置
    if (!TASK_TIMEOUT_MAP['core_toolDiscover']) {
      TASK_TIMEOUT_MAP['core_toolDiscover'] = { warn: 10, kill: 30, label: 'tool auto-discover' };
    }
    // 管家规则
    try {
      registerToolTier('core_toolDiscover', 'safe');
    } catch {}

    ctx.logger.info('🔍 core_toolDiscover 工具已注册');
  } catch (e) {
    ctx.logger.warn(`🔍 core_toolDiscover 工具注册失败: ${e.message}`);
  }

  // 4. 启动定时检查
  timerId = setInterval(periodicCheck, CHECK_INTERVAL_MS);

  _initialized = true;
  ctx.logger.info(`🔍 tool auto-discoverready (已追踪 ${trackedTools.size} 个工具)`);
}

/**
 * 优雅关闭：停止定时器、落盘最后数据
 */
export async function shutdown() {
  if (timerId) {
    clearInterval(timerId);
    timerId = null;
  }

  // 🔧 Bug1: 通过 _persist() 串行化写盘，避免与 schedulePersist 冲突
  await _persist();

  _initialized = false;
  // TODO: 移除调试日志 console.log('[tool auto-discover] 🛑 已关闭');
}

/**
 * 获取当前已发现工具stats摘要
 * @returns {object}
 */
export function getDiscoveredStats() {
  return {
    totalTracked: trackedTools.size,
    promotedCount: [...trackedTools.values()].filter(t => t.promoted).length,
    pendingCount: [...trackedTools.values()].filter(t => !t.promoted).length,
    totalDiscoveries: _discoveryCount,
    tools: [...trackedTools.keys()].sort(),
  };
}
