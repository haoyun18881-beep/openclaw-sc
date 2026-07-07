/**
 * 🦞 sc — steward rules engine (Steward Rules)
 *
 * 即插即用的行为规则体系，不需要 AGENTS.md/MEMORY.md 加持。
 * 装好插件就自带管家。
 *
 * 🧠 设计决策：TOOL_TIERS 三级分类（safe/suggest_delegate/force_delegate）
 * 2026-06-03 force_delegate 瘦身：24→6（仅保留毁灭级工具）
 * force_delegate 4个工具：exec/write/edit/cron/core_emergencyStop
 * 其中敏感脱敏标记（write/edit/exec）3个，用于 autoRedirect 参数保护
 * 其余原 force_delegate 工具已移至 suggest_delegate（web_search/browser/nodes/message 等）
 * 不在任何 tier 中的工具默认 safe（不限制），逐步补全中
 *
 * 🧠 设计决策：子 agent 全部放行（context.isSubAgent），因为子 agent 的
 * 会话已由主 agent 的 spawn 逻辑做了权限分离——主 agent 不直接调 force_delegate
 * 工具，子 agent 才调，这是双层安全设计。
 *
 * 核心能力：
 *   1. TOOL_TIERS 三级分类（safe / suggest_delegate / force_delegate）
 *   2. StewardGuard.check(toolName, context) → ALLOW | WARN | BLOCK
 *   3. estimateDelegate(taskDescription) → 判断是否派子agent
 *   4. 首次运行自动生成 ~/.openclaw/steward-config.json 默认配置
 *   5. 支持从 steward-config.json 读取用户覆盖
 *   6. 所有模型名从系统配置读，不写死
 */

import { homedir } from 'os';
import { join } from 'path';
import { readFile, writeFile, mkdir } from 'fs/promises';


// ============================
// 内置工具三级分类
// ============================

/**
 * 🟢 L0 — 主agent可直接调用，s级，无安全风险
 * suggest_delegate: 🟡 L1 — 主agent可调但建议子agent，小任务不强制
 * force_delegate: 🔴 L2 — 必须子agent调，主agent调会被拦截
 *
 * 可以从 steward-config.json 中的 userOverrides 覆盖
 */
// 🦞 sc工具三级分类（清理后：仅保留11个保留工具）
// 不在tier中的工具默认safe（不限制），后续逐步补全
const DEFAULT_TOOL_TIERS = {
  safe: [
    // 🧠 推理域 + 搜索域
    'core_memorySearch', 'core_webSearch',
    'core_codeEditor',
    // 🔵 脊髓反射 — 毫s级，无安全风险
    'core_stats', 'core_about',
    // 🔵 指挥调度
    'core_spawnWorker', 'core_spawnAgent', 'core_taskPipeline',
  ],

  suggest_delegate: [
    // 🟡 文件与视觉 — 主脑可调但建议子agent
    'core_fileManager', 'core_batchVision',
    'core_emergencyStop',  // 杉哥授权主agent可直接紧急停机(2026-06-21)
  ],

  force_delegate: [
    // 🔴 毁灭级——不可限制，不可绕过。精简原则：一步到位不降级。如需调整必须杉哥签字确认
    'exec',       // 全量shell执行
    'write',      // 文件覆写
    'edit',       // 文件注入
    'cron',       // persist计划任务
  ],
};

// // ============================
// // 运行时自定义工具注册(不污染DEFAULT_TOOL_TIERS常量)
// // ============================
// // 用于 registerToolTier 运行时注册的工具，避免直接push到const常量对象
// // 每次 applyUserOverrides 重置 _toolTiers 时合并进去
/** @type {{safe: Set<string>, suggest_delegate: Set<string>, force_delegate: Set<string>}} */
const _customToolTiers = {
  safe: new Set(),
  suggest_delegate: new Set(),
  force_delegate: new Set(),
};

// ============================
// 默认危险词（内部使用）
// ============================
const DANGER_WORDS = ['删除', '格式化', 'rm -rf', '强制终止', 'kill -9', 'shutdown'];

