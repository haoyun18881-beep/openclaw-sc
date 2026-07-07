/**
 * 🦞 sc — L0-L7 复杂度分级规则 & 工具路由映射
 *
 * 从 workers/worker.js 和 scripts/task-router.js（已删除）提取的共享常量，
 * 避免两份副本因维护不同步产生分歧。
 *
 * LEVEL_TOOL_MAP（工具路由映射）与 getLevelConfig()（子agent执行配置）不同，
 * 前者用于 Worker 池工具路由，后者用于子 agent spawn 配置，各司其职无需一致。
 */

// ====== L0-L7 复杂度分级规则 ======
export const LEVEL_RULES = [
  { level: 'L0', weight: 1.0, patterns: [
    /打包|压缩|复制|重命名|备份|解压|创建.*(文件|目录)/i,
    /copy|zip|compress|backup|rename|mkdir|delete/i,
    /移到桌面|放到桌面|存到桌面/i,
    /\.zip|\.tar|\.gz|\.7z/,
  ]},
  { level: 'L1', weight: 0.9, patterns: [
    /查.*版本|读.*文件|看.*目录|有没有|是否存在/i,
    /多大|多长|多少行|什么时间|什么时候/i,
    /version|exist|check|stat|list.*file|head/i,
    /cat |head |tail |wc /i,
  ]},
  { level: 'L2', weight: 0.85, patterns: [
    /搜索|查找|找到|搜一下|找一下|看看.*有没有/i,
    /search|find|look for|get.*info|tell me about/i,
  ]},
  { level: 'L3', weight: 0.75, patterns: [
    /代码审查|审查代码|review.*code|check.*code/i,
    /简单.*分析|快速.*分析|看一下.*代码|看下.*代码/i,
    /fix|修复|修一下/,
  ]},
  { level: 'L4', weight: 0.7, patterns: [
    /分析|审查|审计|评估|比较|对比|研究|调研/i,
    /analyze|review|audit|evaluate|compare|research/i,
    /架构|设计|方案|优化|重构/i,
    /architecture|design|refactor|optimize/i,
    /performance|security|memory leak|bug/i,
  ]},
  { level: 'L5', weight: 0.6, decompose: true, patterns: [
    /对比.*方案|多角度|多方面|全方位|综合/i,
    /竞品|市场|优缺点|pros.*cons|alternative/i,
    /compare|comprehensive|multi.*angle/i,
  ]},
  { level: 'L6', weight: 0.55, decompose: true, patterns: [
    /深度.*研究|全面.*调研|系统.*分析|完整.*报告/i,
    /deep.*research|comprehensive.*analysis|thorough/i,
    /交叉.*验证|多方.*验证|多维.*度/i,
  ]},
  { level: 'L7', weight: 0.5, decompose: true, patterns: [
    /开发.*项目|搭建.*系统|实现.*功能|从零.*构建/i,
    /项目规划|里程碑|roadmap/i,
    /full.*stack|complete.*system/i,
  ]},
];

// ====== L0-L7 级别 → 工具映射（v5.37.0: 映射到11保留工具） ======
export const LEVEL_TOOL_MAP = {
  'L0': { tool: 'core_fileManager', params: { action: 'list' }, conf: 0.95 },
  'L1': { tool: 'core_about', conf: 0.92 },
  'L2': { tool: 'core_memorySearch', conf: 0.88 },
  'L3': { tool: 'core_codeEditor', conf: 0.85 },
  'L4': { tool: 'core_webSearch', conf: 0.82 },
  'L5': { tool: 'core_taskPipeline', conf: 0.80 },
  'L6': { tool: 'core_taskPipeline', conf: 0.78 },
  'L7': { tool: 'core_taskPipeline', conf: 0.75 },
  // 搜索类型路由
  'memory_search': { tool: 'core_memorySearch', conf: 0.95 },
  'web_search':   { tool: 'core_webSearch', conf: 0.95 },
  'dialog_search': { tool: 'core_memorySearch', conf: 0.95 },
};
