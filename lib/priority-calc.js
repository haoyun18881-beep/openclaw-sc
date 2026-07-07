/**
 * 🦞 sc — 三维优先级计算
 *
 * priority = 紧急度(U) × 0.4 + 重要度(I) × 0.4 + CPU消耗(C) × 0.2
 *
 * 输出：0-10 的分数
 *
 * 参数来源（可根据需要扩展）：
 *   - 紧急度 U: 用户在等回复(10) / 后台任务(1)
 *   - 重要度 I: 核心功能(10) / 锦上添花(1)
 *   - CPU消耗 C: 搜索类(8) / 代码类(2)
 *
 * 按任务类型自动计算默认值，同时支持手动覆盖。
 */

/**
 * 任务类型 → (紧急度, 重要度, CPU消耗) 默认映射
 *
 * 紧急度 U ∈ [1, 10] — 1=完全不急, 10=立刻要
 * 重要度 I ∈ [1, 10] — 1=可做可不做, 10=核心功能
 * CPU消耗 C ∈ [1, 10] — 1=几乎不耗CPU, 10=重度计算
 */
const TYPE_PRIORITY_DEFAULTS = {
  // 用户交互类
  chat:       { urgency: 10, importance: 10, cpuCost: 1, label: '聊天回复' },
  dialog:     { urgency: 10, importance: 9,  cpuCost: 2, label: '对话记忆检索' },

  // 搜索查询类
  search:     { urgency: 7,  importance: 7,  cpuCost: 8,  label: '搜索查询' },
  scan:       { urgency: 6,  importance: 6,  cpuCost: 7,  label: '目录扫描' },
  'semantic-search': { urgency: 7, importance: 7, cpuCost: 9, label: '语义搜索' },
  'dialog-recall': { urgency: 8, importance: 7, cpuCost: 6, label: '对话日记检索' },

  // 编解码类
  code:       { urgency: 7,  importance: 8,  cpuCost: 2,  label: '编码任务' },
  'code-edit': { urgency: 7, importance: 8,  cpuCost: 3,  label: '代码编辑' },
  'code-review': { urgency: 6, importance: 7, cpuCost: 3, label: '代码审查' },
  'bug-fix':  { urgency: 8,  importance: 9,  cpuCost: 4,  label: 'Bug修复' },

  // 分析类
  analysis:   { urgency: 6,  importance: 7,  cpuCost: 6,  label: '数据分析' },
  research:   { urgency: 6,  importance: 8,  cpuCost: 7,  label: '深度调研' },
  orchestrate: { urgency: 7, importance: 8,  cpuCost: 5,  label: '任务编排' },
  diagnose:   { urgency: 7,  importance: 8,  cpuCost: 5,  label: '系统诊断' },
  diff:       { urgency: 5,  importance: 6,  cpuCost: 4,  label: '差异分析' },
  'process-log': { urgency: 6, importance: 6, cpuCost: 5, label: '日志分析' },

  // 系统管理类
  system:     { urgency: 6,  importance: 7,  cpuCost: 3,  label: '系统管理' },
  sync:       { urgency: 5,  importance: 6,  cpuCost: 4,  label: '同步任务' },
  stats:      { urgency: 4,  importance: 5,  cpuCost: 2,  label: '状态查询' },
  config:     { urgency: 5,  importance: 6,  cpuCost: 2,  label: '配置管理' },

  // 批量/调度类
  batch:      { urgency: 7,  importance: 7,  cpuCost: 8,  label: '批量处理' },
  dispatch:   { urgency: 6,  importance: 7,  cpuCost: 4,  label: '任务调度' },

  // 视觉类
  vision:     { urgency: 6,  importance: 7,  cpuCost: 9,  label: '视觉分析' },
  'image-batch': { urgency: 6, importance: 7, cpuCost: 9, label: '图片批量分析' },

  // 运维/维护类
  maintenance: { urgency: 3, importance: 4,  cpuCost: 3,  label: '系统维护' },
  cleanup:    { urgency: 2,  importance: 3,  cpuCost: 2,  label: '清理任务' },
  learn:      { urgency: 1,  importance: 7,  cpuCost: 6,  label: '后台学习' },
  // 🧠 设计决策：sleep-learn 已删除（管理员2026-05-31要求移除后台学习）
  'route-audit': { urgency: 2, importance: 6, cpuCost: 4, label: '路由审计' },

  // 通用兜底
  general:    { urgency: 5,  importance: 5,  cpuCost: 5,  label: '通用任务' },
};

/**
 * 计算三维优先级
 *
 * @param {string} type - 任务类型（如 'search', 'code', 'system'）
 * @param {Object} [overrides] - 手动覆盖 { urgency?, importance?, cpuCost? }
 * @returns {Promise<number>} 0-10 的优先级分数
 */
export async function calculatePriority(type, overrides = {}) {
  const defaults = TYPE_PRIORITY_DEFAULTS[type] || TYPE_PRIORITY_DEFAULTS.general;

  const urgency = overrides?.urgency !== undefined ? overrides.urgency : defaults.urgency;
  const importance = overrides?.importance !== undefined ? overrides.importance : defaults.importance;
  const cpuCost = overrides?.cpuCost !== undefined ? overrides.cpuCost : defaults.cpuCost;

  // 确保范围 [1, 10]
  const u = Math.max(1, Math.min(10, Number(urgency) || 5));
  const i = Math.max(1, Math.min(10, Number(importance) || 5));
  const c = Math.max(1, Math.min(10, Number(cpuCost) || 5));

  // priority = U × 0.4 + I × 0.4 + C × 0.2
  const priority = Math.round((u * 0.4 + i * 0.4 + c * 0.2) * 10) / 10;

  // 钳制到 [0, 10]
  return Math.max(0, Math.min(10, priority));
}

/**
 * 获取任务类型的默认三维参数
 * @param {string} type
 * @returns {Object} { urgency, importance, cpuCost, label }
 */
export function getTypeDefaults(type) {
  return { ...(TYPE_PRIORITY_DEFAULTS[type] || TYPE_PRIORITY_DEFAULTS.general) };
}

/**
 * 获取所有任务类型默认参数
 * @returns {Object}
 */
export function getAllTypeDefaults() {
  return { ...TYPE_PRIORITY_DEFAULTS };
}

/**
 * 获取优先级等级标签
 * @param {number} score - 0-10
 * @returns {string}
 */
export function getPriorityLabel(score) {
  if (score >= 9) return '紧急';
  if (score >= 7) return '高优先';
  if (score >= 5) return '中优先';
  if (score >= 3) return '低优先';
  return '空闲';
}

export default {
  calculatePriority,
  getTypeDefaults,
  getAllTypeDefaults,
  getPriorityLabel,
};
