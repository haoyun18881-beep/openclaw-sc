/**
 * 🧬 sc 任务配置文件 — 工具类型→并发/模型/thinking 映射
 *
 * 核心设计：
 *   1. 所有模型名从 openclaw.json 动态读取（agents.defaults.model.primary），不写死任何模型ID
 *   2. 按任务类别划分：搜索/编码/分析/配置/批量/视觉/系统
 *   3. 每种类别定义推荐并发度、batchSize、maxWorkers、thinking预算
 *   4. 导出 getTaskProfile(toolName) 和 core_pickSubagentModel(toolName)
 *
 * v1.1 — 2026-06-09 空catch修复 + 类型安全
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

// ====== Config cache ======
/** @type {object|null} */
let _configCache = null;
let _configCacheTime = 0;
const CONFIG_CACHE_TTL = 30000;

/**
 * 读取并缓存 openclaw.json
 * @returns {Promise<object|null>} 配置对象或 null
 */
async function readOpenClawConfig() {
  const now = Date.now();
  if (_configCache && now - _configCacheTime < CONFIG_CACHE_TTL) return _configCache;
  try {
    const content = await readFile(join(homedir(), '.openclaw', 'openclaw.json'), 'utf-8');
    _configCache = JSON.parse(content);
    _configCacheTime = now;
  } catch (err) {
    // 🔧 空catch修复: 记录读取/解析失败原因
    if (typeof console !== 'undefined' && console.warn) {
      const reason = err?.code === 'ENOENT' ? '配置文件不存在' : (err?.message || '未知错误');
      console.warn(`[task-profiles] 读取 openclaw.json 失败: ${reason}`);
    }
    _configCache = null;
    _configCacheTime = now;
  }
  return _configCache;
}

/**
 * 清除配置缓存（让下一次读取重新加载）
 */
export function clearProfileCache() {
  _configCache = null;
  _configCacheTime = 0;
}

/**
 * 从系统配置读取 primary 模型
 * @returns {Promise<{full: string|null, provider: string|null, model: string|null}>}
 */
async function getPrimaryModel() {
  const cfg = await readOpenClawConfig();
  if (!cfg) return { full: null, provider: null, model: null };
  const modelStr = cfg?.agents?.defaults?.model?.primary || null;
  if (!modelStr) return { full: null, provider: null, model: null };
  const parts = modelStr.split('/');
  return {
    full: modelStr,
    provider: parts[0] || null,
    model: parts[1] || parts[0],
  };
}

// ====== 任务类别枚举 ======
export const TASK_CATEGORIES = {
  SEARCH: 'search',
  CODING: 'coding',
  ANALYSIS: 'analysis',
  CONFIG: 'config',
  BATCH: 'batch',
  VISION: 'vision',
  SYSTEM: 'system',
};

// ====== 工具名 → 类别映射 ======
const TOOL_CATEGORY_MAP = {
  // 搜索查询类
  cpu_search: TASK_CATEGORIES.SEARCH,
  cpu_scan: TASK_CATEGORIES.SEARCH,
  cpu_semanticSearch: TASK_CATEGORIES.SEARCH,
  cpu_dialogRecall: TASK_CATEGORIES.SEARCH,

  // 编码类
  cpu_codeEdit: TASK_CATEGORIES.CODING,
  cpu_codeReview: TASK_CATEGORIES.CODING,
  cpu_bugFix: TASK_CATEGORIES.CODING,

  // 分析类
  cpu_diff: TASK_CATEGORIES.ANALYSIS,
  cpu_diagnose: TASK_CATEGORIES.ANALYSIS,
  cpu_research: TASK_CATEGORIES.ANALYSIS,
  cpu_orchestrate: TASK_CATEGORIES.ANALYSIS,

  // 配置类
  cpu_resolveModel: TASK_CATEGORIES.CONFIG,

  // 批量调度类
  cpu_batch: TASK_CATEGORIES.BATCH,
  core_dispatch: TASK_CATEGORIES.BATCH,

  // 视觉分析类
  core_batchVision: TASK_CATEGORIES.VISION,

  // 系统管理类
  core_stats: TASK_CATEGORIES.SYSTEM,
  core_routeTask: TASK_CATEGORIES.SYSTEM,
  cpu_routeEvidence: TASK_CATEGORIES.SYSTEM,
  cpu_evolution: TASK_CATEGORIES.SYSTEM,
  cpu_chainDetect: TASK_CATEGORIES.SYSTEM,
  cpu_cerebellumStatus: TASK_CATEGORIES.SYSTEM,
  cpu_monitorSubagents: TASK_CATEGORIES.SYSTEM,
  core_backup: TASK_CATEGORIES.SYSTEM,
  core_about: TASK_CATEGORIES.SYSTEM,
  core_emergencyStop: TASK_CATEGORIES.SYSTEM,
  cpu_compressTask: TASK_CATEGORIES.SYSTEM,
};

