/**
 * 🦞 sc — RAG-MCP 动态工具选择器 (Tool Selector)
 *
 * 基于用户任务意图，从全部工具中动态选出最相关的 3-5 个工具。
 * 准确率: 语义检索 RAG-MCP 方案可提升工具选择准确率 3倍 (13.62% → 43.13%)
 * 设计参考: RAG-MCP arXiv 论文 + meta-tool 三级金字塔架构
 *
 * 架构: 三级选择链
 *   Level 1: 关键词 → 域 (keyword-to-domain mapping)
 *   Level 2: 域 → 工具组 (domain-to-tools mapping)
 *   Level 3: 优先级排序 (relevance scoring & ranking)
 */

// ====== 域定义（8个功能域）======
const DOMAINS = {
  SEARCH:   'search',     // 搜索/查找/调研/研究
  CODE:     'code',       // 代码编辑/审查/Bug修复/文件操作
  SYSTEM:   'system',     // 系统诊断/安全/网络/状态
  TASK:     'task',       // 任务调度/编排/并行/子agent
  MEMORY:   'memory',     // 记忆/知识/历史/对话日记
  BRAIN:    'brain',      // 脑域管理/进化/内化/associative cache
  OPS:      'ops',        // 运维/同步/管道/快速执行
  TOOL:     'tool',       // 工具管理/管家/通行证
};

// ====== 域工具映射（动态生成）======
// 不再硬编码！在 cacheAllTools() 时根据工具命名规则自动分配到各域。
// 命名规则：cpu_domain_XXX → 对应域；cpu_XXX → 描述/关键词匹配
let DOMAIN_TOOLS = {}; // 初始为空，buildDynamicDomainTools() 填充

/**
 * 🧬 工具名 → 域的映射规则
 * key=工具名正则, value=子匹配组索引 → 目标域列表
 */
const TOOL_DOMAIN_RULES = [
  // cpu_domain_XXX → XXX 决定域
  { re: /^core_memorySearch$/i,      domains: ['search', 'memory'] },
  { re: /^core_webSearch$/i,      domains: ['search'] },
  { re: /^core_codeEditor$/i,        domains: ['code'] },
  { re: /^core_localScheduler$/i, domains: ['task'] },
  { re: /^core_systemDiag$/i,      domains: ['system', 'ops'] },
  { re: /^core_toolRouter$/i,        domains: ['tool'] },
  // 其他工具 - 按名匹配
  { re: /^core_memoryHub$/i,              domains: ['brain', 'memory'] },
  { re: /^core_taskCenter$/i,         domains: ['task'] },
  { re: /^core_netDiag$/i,           domains: ['system'] },
  { re: /^core_stats$/i,              domains: ['system'] },
  { re: /^core_sysStatus$/i,            domains: ['system'] },
  { re: /^core_batchVision$/i,         domains: ['search', 'code'] }, // 🔧 修正域归类：批量看图更适合search而非system
  { re: /^core_bgService$/i,        domains: ['task', 'ops', 'system'] }, // 🔧 合并重复条目
  { re: /^core_directRun$/i,          domains: ['ops'] },
  { re: /^core_backup$/i,      domains: ['ops'] },
  { re: /^core_emergencyStop$/i,              domains: ['tool'] },
  { re: /^core_auditLog$/i,       domains: ['tool'] },
  { re: /^core_fileManager$/i,            domains: ['code'] },
  { re: /^core_about$/i,           domains: ['tool'] },
  { re: /^core_pickTools$/i,        domains: ['tool'] },
  // 默认兜底：cpu_xxx 按描述关键词匹配
];

/**
 * 从工具描述中提取域关键词
 */
const DESC_DOMAIN_KEYWORDS = [
  { keywords: ['搜索','查找','调研','研究','检索','search','query','find'], domain: 'search' },
  { keywords: ['代码','编辑','审','bug','文件','code','edit','review','file'], domain: 'code' },
  { keywords: ['系统','诊断','网络','安全','状态','资源','system','diagnose','security'], domain: 'system' },
  { keywords: ['任务','调度','编排','并行','子agent','spawn','task','orchestrate'], domain: 'task' },
  { keywords: ['记忆','日记','历史','知识','memory','dialog','history'], domain: 'memory' },
  { keywords: ['脑域','联想','内化','进化','缓存','brain','cache','evolve'], domain: 'brain' },
  { keywords: ['运维','同步','清理','备份','执行','sync','backup','exec'], domain: 'ops' },
  { keywords: ['工具','管家','通行证','管理','tool','steward','abort'], domain: 'tool' },
];

/**
 * 从缓存的工具列表动态构建 DOMAIN_TOOLS
 * 在 cacheAllTools() 后被调用
 */