// ============================
// 内置规则源（即使用户没有 AGENTS.md 也生效）
// ============================
// 🧿 Fix-13: forceDelegateTools 中只保留配置文件可扩充的工具列表，
//    不包含 core_emergencyStop（已在 DEFAULT_TOOL_TIERS.force_delegate 登记）。
//    避免双登记导致熔断系统永远到不了 BLOCK 级别。
const DEFAULT_RULES = {
  version: '1.0',
  mode: 'strict',
  rules: {
    forceDelegateTools: DEFAULT_TOOL_TIERS.force_delegate.filter(t => t !== 'core_emergencyStop'),
    delegateThresholdMs: 5000,
    autoKillBackgroundTasks: true,
    maxSubagentsPerUser: 18,
    /**
     * autoRedirect 自动重定向配置
     * enabled: 开启时 force_delegate 级工具被主agent调用时不直接拦截,
     *         而是自动派子agent去执行（对用户透明）
     * sensitiveTools: 工具参数需要脱敏的工具列表（工具名）
     *                  参数中的 path/file/content 等字段会被替换为[已脱敏]
     * 🧿 设计决策：敏感脱敏仅 write/edit/exec 3个（参数字段含路径/内容/命令）
     *    其他 force_delegate 工具（cron/core_emergencyStop）的参数字段
     *    不含路径/内容/命令等敏感数据，不需要脱敏。不是遗漏。
     */
    autoRedirect: {
      enabled: true,
      sensitiveTools: ['write', 'edit', 'exec'],
    },
  },
  userOverrides: {
    allowDirectTools: [],
    customDelegateRules: [],
  },
};

// ============================
// 默认配置路径
// ============================
export const DEFAULT_CONFIG_PATH = join(homedir(), '.openclaw', 'steward-config.json');

// ============================
// 管家状态stats
// ============================
const stewardStats = {
  totalChecks: 0,
  allowed: 0,
  warned: 0,
  blocked: 0,
  subagentSkips: 0,
  lastBlockedTool: null,
  lastBlockedTime: 0,
  configReloads: 0,
  mode: 'strict',
};

// ============================
// 配置缓存（5s）
// ============================
let _configCache = null;
let _configCacheTime = 0;
const CONFIG_CACHE_TTL = 5000;

// ============================
// TOOL_TIERS（可被配置覆盖）
// ============================
let _toolTiers = structuredClone(DEFAULT_TOOL_TIERS);

/**
 * 读取 steward-config.json（带缓存）
 */
async function readStewardConfig() {
  const now = Date.now();
  if (_configCache && now - _configCacheTime < CONFIG_CACHE_TTL) {
    return _configCache;
  }
  try {
    const content = await readFile(DEFAULT_CONFIG_PATH, 'utf-8');
    _configCache = JSON.parse(content);
    _configCacheTime = now;
    return _configCache;
  } catch {
    return null;
  }
}

/**
 * 写入 steward-config.json
 */