// ====== 各类别推荐配置 ======
const CATEGORY_PROFILES = {
  [TASK_CATEGORIES.SEARCH]: {
    concurrency: 8,
    batchSize: 5,
    maxWorkers: 28,
    thinking: 'off',
    label: '搜索查询类',
  },
  [TASK_CATEGORIES.CODING]: {
    concurrency: 4,
    batchSize: 3,
    maxWorkers: 16,
    thinking: 'high',
    label: '编码类',
  },
  [TASK_CATEGORIES.ANALYSIS]: {
    concurrency: 4,
    batchSize: 4,
    maxWorkers: 8,
    thinking: 'medium',
    label: '分析类',
  },
  [TASK_CATEGORIES.CONFIG]: {
    concurrency: 2,
    batchSize: 1,
    maxWorkers: 4,
    thinking: 'off',
    label: '配置类',
  },
  [TASK_CATEGORIES.BATCH]: {
    concurrency: 6,
    batchSize: 4,
    maxWorkers: 20,
    thinking: 'off',
    label: '批量调度类',
  },
  [TASK_CATEGORIES.VISION]: {
    concurrency: 3,
    batchSize: 3,
    maxWorkers: 6,
    thinking: 'low',
    label: '视觉分析类',
  },
  [TASK_CATEGORIES.SYSTEM]: {
    concurrency: 2,
    batchSize: 1,
    maxWorkers: 3,
    thinking: 'off',
    label: '系统管理类',
  },
};

/**
 * 获取工具的推荐配置
 * @param {string} toolName - 工具名，如 'core_search'
 * @returns {{ category: string, concurrency: number, batchSize: number, maxWorkers: number, thinking: string, label: string }}
 */
export function getTaskProfile(toolName) {
  const category = TOOL_CATEGORY_MAP[toolName] || TASK_CATEGORIES.SYSTEM;
  const profile = CATEGORY_PROFILES[category] || CATEGORY_PROFILES[TASK_CATEGORIES.SYSTEM];
  return {
    category,
    ...profile,
  };
}

/**
 * 获取工具名对应的类别
 * @param {string} toolName
 * @returns {string}
 */
export function getTaskCategory(toolName) {
  return TOOL_CATEGORY_MAP[toolName] || TASK_CATEGORIES.SYSTEM;
}

/**
 * 获取所有类别定义
 * @returns {Object}
 */
export function getCategoryProfiles() {
  return { ...CATEGORY_PROFILES };
}

/**
 * 获取工具→类别映射
 * @returns {Object}
 */
export function getToolCategoryMap() {
  return { ...TOOL_CATEGORY_MAP };
}

/**
 * 🧠 为子 agent 选取推荐模型和 thinking 级别
 *
 * 所有模型名从系统配置（openclaw.json → agents.defaults.model.primary）动态读取，
 * 不写死任何模型ID。
 *
 * 规则：
 *   - 搜索类 → thinking=off
 *   - 编码类 → thinking=high
 *   - 分析类 → thinking=low
 *   - 视觉类 → thinking=low
 *   - 其他类 → thinking=off
 *
 * @param {string} toolName - 工具名
 * @returns {Promise<{ model: string|null, provider: string|null, modelId: string|null, thinking: string, category: string, label: string }>}
 */
export async function core_pickSubagentModel(toolName) {
  const primary = await getPrimaryModel();
  const profile = getTaskProfile(toolName);

  return {
    model: primary.full || null,
    provider: primary.provider,
    modelId: primary.model,
    thinking: profile.thinking,
    category: profile.category,
    label: profile.label,
  };
}

export default {
  getTaskProfile,
  getTaskCategory,
  getCategoryProfiles,
  getToolCategoryMap,
  core_pickSubagentModel,
  clearProfileCache,
  TASK_CATEGORIES,
};