export function buildDynamicDomainTools() {
  if (!_allToolsMetaCache || _allToolsMetaCache.length === 0) {
    DOMAIN_TOOLS = {};
    return;
  }

  // 初始化所有域
  const allDomains = Object.values(DOMAINS);
  const domainMap = {};
  for (const d of allDomains) domainMap[d] = [];

  for (const tool of _allToolsMetaCache) {
    const name = tool.name;
    const desc = (tool.description || '').toLowerCase();
    let matchedDomains = new Set();

    // 1. 按命名规则匹配
    for (const rule of TOOL_DOMAIN_RULES) {
      if (rule.re.test(name)) {
        for (const d of rule.domains) matchedDomains.add(d);
      }
    }

    // 2. 命名规则没命中时，按描述关键词兜底
    if (matchedDomains.size === 0) {
      for (const rule of DESC_DOMAIN_KEYWORDS) {
        if (rule.keywords.some(kw => name.toLowerCase().includes(kw) || desc.includes(kw))) {
          matchedDomains.add(rule.domain);
        }
      }
    }

    // 3. 还是没命中 → 按 name 中包含的域关键词再扫一遍
    if (matchedDomains.size === 0) {
      // 直接从名字提取：cpu_xxx → xxx 和域名做包含匹配
      const nameLower = name.toLowerCase();
      for (const [domainKey, domainVal] of Object.entries(DOMAINS)) {
        if (nameLower.includes(domainVal)) {
          matchedDomains.add(domainVal);
        }
      }
    }

    // 加入各域
    for (const d of matchedDomains) {
      if (domainMap[d]) {
        domainMap[d].push({
          name,
          priority: domainMap[d].length + 1,
          description: tool.description || name,
          matchedBy: 'auto',
        });
      }
    }
  }

  DOMAIN_TOOLS = domainMap;
}

// ====== 全量工具元信息缓存（供 MCP tools/list 返回使用）======
let _allToolsMetaCache = null;
let _allToolsMap = new Map();

/**
 * 缓存全量工具元信息（由 initSansanCpuTools 填充）
 * @param {Array} toolsMeta - MCP tools/list 返回的工具数组
 */
export function cacheAllTools(toolsMeta) {
  if (!Array.isArray(toolsMeta)) return;
  _allToolsMetaCache = toolsMeta;
  _allToolsMap.clear();
  for (const t of toolsMeta) {
    _allToolsMap.set(t.name, t);
  }
  // 动态构建域工具映射
  buildDynamicDomainTools();
}

/**
 * 获取所有工具元信息
 * @returns {Array}
 */
export function getAllCachedTools() {
  return _allToolsMetaCache || [];
}

/**
 * 获取单个工具元信息
 * @param {string} name
 * @returns {object|null}
 */
export function getToolMeta(name) {
  return _allToolsMap.get(name) || null;
}

// ====== 关键词 → 域映射 ======

/** 域 - 关键词映射表（优先级由高到低） */
const DOMAIN_KEYWORDS = {
  [DOMAINS.SEARCH]: [
    // 高优先级精确匹配
    { pattern: /搜索|查找|查一查|搜一搜|找一找|搜(?![索码])/, weight: 1.0 },
    { pattern: /调研|研究|调查|分析.*问题/, weight: 1.0 },
    // 中优先级
    { pattern: /查|找|搜|看看.*有.*吗|有没有/, weight: 0.7 },
    { pattern: /内容|信息|资料|文件.*找/, weight: 0.5 },
  ],
  [DOMAINS.CODE]: [
    { pattern: /改代码|写代码|修bug|改bug|代码.*审|审.*代码/, weight: 1.0 },
    { pattern: /创建文件|修改文件|编辑文件|重命名|移动文件|删.*文件/, weight: 0.9 },
    { pattern: /代码|文件.*改|改.*文件|git|提交|推送|分支/, weight: 0.8 },
    { pattern: /审查|review|bugfix|修复|优化.*代码/, weight: 0.8 },
  ],
  [DOMAINS.SYSTEM]: [
    { pattern: /系统.*诊断|系统.*状态|系统.*体检/, weight: 1.0 },
    { pattern: /安全|网络|端口|ping|trace|dns/, weight: 0.9 },
    { pattern: /状态|诊断|体检|资源|监控|告警/, weight: 0.7 },
    { pattern: /CPU|内存|磁盘|进程|负载/, weight: 0.6 },
  ],
  [DOMAINS.TASK]: [
    { pattern: /调度|并行|并发|分批|批处理/, weight: 1.0 },
    { pattern: /跑任务|派任务|分配|编排|流水线/, weight: 0.9 },
    { pattern: /子agent|spawn|派子|监控.*子/, weight: 0.8 },
    { pattern: /同时.*做|多个.*任务|批量|队列/, weight: 0.7 },
  ],
  [DOMAINS.MEMORY]: [
    { pattern: /记忆|回忆|记得|之前.*说|之前.*聊/, weight: 1.0 },
    { pattern: /历史|对话.*记录|日记|知识/, weight: 0.9 },
    { pattern: /还记得|上次|学到|学习.*到|记住/, weight: 0.8 },
  ],
  [DOMAINS.BRAIN]: [
    { pattern: /进化|学习.*改进|自我.*优化|内化/, weight: 1.0 },
    { pattern: /脑域|联想|缓存.*查询|模型.*推荐/, weight: 0.8 },
  ],
  [DOMAINS.OPS]: [
    { pattern: /运维|清理|同步|备份|磁盘.*检查/, weight: 1.0 },
    { pattern: /刷新|重置|恢复|重启|维护/, weight: 0.8 },
  ],
  [DOMAINS.TOOL]: [
    { pattern: /工具.*管理|管家|通行证|紧急/, weight: 1.0 },
    { pattern: /暂停|恢复.*主脑|终止.*Worker|abort/, weight: 0.8 },
    { pattern: /API队列|限流|白名单/, weight: 0.6 },
  ],
};