async function writeStewardConfig(config) {
  try {
    // 确保 ~/.openclaw/ 目录存在
    await mkdir(join(homedir(), '.openclaw'), { recursive: true });
    await writeFile(DEFAULT_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    _configCache = config;
    _configCacheTime = Date.now();
    return true;
  } catch (err) {
    console.warn(`[Steward] ⚠️ 写入配置失败: ${err.message}`);
    return false;
  }
}

/**
 * @deprecated 2026-06-21: 外部配置文件不再影响工具分级。
 * readStewardConfig/writeStewardConfig 保留供 setAutoRedirect 内部使用。
 */

/**
 * 应用运行时覆盖到 TOOL_TIERS（仅内存，不读外部文件）
 * 2026-06-21: 移除外部文件依赖，tier 全部硬编码在 DEFAULT_TOOL_TIERS
 */
function applyUserOverrides() {
  // 重置 TOOL_TIERS 为默认值 + 合并自定义注册
  _toolTiers = structuredClone(DEFAULT_TOOL_TIERS);
  // 合并运行时 registerToolTier 注册的自定义工具（不污染 const 常量）
  for (const tier of ['safe', 'suggest_delegate', 'force_delegate']) {
    for (const tool of _customToolTiers[tier]) {
      // 从其他等级移除
      for (const otherTier of ['safe', 'suggest_delegate', 'force_delegate']) {
        if (otherTier !== tier) {
          const idx = _toolTiers[otherTier].indexOf(tool);
          if (idx >= 0) _toolTiers[otherTier].splice(idx, 1);
        }
      }
      // 加到目标等级（去重）
      if (!_toolTiers[tier].includes(tool)) {
        _toolTiers[tier].push(tool);
      }
    }
  }
}

/**
 * 获取当前 TOOL_TIERS（已合并用户覆盖）
 */
export function getToolTiers() {
  return _toolTiers;
}

/**
 * 判断一个工具在哪一级
 * @param {string} toolName
 * @returns {'safe'|'suggest_delegate'|'force_delegate'|null}
 */
function getToolTier(toolName) {
  if (_toolTiers.safe.includes(toolName)) return 'safe';
  if (_toolTiers.suggest_delegate.includes(toolName)) return 'suggest_delegate';
  if (_toolTiers.force_delegate.includes(toolName)) return 'force_delegate';
  // 不在表中的工具默认 safe（不限制）
  return 'safe';
}

// ============================
// ✨ autoRedirect 自动重定向配置
// ============================

/**
 * 读取 autoRedirect 配置
 * @returns {{ enabled: boolean, sensitiveTools: string[] }}
 */
function getAutoRedirectConfig() {
  try {
    const cfg = _configCache;
    const auto = cfg?.rules?.autoRedirect;
    if (auto && typeof auto === 'object') {
      return {
        enabled: auto.enabled !== false,
        sensitiveTools: Array.isArray(auto.sensitiveTools) ? auto.sensitiveTools : ['write', 'edit', 'exec'],
      };
    }
  } catch {}
  return { enabled: true, sensitiveTools: ['write', 'edit', 'exec'] };
}

/**
 * 检查 autoRedirect 是否启用
 * @returns {boolean}
 */
export function isAutoRedirectEnabled() {
  return getAutoRedirectConfig().enabled;
}

/**
 * 检查工具参数是否需要脱敏
 * @param {string} toolName
 * @returns {boolean}
 */
function isSensitiveTool(toolName) {
  const cfg = getAutoRedirectConfig();
  return cfg.sensitiveTools.includes(toolName);
}

/**
 * 对工具参数脱敏（替换路径/内容等敏感字段）
 * 返回 { display: 脱敏版, raw: 完整版 } 双重结构
 * @param {string} toolName - 工具名
 * @param {object} params - 原始参数
 * @returns {{ display: object, raw: object }} 脱敏显示版 + 原始完整版
 */
export function sanitizeToolParams(toolName, params) {
  if (!params || typeof params !== 'object') return { display: params || {}, raw: params || {} };
  if (!isSensitiveTool(toolName)) return { display: { ...params }, raw: { ...params } };

  // 保留原始完整副本
  const raw = { ...params };

  // 构建脱敏显示版
  const display = { ...params };

  // 需要脱敏的敏感字段名
  const sensitiveFields = ['path', 'content', 'command', 'file', 'data', 'text', 'params', 'url'];

  for (const key of Object.keys(display)) {
    const lowerKey = key.toLowerCase();
    // 检测参数值是否包含敏感字段特征
    if (sensitiveFields.includes(lowerKey)) {
      const val = display[key];
      if (typeof val === 'string') {
        if (val.length > 30) {
          display[key] = val.substring(0, 20) + '...[已脱敏,长度=' + val.length + ']';
        }
        // 对路径类参数只保留文件名
        if (lowerKey === 'path' || lowerKey === 'file') {
          const parts = val.replace(/\\\\/g, '/').split('/');
          display[key] = parts[parts.length - 1] || '[已脱敏]';
        }
      }
    } else if (typeof display[key] === 'object' && display[key] !== null) {
      // 递归脱敏嵌套对象时，也返回 display/raw 结构
      const nested = sanitizeToolParams(toolName, display[key]);
      display[key] = nested.display;
      raw[key] = nested.raw;
    }
  }

  return { display, raw };
}

/**
 * 构建子agent任务描述（用于autoRedirect自动派发）
 * 使用原始参数（raw）生成任务描述，确保子agent拿到真实参数
 * @param {string} toolName - 被拦截的工具名
 * @param {{ display: object, raw: object }} params - sanitizeToolParams 的返回值
 * @returns {string} 任务描述文本
 */
export function buildAutoRedirectTask(toolName, params) {
  // 兼容旧调用：如果传入的是普通对象（非 display/raw 结构），直接作为 raw 使用
  const rawParams = (params && typeof params === 'object' && 'raw' in params)
    ? params.raw
    : params || {};

  const paramSummary = Object.keys(rawParams).slice(0, 5).join(', ');
  const paramDetail = JSON.stringify(rawParams, null, 2);

  return `🏃 模式: L3
思考: low

任务：执行工具 ${toolName}（由主agent通过autoRedirect机制自动派发）

步骤：
1. 使用工具 ${toolName} 执行以下真实参数：
${paramDetail}
2. 将执行结果返回给主agent

输出路径：返回执行结果文本

验收标准：工具 ${toolName} 执行成功并返回结果

⚡ 规则：失败熔断2次换路 | Tool Compaction ≤3000字 | 禁止browser/message | exec限工作区`;
}

// ============================
// ✨ 任务描述关键词匹配（应不应该派子agent）
// ============================

/**
 * 根据任务描述判断是否应该派子agent
 *
 * @param {string} taskDescription - 任务描述文本
 * @returns {{ shouldDelegate: boolean|null, reason: string, suggestedLevel: string, tools: string[] }}
 *
 * 返回说明：
 *   shouldDelegate = true  → 确定该派
 *   shouldDelegate = false → 确定不需派
 *   shouldDelegate = null  → 不确定，建议走 core_routeTask
 */
export function estimateDelegate(taskDescription) {
  if (!taskDescription || typeof taskDescription !== 'string') {
    return { shouldDelegate: null, reason: '无效任务描述', suggestedLevel: 'auto', tools: ['core_routeTask'] };
  }

  const desc = taskDescription.toLowerCase();

  // 明确耗时的任务 → 派子agent
  const longRunningPatterns = [
    '搜索', '下载', '分析', '审查', '修复', '调研',
    '搜索', '分析', '调研', '研究', '审查', '审查', '修复', '修复',
    '执行', '运行', '安装', '部署', '配置', '下载',
    '爬取', '采集', '抓取', '同步', '备份',
    '批量', '多个', '大量',
    'research', 'analyze', 'review', 'fix', 'execute',
    'install', 'deploy', 'configure', 'download',
    'batch', 'multiple', 'sync', 'backup',
  ];
  for (const pattern of longRunningPatterns) {
    if (desc.includes(pattern)) {
      return { shouldDelegate: true, reason: '耗时任务', suggestedLevel: 'L3+', tools: ['sessions_spawn'] };
    }
  }

  // 快速查询 → 可直接
  const quickPatterns = [
    '查状态', '看日志', '查信息', '查看',
    'stats', '状态', '信息',
    'status', 'stats', 'info', 'check',
    'lookup', 'query', 'get',
  ];
  for (const pattern of quickPatterns) {
    if (desc.includes(pattern)) {
      // 🧿 Fix-13: cpu_dialogRecall 旧名 → core_memorySearch
      return { shouldDelegate: false, reason: '快速查询', suggestedLevel: 'L0-L1', tools: ['core_stats', 'core_memorySearch'] };
    }
  }

  // 不确定 → 走 routeTask 自动判断
  return { shouldDelegate: null, reason: '需自动判断', suggestedLevel: 'auto', tools: ['core_routeTask'] };
}

// ============================
// 🛡️ StewardGuard 类
// ============================

export const RESULT = {
  ALLOW:  { verdict: 'ALLOW',  block: false, severity: 'none' },
  WARN:   { verdict: 'WARN',   block: false, severity: 'low' },
  BLOCK:  { verdict: 'BLOCK',  block: true,  severity: 'high' },
  ESCALATE: { verdict: 'ESCALATE', block: true, severity: 'critical' },
};

/**
 * StewardGuard 管家守卫
 *
 * 使用：const result = await StewardGuard.check(toolName, context)
 *
 * @param {string} toolName - 工具名
 * @param {object} context - 调用上下文 { isSubAgent, isEmergencyMode, sessionKey }
 * @returns {Promise<{ verdict: string, block: boolean, severity: string, blockReason?: string, warnMessage?: string }>}
 */
export class StewardGuard {
  /**
   * 检查工具是否被允许
   *
   * @param {string} toolName - 工具名称
   * @param {object} [context={}] - 上下文 { isSubAgent, isEmergencyMode, sessionKey }
   * @returns {Promise<{verdict: string, block: boolean, severity: string, blockReason?: string, warnMessage?: string}>}
   */
  // 🔒 杉哥2026-06-06颁令：全局硬编码子Agent派兵禁令
  // 架构层焊死，不可被任何配置覆盖。子Agent不能派任何形式的兵
  // 这是杉杉核心安全基线——不允许产生Agent后代
  static SPAWN_TOOLS = new Set([
    'sessions_spawn',
    'core_spawnAgent',
    'core_taskPipeline',
    'core_spawnWorker',
  ]);

  static async check(toolName, context = {}) {
    stewardStats.totalChecks++;

    // 0. 子Agent → 架构层硬规则检查（不可绕过，不可配置覆盖）
    if (context.isSubAgent === true) {
      // 🔒 架构焊死：子Agent不能派兵（杉哥2026-06-06颁令）
      if (StewardGuard.SPAWN_TOOLS.has(toolName)) {
        stewardStats.blocked++;
        stewardStats.lastBlockedTool = toolName;
        stewardStats.lastBlockedTime = Date.now();
        return {
          ...RESULT.BLOCK,
          blockReason: `[Steward] 🚫 架构焊死: 子Agent禁止派兵（杉哥2026-06-06颁令）。工具 ${toolName} 不可由子Agent调用。`,
        };
      }
      stewardStats.subagentSkips++;
      stewardStats.allowed++;
      return { ...RESULT.ALLOW, blockReason: null };
    }

    // 1. 紧急模式 → 只放行 safe
    if (context.isEmergencyMode === true) {
      const tier = getToolTier(toolName);
      if (tier === 'safe') {
        stewardStats.allowed++;
        return { ...RESULT.ALLOW, blockReason: null };
      }
      stewardStats.blocked++;
      stewardStats.lastBlockedTool = toolName;
      stewardStats.lastBlockedTime = Date.now();
      return {
        ...RESULT.BLOCK,
        blockReason: `[Steward] 🚫 紧急模式安全限制: ${toolName} 当前不可用。仅 safe 级工具(core_stats/core_routeTask 等)可放行。`,
      };
    }

    // 2. 根据工具分级返回
    const tier = getToolTier(toolName);

    if (tier === 'safe') {
      stewardStats.allowed++;
      return { ...RESULT.ALLOW, blockReason: null };
    }

    if (tier === 'suggest_delegate') {
      stewardStats.warned++;
      return {
        ...RESULT.WARN,
        warnMessage: `[Steward] 💡 建议: ${toolName} 属于 suggest_delegate 级工具，主 agent 可直接调但建议派子 agent 执行以保持司令角色。`,
      };
    }

    if (tier === 'force_delegate') {
      stewardStats.blocked++;
      stewardStats.lastBlockedTool = toolName;
      stewardStats.lastBlockedTime = Date.now();

      // autoRedirect: 如果启用，返回 redirectInfo 供调用方自动派子agent
      let redirectInfo = null;
      try {
        const autoCfg = getAutoRedirectConfig();
        if (autoCfg.enabled) {
          redirectInfo = {
            enabled: true,
            toolName,
            autoRedirect: true,
            message: `已自动派子agent处理 [${toolName}]`,
          };
        }
      } catch {}

      return {
        ...RESULT.BLOCK,
        autoRedirect: redirectInfo?.autoRedirect === true || false,
        redirectInfo,
        blockReason: `[Steward] 🚫 ⚡司令铁律拦截: ${toolName} 主agent禁止直接调用。\\n` +
          '· 原因: 该工具属于 force_delegate 级，必须由子 agent 执行\\n' +
          '· 建议: sessions_spawn 派子 agent → 子 agent 再调该工具\\n' +
          '· 放行: 杉哥可在代码层面临时解除限制',
      };
    }

    // 3. 未知工具 → 默认放行
    stewardStats.allowed++;
    return { ...RESULT.ALLOW, blockReason: null };
  }

  /**
   * 检查任务描述是否应派子agent（便捷方法）
   * @param {string} taskDescription
   * @returns {{ shouldDelegate: boolean|null, reason: string, suggestedLevel: string, tools: string[] }}
   */
  static estimateDelegate(taskDescription) {
    return estimateDelegate(taskDescription);
  }

  /**
   * 刷新配置（重新读取 steward-config.json 并应用覆盖）
   */
  static async refreshConfig() {
    // 2026-06-21: 外部文件不再影响分级，refresh 仅做内存覆盖
    _configCache = null;
    _configCacheTime = 0;
    stewardStats.configReloads++;
    applyUserOverrides();
    return { mode: stewardStats.mode, configReloads: stewardStats.configReloads };
  }

  /**
   * 获取当前状态
   */
  static getStatus() {
    return {
      mode: stewardStats.mode,
      totalChecks: stewardStats.totalChecks,
      allowed: stewardStats.allowed,
      warned: stewardStats.warned,
      blocked: stewardStats.blocked,
      subagentSkips: stewardStats.subagentSkips,
      lastBlockedTool: stewardStats.lastBlockedTool,
      lastBlockedTime: stewardStats.lastBlockedTime,
      configReloads: stewardStats.configReloads,
      tiers: {
        safe: _toolTiers.safe.length,
        suggest_delegate: _toolTiers.suggest_delegate.length,
        force_delegate: _toolTiers.force_delegate.length,
      },
      configPath: DEFAULT_CONFIG_PATH,
      configExists: _configCache !== null,
    };
  }

  /**
   * 注册一个工具到指定管家等级
   * @param {string} toolName - 工具名称
   * @param {string} tier - 等级: safe | suggest_delegate | force_delegate
   */
  static registerToolTier(toolName, tier = 'safe') {
    const validTiers = ['safe', 'suggest_delegate', 'force_delegate'];
    if (!validTiers.includes(tier)) tier = 'safe';
    // 从其他等级移除
    for (const t of validTiers) {
      const idx = _toolTiers[t].indexOf(toolName);
      if (idx >= 0) _toolTiers[t].splice(idx, 1);
    }
    // 加到目标等级（去重）
    if (!_toolTiers[tier].includes(toolName)) {
      _toolTiers[tier].push(toolName);
    }
    // 🧿 Fix-13: 改用 _customToolTiers Set 记录，不再直接 push 到 const 常量 DEFAULT_TOOL_TIERS
    //           防止 const 对象被意外突变，下轮 applyUserOverrides 时会从 Set 合并
    _customToolTiers[tier].add(toolName);
    // 从其他 custom 等级中移除（确保工具只在一个等级中）
    for (const otherTier of validTiers) {
      if (otherTier !== tier) {
        _customToolTiers[otherTier].delete(toolName);
      }
    }
  }

  /**
   * 初始化管家（仅内存，2026-06-21 移除外部文件读写）
   */
  static init() {
    applyUserOverrides();
    return stewardStats.mode;
  }
}

// ============================
// 快捷函数：注册工具到指定管家等级
// ============================
export function registerToolTier(toolName, tier = 'safe') {
  return StewardGuard.registerToolTier(toolName, tier);
}

// ============================
// 导出 TOOL_TIERS
// ============================
export const TOOL_TIERS = DEFAULT_TOOL_TIERS;

// ============================
// 导出危险词
// ============================
export { DANGER_WORDS };

// ============================
// 导出配置读写
// ============================
export { readStewardConfig, writeStewardConfig };

// ============================
// 导出stats
// ============================
export { stewardStats };