/**
 * 基于任务文本检测匹配的域
 * @param {string} taskText - 用户任务描述
 * @returns {Array<{domain: string, score: number, keywords: string[]}>} 匹配的域列表（按分数降序）
 */
function detectDomains(taskText) {
  if (!taskText || typeof taskText !== 'string') return [];

  const text = taskText.toLowerCase().trim();
  const matched = [];

  for (const [domain, patterns] of Object.entries(DOMAIN_KEYWORDS)) {
    let maxWeight = 0;
    for (const { pattern, weight } of patterns) {
      if (pattern.test(text)) {
        maxWeight = Math.max(maxWeight, weight);
      }
    }
    if (maxWeight > 0) {
      matched.push({ domain, score: maxWeight });
    }
  }

  // 按权重降序
  matched.sort((a, b) => b.score - a.score);
  return matched;
}

/**
 * 从域列表获取推荐工具集（去重+优先级排序）
 * @param {Array<{domain: string, score: number}>} domains
 * @returns {Array<{name: string, priority: number, description: string, domains: string[]}>}
 */
function getToolsFromDomains(domains) {
  const toolMap = new Map(); // name -> { tool, domains: [] }

  for (const { domain } of domains) {
    const domainTools = DOMAIN_TOOLS[domain] || [];
    for (const tool of domainTools) {
      if (toolMap.has(tool.name)) {
        const existing = toolMap.get(tool.name);
        existing.domains.push(domain);
        existing.priority = Math.min(existing.priority, tool.priority);
      } else {
        toolMap.set(tool.name, {
          ...tool,
          domains: [domain],
        });
      }
    }
  }

  // 按优先级排序（priority 越小越靠前）
  const sorted = [...toolMap.values()].sort((a, b) => {
    // 出现在多个域的工具优先
    if (a.domains.length !== b.domains.length) {
      return b.domains.length - a.domains.length;
    }
    return a.priority - b.priority;
  });

  return sorted;
}

/**
 * 主入口：基于任务文本选择最相关的 3-5 个工具
 *
 * @param {string}   taskText - 用户任务文本
 * @param {Array}    [allTools] - 全量工具数组（可选，未传时使用缓存）
 * @param {number}   [maxTools=5] - 最多返回工具数（默认 5）
 * @returns {object} { tools, domains, reasoning, raw }
 *   tools:   筛选后的工具列表（含全量元信息）
 *   domains: 匹配的域
 *   reasoning: 选择理由
 *   raw:     原始全量工具（兜底时包含所有）
 */
export function selectTools(taskText, allTools = null, maxTools = 5) {
  const startTime = Date.now();

  // 使用传入的工具列表或缓存
  const sourceTools = allTools || _allToolsMetaCache || [];
  const toolMetaAvailable = sourceTools.length > 0;

  // 检测意图域
  const domains = detectDomains(taskText);

  // 如果没有任何域匹配 → 返回所有工具（兜底）
  if (domains.length === 0) {
    return {
      tools: sourceTools.slice(0, maxTools),
      domains: [],
      reasoning: '未能识别任务意图，返回默认工具集',
      raw: sourceTools,
      elapsedMs: Date.now() - startTime,
    };
  }

  // 从匹配域获取工具推荐
  const recommended = getToolsFromDomains(domains);

  // 如果有全量元信息，用完整元信息替换推荐工具
  let resultTools;
  if (toolMetaAvailable) {
    const sourceMap = new Map(sourceTools.map(t => [t.name, t]));
    resultTools = recommended
      .map(t => sourceMap.get(t.name) || t)
      .filter(Boolean)
      .slice(0, maxTools);
  } else {
    resultTools = recommended.slice(0, maxTools);
  }

  // 生成选择理由
  const reasoning = domains
    .map(d => `${d.domain}(置信度:${d.score.toFixed(1)})`)
    .join(' → ');

  return {
    tools: resultTools,
    domains: domains.map(d => d.domain),
    reasoning: `检测到意图域: ${reasoning}`,
    raw: sourceTools,
    elapsedMs: Date.now() - startTime,
  };
}

/**
 * 注册为一个 MCP 可调用工具（在主文件中调用）
 * 返回 tool 定义和 handler
 */
export function createSelectToolsToolDef() {
  return {
    name: 'core_pickTools',
    description: '🎯 动态工具选择 — 根据任务描述从sc 30+工具中智能选出最相关的3-5个。调用此工具后，优先使用返回的工具来完成后续任务，不要使用未返回的工具。这是RAG-MCP智能选择机制。',
    inputSchema: {
      type: 'object',
      required: ['task'],
      properties: {
        task: { type: 'string', description: '任务描述文本（如"帮我搜索配置文件中的日志配置"）' },
        maxTools: { type: 'number', description: '最多返回工具数（默认 5，范围 1-8）' },
      },
      additionalProperties: false,
    },
  };
}

/**
 * core_pickTools 的执行函数
 */
export async function handleSelectTools(params) {
  const { task, maxTools } = params || {};
  if (!task) {
    return { status: 'error', message: 'missing task 参数' };
  }

  const max = Math.min(Math.max(maxTools || 5, 1), 8);
  const result = selectTools(task, null, max);

  // 如果没有匹配域但原始工具有 → 返回前 maxTools 个
  if (!result.tools || result.tools.length === 0) {
    const fallbackTools = (_allToolsMetaCache || []).slice(0, max);
    return {
      status: 'info',
      selected: fallbackTools,
      reasoning: '未识别到明确意图域，返回默认工具集',
      hint: '请使用上述工具来完成当前任务',
    };
  }

  return {
    status: 'success',
    intentDomains: result.domains,
    reasoning: result.reasoning,
    selected: result.tools,
    totalAvailable: (_allToolsMetaCache || []).length,
    hint: '请使用上述选中的工具来完成任务，未列出的工具当前场景不适用',
  };
}

/**
 * 生成给 LLM 的系统提示指令
 * @param {string} taskText
 * @returns {string} 提示文本
 */
export function buildToolSelectionPrompt(taskText) {
  if (!taskText) return '';

  const result = selectTools(taskText, null, 5);
  if (!result.tools || result.tools.length === 0) {
    return '';
  }

  const toolList = result.tools
    .map((t, i) => `  ${i + 1}. \`${t.name}\` — ${t.description || t.name}`)
    .join('\n');

  return [
    `🎯 【RAG-MCP 动态工具选择】`,
    `根据当前任务 "${taskText.substring(0, 80)}"，系统建议优先使用以下工具：`,
    '',
    toolList,
    '',
    `📋 理由: ${result.reasoning}`,
    `未在此列表中的工具当前场景不适用，请优先使用上述工具。`,
    `如需要其他工具，请先调用 \`core_pickTools\` 获取推荐。`,
  ].join('\n');
}

// ====== 调试/自测 ======
export function testSelectors() {
  const testCases = [
    '帮我搜索一下配置文件中的数据库连接信息',
    '帮我改一下这个文件名',
    '系统状态怎么样？内存使用率高吗？',
    '同时派三个子agent去搜索不同的关键词',
    '之前我们讨论过关于API网关的配置，你还记得吗？',
    '检查一下代码有没有bug',
    '帮我清理一下日志文件',
    '看看网络能不能ping通百度',
    '你好，今天有什么新功能？',
    '派任务去调研一下市场上的竞品',
  ];

  for (const tc of testCases) {
    const result = selectTools(tc, null, 5);
    // TODO: 移除调试日志 console.log(`\n📝 "${tc.substring(0, 40)}..."`);
    // TODO: 移除调试日志 console.log(`  域: ${result.domains.join(', ') || '无匹配'}`);
    // TODO: 移除调试日志 console.log(`  工具: ${result.tools.map(t => t.name).join(', ')}`);
    // TODO: 移除调试日志 console.log(`  耗时: ${result.elapsedMs}ms`);
  }
}

// 直接在命令行运行测试：node lib/tool-selector.js
if (process.argv[1]?.endsWith('tool-selector.js')) {
  testSelectors();
}
