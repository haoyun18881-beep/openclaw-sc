/**
 * 🦞 sc — L5+ 任务自动分解（任务递归分解 + DAG 流水线）
 *
 * Worker E（route-decompose）：在双树评估的大树阶段运行。
 *
 * 设计理念：
 *   1. 分解原本：L5+ 复杂任务自动拆解为子步骤链
 *   2. 工具推断：每步根据 action/描述自动匹配最佳工具
 *   3. DAG 构建：建立依赖edges，L5串行/L6并行发现/L7全DAG
 *   4. Pipeline 输出：输出可直接喂入 stagePipeline 的格式
 *   5. 独立熔断：每步独立超时、独立结果文件、独立retry
 *   6. 共享消费：结果写入 shared/decomposed/，Worker 并行处理
 *
 * v2 — 2026-05-31 重新实现（修复：步骤文件写入、toolInfo 传递、DAG 工具感知）
 */

import crypto from "crypto";
import { join } from "path";
import { mkdir, writeFile, rename, readFile, unlink } from "fs/promises";
import { SHARED_DIR } from './constants.js';

// ====== 常量 ======

const DECOMPOSED_DIR = join(SHARED_DIR, 'decomposed');

// ====== 步骤 → 工具推断映射 ======
// 根据 action 标签或描述关键词推断最佳推荐工具
// 返回 { tool: string, mode: 'pool'|'exec', timeoutMs: number, retryMax: number }
// 🧠 设计决策：ACTION_TOOL_MAP 的超时（timeoutMs）和retry（retryMax）值不是随意定的。
//   搜索/获取类（timeoutMs=30000, retryMax=2）：网络I/O最不确定，给30s+2次retry够
//     应对 DNS 超时、TCP 重传、API 限速等瞬态故障。retry2次而不是3次：第三次之前换路。
//   分析/编排类（timeoutMs=60000, retryMax=1）：core_orchestrate 要排子任务，
//     典型耗时 15-45s，60s是合理超时。retryMax=1 是因为编排不是幂等的，重复执行
//     可能产生不同结果，retry1次足够覆盖临时问题的同时避免结果不一致。
//   编码/修复类（timeoutMs=60000-90000, retryMax=2）：代码编辑需要模型调用+
//     文件写入+语法验证，典型 20-40 s。retryMax=2 是因为这种操作失败后retry通常成功
//     （临时文件锁释放、Ollama 负载下降后retry生效）。
//   系统运维类（timeoutMs=120000, retryMax=1）：安装/部署最慢（下载文件、等待安装完成），
//     给2min足够。retryMax=1 是因为系统操作失败通常不可恢复（网络不行、磁盘满了），
//     retry多次无意义。
//   兜底 spawn_subagent（timeoutMs=120000, retryMax=0）：子 agent 有独立超时和熔断，
//     父步骤不需要retry它。
//   超时 = 工具平均耗时 × 2（缓冲区） + 网络/序列化开销(5-10s)
//   retry = 幂等性越高可retry越多：搜索类(2) > 编码类(2) > 编排类(1) > 系统类(1) > 子agent(0)

const ACTION_TOOL_MAP = {
  // ★ 搜索/调研类
  '搜索':    { tool: 'tavily_search',          mode: 'pool', timeoutMs: 30000, retryMax: 2 },
  '调研':    { tool: 'core_research',           mode: 'pool', timeoutMs: 60000, retryMax: 1 },
  '研究':    { tool: 'core_research',           mode: 'pool', timeoutMs: 60000, retryMax: 1 },
  '查找':    { tool: 'core_search',             mode: 'pool', timeoutMs: 30000, retryMax: 2 },

  // ★ 获取/提取类
  '获取':    { tool: 'web_fetch',              mode: 'pool', timeoutMs: 30000, retryMax: 2 },
  '提取':    { tool: 'tavily_extract',         mode: 'pool', timeoutMs: 30000, retryMax: 2 },
  '爬取':    { tool: 'web_fetch',              mode: 'pool', timeoutMs: 45000, retryMax: 2 },

  // ★ 分析/评估/对比类
  '分析':    { tool: 'core_orchestrate',        mode: 'pool', timeoutMs: 60000, retryMax: 1 },
  '评估':    { tool: 'core_orchestrate',        mode: 'pool', timeoutMs: 60000, retryMax: 1 },
  '对比':    { tool: 'core_diff',               mode: 'pool', timeoutMs: 30000, retryMax: 1 },
  '比较':    { tool: 'core_orchestrate',        mode: 'pool', timeoutMs: 45000, retryMax: 1 },

  // ★ 设计/规划类
  '设计':    { tool: 'core_orchestrate',        mode: 'pool', timeoutMs: 60000, retryMax: 1 },
  '规划':    { tool: 'core_orchestrate',        mode: 'pool', timeoutMs: 60000, retryMax: 1 },
  '方案':    { tool: 'core_orchestrate',        mode: 'pool', timeoutMs: 60000, retryMax: 1 },

  // ★ 编码/实现类
  '实现':    { tool: 'core_codeEdit',           mode: 'pool', timeoutMs: 60000, retryMax: 2 },
  '编写':    { tool: 'core_codeEdit',           mode: 'pool', timeoutMs: 60000, retryMax: 2 },
  '编码':    { tool: 'core_codeEdit',           mode: 'pool', timeoutMs: 60000, retryMax: 2 },
  '修改':    { tool: 'core_bugFix',             mode: 'pool', timeoutMs: 60000, retryMax: 2 },
  '修复':    { tool: 'core_bugFix',             mode: 'pool', timeoutMs: 60000, retryMax: 2 },
  '重构':    { tool: 'core_codeEdit',           mode: 'pool', timeoutMs: 90000, retryMax: 2 },

  // ★ 测试/验证类
  '测试':    { tool: 'core_bugFix',             mode: 'pool', timeoutMs: 60000, retryMax: 2 },
  '验证':    { tool: 'core_orchestrate',        mode: 'pool', timeoutMs: 45000, retryMax: 1 },

  // ★ 整理/汇总/生成类
  '整理':    { tool: 'core_orchestrate',        mode: 'pool', timeoutMs: 45000, retryMax: 1 },
  '汇总':    { tool: 'core_orchestrate',        mode: 'pool', timeoutMs: 45000, retryMax: 1 },
  '生成':    { tool: 'core_orchestrate',        mode: 'pool', timeoutMs: 60000, retryMax: 1 },

  // ★ 部署/系统类
  '部署':    { tool: 'core_systemRun',          mode: 'pool', timeoutMs: 120000, retryMax: 1 },
  '安装':    { tool: 'core_systemRun',          mode: 'pool', timeoutMs: 120000, retryMax: 1 },
  '同步':    { tool: 'core_workspaceSync',      mode: 'pool', timeoutMs: 60000, retryMax: 2 },

  // ★ 日记/记忆类
  '回顾':    { tool: 'core_dialogRecall',       mode: 'pool', timeoutMs: 30000, retryMax: 2 },
  '回忆':    { tool: 'core_dialogRecall',       mode: 'pool', timeoutMs: 30000, retryMax: 2 },
  '检索':    { tool: 'core_semanticSearch',     mode: 'pool', timeoutMs: 45000, retryMax: 1 },

  // ★ 兜底
  '完整':    { tool: 'spawn_subagent',         mode: 'pool', timeoutMs: 120000, retryMax: 0 },
};

// 描述关键词 → 工具的映射（当 action 不匹配时作为兜底）
const DESCRIPTION_KEYWORD_MAP = [
  { pattern: /搜索|查找|搜素|查.*资料|查.*信息/i,       tool: 'tavily_search',       mode: 'pool', timeoutMs: 30000 },
  { pattern: /打开.*网页|访问.*网站|fetch|爬取/i,          tool: 'web_fetch',           mode: 'pool', timeoutMs: 30000 },
  { pattern: /提取|抽取|解析.*内容/i,                     tool: 'tavily_extract',      mode: 'pool', timeoutMs: 30000 },
  { pattern: /分析|评估|判断|评价/i,                       tool: 'core_orchestrate',     mode: 'pool', timeoutMs: 60000 },
  { pattern: /对比|比较|diff|差异|区别/i,                   tool: 'core_diff',            mode: 'pool', timeoutMs: 30000 },
  { pattern: /设计|方案|架构|规划/i,                       tool: 'core_orchestrate',     mode: 'pool', timeoutMs: 60000 },
  { pattern: /编码|编写|写代码|实现|开发|修改|编辑/i,      tool: 'core_codeEdit',        mode: 'pool', timeoutMs: 60000 },
  { pattern: /修复|修|改bug|bug|fix/i,                     tool: 'core_bugFix',          mode: 'pool', timeoutMs: 60000 },
  { pattern: /测试|验证|检查.*结果|确认/i,                  tool: 'core_orchestrate',     mode: 'pool', timeoutMs: 45000 },
  { pattern: /整理|汇总|总结|输出|报告|生成/i,            tool: 'core_orchestrate',     mode: 'pool', timeoutMs: 45000 },
  { pattern: /部署|发布|安装|下载|同步/i,                   tool: 'core_systemRun',       mode: 'pool', timeoutMs: 120000 },
  { pattern: /日记|回忆|历史|之前|回顾/i,                  tool: 'core_dialogRecall',    mode: 'pool', timeoutMs: 30000 },
  { pattern: /调研|研究|调查|了解|打听/i,                  tool: 'core_research',        mode: 'pool', timeoutMs: 60000 },
];

/**
 * 根据步骤的 action 和描述推断最佳工具
 * @param {string} description - 步骤描述
 * @param {string} [action] - 步骤 action 标签
 * @returns {{ tool: string, mode: string, timeoutMs: number, retryMax: number }}
 */
function inferStepTool(description, action) {
  // 1. 优先按 action 标签匹配
  if (action && ACTION_TOOL_MAP[action]) {
    return { ...ACTION_TOOL_MAP[action] };
  }

  // 2. 按描述关键词匹配
  for (const rule of DESCRIPTION_KEYWORD_MAP) {
    if (rule.pattern.test(description)) {
      return { tool: rule.tool, mode: rule.mode, timeoutMs: rule.timeoutMs, retryMax: 1 };
    }
  }

  // 3. 兜底：spawn subagent
  return { tool: 'spawn_subagent', mode: 'pool', timeoutMs: 120000, retryMax: 0 };
}

/**
 * 判断两个步骤能否并行执行（工具感知版）
 *
 * v2: 使用 toolInfo 中的工具名做更精确的并行判断
 *
 * 规则：
 *   1. 两个搜索类工具可并行
 *   2. 两个分析类工具（主题不同）可并行
 *   3. 搜索+分析可部分并行
 *   4. 生成/实现在搜索之前不能并行
 *   5. L5 不做并行检测（严格串行），L6 开始支持
 *
 * @param {object} stepA - 前一步（必须有 toolInfo 字段）
 * @param {object} stepB - 后一步（必须有 toolInfo 字段）
 * @returns {boolean} 可并行
 */
function canParallel(stepA, stepB) {
  // 获取工具名
  const toolA = stepA.toolInfo?.tool || stepA.tool || 'spawn_subagent';
  const toolB = stepB.toolInfo?.tool || stepB.tool || 'spawn_subagent';

  // 搜索类工具（只读，互不依赖）
  const searchTools = ['tavily_search', 'core_search', 'core_research', 'core_dialogRecall', 'core_semanticSearch'];
  // 提取类工具（只读，需要独立 URL/文件）
  const fetchTools = ['web_fetch', 'tavily_extract'];
  // 分析类工具（中等开销）
  const analyticTools = ['core_orchestrate', 'core_diff', 'core_codeReview', 'core_diagnose'];
  // 生产类工具（写入，需要前置依赖）
  const productiveTools = ['core_codeEdit', 'core_bugFix', 'core_workspaceSync', 'core_systemRun'];

  // 两个搜索类 → 可并行
  if (searchTools.includes(toolA) && searchTools.includes(toolB)) return true;

  // 搜索+提取 → 可并行（互不依赖）
  if (searchTools.includes(toolA) && fetchTools.includes(toolB)) return true;
  if (fetchTools.includes(toolA) && searchTools.includes(toolB)) return true;

  // 两个分析类（主题不同）→ 可并行
  if (analyticTools.includes(toolA) && analyticTools.includes(toolB)) {
    // 检查描述是否有大量重叠关键词
    const descA = (stepA.description || '').substring(0, 30);
    const descB = (stepB.description || '').substring(0, 30);
    const aTokens = new Set(descA.split(/[\s,，。、]+/).filter(t => t.length > 2));
    const bTokens = new Set(descB.split(/[\s,，。、]+/).filter(t => t.length > 2));
    const overlap = [...aTokens].filter(t => bTokens.has(t)).length;
    return overlap <= 1; // 重合度低 → 不同主题 → 可并行
  }

  // 搜索+分析 → 不可并行（分析依赖搜索结果做输入）
  if (searchTools.includes(toolA) && analyticTools.includes(toolB)) return false;
  if (fetchTools.includes(toolA) && analyticTools.includes(toolB)) return false;

  // 前一个是生产类 → 后一个也生产类 → 不可并行（串行编码）
  if (productiveTools.includes(toolA) && productiveTools.includes(toolB)) return false;

  // 最后一个是验证/汇总 → 依赖前面所有 → 不可并行
  if (toolB === 'core_orchestrate' && (stepB.action === '验证' || stepB.action === '汇总')) return false;

  // 兜底
  return false;
}

/**
 * 从扁平步骤构建 DAG（依赖图）
 *
 * v2: 使用 toolInfo 做工具感知的并行判断
 *
 * @param {Array<{step: number, description: string, action?: string, toolInfo?: object}>} steps - 已富化的步骤
 * @param {string} level - 'L5'|'L6'|'L7'
 * @returns {{ stages: Array<{name: string, dependsOn: string[]}>, adjacency: Map<string, string[]> }}
 */
function buildDAGFromSteps(steps, level) {
  if (steps.length <= 1) {
    return {
      stages: steps.map(s => ({
        name: `step-${s.step}`,
        dependsOn: [],
      })),
      adjacency: new Map(),
    };
  }

  const stageDefs = [];
  const adjacency = new Map();

  if (level === 'L5') {
    // L5：严格串行——每步依赖前一步
    for (let i = 0; i < steps.length; i++) {
      const stageName = `step-${steps[i].step}`;
      adjacency.set(stageName, []);
      stageDefs.push({
        name: stageName,
        dependsOn: i === 0 ? [] : [`step-${steps[i - 1].step}`],
      });
    }
  } else if (level === 'L6') {
    // L6：智能并行——检测可并行的步骤
    stageDefs.push({ name: `step-${steps[0].step}`, dependsOn: [] });
    adjacency.set(`step-${steps[0].step}`, []);

    for (let i = 1; i < steps.length; i++) {
      const prev = steps[i - 1];
      const curr = steps[i];
      const prevName = `step-${prev.step}`;
      const currName = `step-${curr.step}`;

      if (canParallel(prev, curr)) {
        // 可并行：依赖前一步的同级（前前一步，如果存在）
        const prevPrev = i >= 2 ? `step-${steps[i - 2].step}` : null;
        stageDefs.push({
          name: currName,
          dependsOn: prevPrev ? [prevPrev] : [],
        });
        if (prevPrev) {
          const deps = adjacency.get(prevPrev) || [];
          deps.push(currName);
          adjacency.set(prevPrev, deps);
        }
      } else {
        // 不可并行：正常串行依赖
        stageDefs.push({
          name: currName,
          dependsOn: [prevName],
        });
        const deps = adjacency.get(prevName) || [];
        deps.push(currName);
        adjacency.set(prevName, deps);
      }
    }
  } else {
    // L7：全 DAG 模式
    for (let i = 0; i < steps.length; i++) {
      const stageName = `step-${steps[i].step}`;
      adjacency.set(stageName, []);

      if (i === 0) {
        stageDefs.push({ name: stageName, dependsOn: [] });
      } else if (i === steps.length - 1) {
        // 最后一步 → 依赖前面所有步骤（汇总/验证）
        const allPrev = steps.slice(0, -1).map(s => `step-${s.step}`);
        stageDefs.push({ name: stageName, dependsOn: allPrev });
        for (const prev of allPrev) {
          const deps = adjacency.get(prev) || [];
          deps.push(stageName);
          adjacency.set(prev, deps);
        }
      } else {
        const prev = steps[i - 1];
        const curr = steps[i];
        const prevName = `step-${prev.step}`;
        const currName = `step-${curr.step}`;

        if (canParallel(prev, curr)) {
          const prevPrev = i >= 2 ? `step-${steps[i - 2].step}` : null;
          stageDefs.push({
            name: currName,
            dependsOn: prevPrev ? [prevPrev] : [],
          });
          if (prevPrev) {
            const deps = adjacency.get(prevPrev) || [];
            deps.push(currName);
            adjacency.set(prevPrev, deps);
          }
        } else {
          stageDefs.push({
            name: currName,
            dependsOn: [prevName],
          });
          const deps = adjacency.get(prevName) || [];
          deps.push(currName);
          adjacency.set(prevName, deps);
        }
      }
    }
  }

  return { stages: stageDefs, adjacency };
}

/**
 * 构建分步结果文件路径列表
 * 每个步骤对应一个独立的结果文件，支持独立熔断
 *
 * @param {string} taskId
 * @param {number} totalSteps
 * @returns {string[]} 各步骤的文件路径
 */
function buildStepResultPaths(taskId, totalSteps) {
  const paths = [];
  for (let i = 1; i <= totalSteps; i++) {
    paths.push(join(DECOMPOSED_DIR, `${taskId}-step${i}.result.json`));
  }
  return paths;
}

/**
 * 将分解结果转换为 stagePipeline 兼容的流水线定义
 *
 * v2: 使用已富化的 steps（含 toolInfo），每步带独立超时、结果文件、熔断配置。
 *       pipeline 阶段使用 exec 模式，命令格式为：
 *         node <decomposed-runner> <decomposedDir> <taskId> <stepN>
 *       每个阶段读取 shared/decomposed/{taskId}-step{N}.json 中的步骤文件并执行。
 *
 * @param {string} taskText - 原始任务文本
 * @param {string} level - 'L5'|'L6'|'L7'
 * @param {Array<{step: number, description: string, action?: string, toolInfo?: object}>} steps - 已富化的步骤列表
 * @returns {object} pipelineDef — 可直接喂入 runPipeline 或 core_stagePipeline
 */
function stepsToPipeline(taskText, level, steps) {
  // 步骤必须有 toolInfo，若缺失则补充
  const enrichedSteps = steps.map(s => ({
    ...s,
    toolInfo: s.toolInfo || inferStepTool(s.description, s.action),
  }));

  const { stages: dagStages } = buildDAGFromSteps(enrichedSteps, level);
  const taskId = genTaskId(taskText);
  const resultPaths = buildStepResultPaths(taskId, enrichedSteps.length);

  // 给每步分配 pipeline 阶段定义
  const pipelineStages = dagStages.map((ds, idx) => {
    const stepDef = enrichedSteps.find(s => `step-${s.step}` === ds.name);
    if (!stepDef) return null;

    const toolInfo = stepDef.toolInfo || inferStepTool(stepDef.description, stepDef.action);
    const stepResultPath = resultPaths[idx] || join(DECOMPOSED_DIR, `${taskId}-step${stepDef.step}.result.json`);

    // 构建 stage 定义（使用 pool 模式，type = decomposed-step）
    // 每个阶段带独立超时、结果文件路径、熔断retry
    return {
      name: ds.name,
      mode: 'pool',
      dependsOn: ds.dependsOn,
      optional: idx < enrichedSteps.length - 1, // 最后一步强制，其余可选
      timeoutMs: (toolInfo.timeoutMs || 60000) + 20000, // 工具超时 + 20s 缓冲
      retry: { max: toolInfo.retryMax || 1, delayMs: 2000 },
      task: {
        type: 'decomposed-exec',      // Worker 需要处理此类型（或在 index.js 中扩展）
        decomposeTaskId: taskId,
        step: stepDef.step,
        totalSteps: enrichedSteps.length,
        description: stepDef.description.substring(0, 200),
        action: stepDef.action || `step-${stepDef.step}`,
        targetTool: toolInfo.tool,
        stepFile: join(DECOMPOSED_DIR, `${taskId}-step${stepDef.step}.json`),
        resultFile: stepResultPath,
        circuitBreaker: { maxRetries: toolInfo.retryMax || 1, delayMs: 2000 },
        timeoutMs: toolInfo.timeoutMs || 60000,
        outputDir: DECOMPOSED_DIR,
      },
    };
  }).filter(Boolean);

  return {
    taskId,
    pipelineDef: {
      name: `任务分解-${taskId}`,
      stages: pipelineStages,
      fallback: level === 'L7' ? 'skip-dependents' : level === 'L6' ? 'skip-dependents' : 'abort',
      params: {
        decomposeTaskId: taskId,
        sourceLevel: level,
        totalSteps: enrichedSteps.length,
        originalTask: taskText.substring(0, 300),
        decomposedDir: DECOMPOSED_DIR,
        resultFilePattern: `${taskId}-step{N}.result.json`,
      },
    },
    dagStages,
    resultPaths,
  };
}

/**
 * Worker E（route-decompose）核心函数
 *
 * 在双树评估的大树阶段运行，对 L5+ 任务进行深度分解。
 * 输出可直接写入 shared/decomposed/ 并由 Worker 并行消费。
 *
 * v2: 1) enrichedSteps 携带 toolInfo 传递到下游
 *     2) 每步写入独立步骤文件（含 tool 和 timeout 信息）
 *     3) 每步结果文件独立（支持独立熔断）
 *     4) pipeline 阶段使用 tool-aware timeout
 *
 * @param {string} taskText - 原始任务文本
 * @returns {Promise<object>} 分解结果
 *   - taskId: string
 *   - decomposed: boolean
 *   - steps: Array<{step, description, action, tool, timeoutMs, retryMax}>
 *   - pipeline: object|null
 *   - filePaths: string[]
 *   - recommendedConcurrency: number
 *   - note: string
 */
async function routeDecompose(taskText) {
  if (!taskText || taskText.length < 5) {
    return {
      taskId: genTaskId(taskText || 'empty'),
      decomposed: false,
      steps: [{ step: 1, description: taskText || '无描述', action: '完整', tool: 'spawn_subagent', timeoutMs: 120000, retryMax: 0 }],
      pipeline: null,
      filePaths: [],
      recommendedConcurrency: 1,
      note: '任务描述过短，无法分解',
    };
  }

  // 1. 快路径：检测任务复杂度（L0-L4 直接跳过分解）
  const complexityPatterns = [
    { min: 5, pattern: /步骤\s*\d|Step\s*\d|第.*步|首先.*然后.*最后|1[.、].*\n\s*2[.、]/i, hint: '显式步骤' },
    { min: 4, pattern: /分析|设计|实现|测试|部署|优化|重构/g, hint: '多行动动词' },
    { min: 3, pattern: /搜索|查找|调研|比较|对比|生成|编写|整理/g, hint: '复合操作' },
  ];

  let complexity = 0;
  for (const rule of complexityPatterns) {
    const matches = taskText.match(rule.pattern);
    if (matches) {
      complexity = Math.max(complexity, rule.min);
      if (Array.isArray(matches)) complexity = Math.max(complexity, matches.length + 2);
    }
  }

  // 简单任务（L0-L4）→ 不分解
  if (complexity < 3) {
    return {
      taskId: genTaskId(taskText),
      decomposed: false,
      steps: [{ step: 1, description: taskText.substring(0, 200), action: '完整', tool: 'spawn_subagent', timeoutMs: 120000, retryMax: 0 }],
      pipeline: null,
      filePaths: [],
      recommendedConcurrency: 1,
      note: '任务复杂度较低（L0-L4），无需分解',
      complexity,
    };
  }

  // 2. 复杂任务 → 完整分解
  const level = complexity >= 7 ? 'L7' : complexity >= 5 ? 'L6' : 'L5';
  const { taskId, steps } = decomposeTask(taskText, level);

  if (steps.length <= 1) {
    return {
      taskId,
      decomposed: false,
      steps: [{ step: 1, description: taskText.substring(0, 200), action: '完整', tool: 'spawn_subagent', timeoutMs: 120000, retryMax: 0 }],
      pipeline: null,
      filePaths: [],
      recommendedConcurrency: 1,
      note: '分解后仅单步骤，不值得',
      complexity,
    };
  }

  // 3. 为每步分配工具信息（enrich with toolInfo）
  const enrichedSteps = steps.map(s => {
    const toolInfo = inferStepTool(s.description, s.action);
    return {
      step: s.step,
      description: s.description,
      action: s.action || `step-${s.step}`,
      toolInfo, // ★ 传递 toolInfo 到下游
      tool: toolInfo.tool,
      mode: toolInfo.mode,
      timeoutMs: toolInfo.timeoutMs,
      retryMax: toolInfo.retryMax,
    };
  });

  // 4. 写入 shared/decomposed/
  let filePaths = [];
  try {
    filePaths = await writeDecomposedSteps(taskId, enrichedSteps, taskText);
  } catch (err) {
    // write failed不阻塞
  }

  // 5. 构建 pipeline DAG（使用 enrichedSteps 传递 toolInfo）
  const pipeline = stepsToPipeline(taskText, level, enrichedSteps);

  // 6. 计算推荐并发度
  const maxParallel = level === 'L7' ? Math.min(steps.length, 5)
    : level === 'L6' ? Math.min(steps.length, 3)
    : 1;

  // 7. 构建结果步骤列表（不含 toolInfo — 轻量返回给routing system）
  const resultSteps = enrichedSteps.map(s => ({
    step: s.step,
    description: s.description.substring(0, 120),
    action: s.action,
    tool: s.tool,
    timeoutMs: s.timeoutMs,
    retryMax: s.retryMax,
  }));

  return {
    taskId,
    decomposed: true,
    steps: resultSteps,
    pipeline,
    filePaths,
    recommendedConcurrency: maxParallel,
    complexity,
    level,
    note: `✅ 任务分解成功: ${taskId} → ${steps.length} 步骤 (${level}, 复杂度=${complexity})`,
  };
}

// ====== 原有函数（保留） ======

/**
 * 确保 decomposed 目录存在
 */
async function ensureDecomposedDir() {
  try { await mkdir(DECOMPOSED_DIR, { recursive: true }); } catch {}
}

/**
 * 从任务文本生成稳定 taskId
 */
function genTaskId(text) {
  const hash = crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
  return hash.substring(0, 12);
}

/**
 * 拆解任务描述为子步骤
 *
 * 策略（优先级递减）:
 *   A. 步骤N: / Step N: / 第N步: / N:（行首或前有空格）
 *   B. 编号列表 1.xxx / 1、xxx
 *   C. 首先…然后…接着…最后
 *   D. 行动动词（行首或分隔符后）
 *   E. 自然段落换行（≥3行）
 *   F. 兜底
 */
function decomposeTask(taskText, level) {
  const steps = [];

  // ------ 策略 A：步骤N / Step N / 第N步 / 编号+冒号 ------
  // A1: 步骤N:内容 / Step N:内容 / 第N步:内容
  let matches = [];
  let m;
  const a1 = /(?:步骤|step|第)[\s　]*(\d+)[\s　]*[:：]\s*([^\n]+?)(?=\s*(?:步骤|\d{1,2}\s*[:：．.])|\s*$)/gi;
  while ((m = a1.exec(taskText)) !== null) {
    const desc = m[2].trim();
    if (desc.length > 2) matches.push({ step: parseInt(m[1]), description: desc });
  }
  if (matches.length >= 2) { steps.push(...matches); }

  // A2: 内联编号列表
  if (steps.length < 2) {
    matches = [];
    const a2 = /(?:^|[\s　,，;：；])(\d{1,2})\s*[:：．.]\s*([^\n]+?)(?=\s*\d{1,2}\s*[:：．.]|\n|\s*$)/g;
    while ((m = a2.exec(taskText)) !== null) {
      const desc = m[2].trim();
      if (desc.length > 3) matches.push({ step: parseInt(m[1]), description: desc });
    }
    if (matches.length >= 2) steps.push(...matches);
  }

  // ------ 策略 B：编号列表（行首 1.xxx） ------
  if (steps.length < 2) {
    matches = [];
    const b1 = /(?:^|\n)[\s　]*(\d+)[.、．]\s*([^\n]{4,})/g;
    while ((m = b1.exec(taskText)) !== null) {
      const desc = m[2].trim();
      if (desc.length > 3 && !/^\d/.test(desc)) {
        matches.push({ step: parseInt(m[1]), description: desc });
      }
    }
    if (matches.length >= 2) steps.push(...matches);
  }

  // ------ 策略 C：首先…然后…接着…最后 ------
  if (steps.length < 2) {
    const seqPat = /(?:首先|最先|先(?!生))[：:，,\s　]*([^。\n]{4,})/i;
    const thenPat = /(?:然后|接着|之后|随后|其次|接下来|下一步|再(?!次))[：:，,\s　]*([^。\n]{4,})/gi;
    const finallyPat = /(?:最后|最终|末尾|收尾)[：:，,\s　]*([^。\n]{4,})/i;

    const firstMatch = seqPat.exec(taskText);
    const thenMatches = [];
    const finallyMatch = finallyPat.exec(taskText);

    let tm;
    while ((tm = thenPat.exec(taskText)) !== null) {
      const desc = tm[1].trim();
      if (desc.length > 3) thenMatches.push(desc);
    }

    let stepCounter = 0;
    if (firstMatch && firstMatch[1].trim().length > 3) {
      steps.push({ step: ++stepCounter, description: firstMatch[1].trim(), action: '先' });
    }
    for (const desc of thenMatches) {
      if (stepCounter < 10) steps.push({ step: ++stepCounter, description: desc, action: '然后' });
    }
    if (finallyMatch && finallyMatch[1].trim().length > 3) {
      steps.push({ step: ++stepCounter, description: finallyMatch[1].trim(), action: '最后' });
    }
  }

  // ------ 策略 D：行动动词 ------
  if (steps.length < 2) {
    const actionPatterns = [
      /(?:^|[\s　,，;：；。])(分析)[：:，,\s　]*([^\n,，;；。]{4,})/g,
      /(?:^|[\s　,，;：；。])(评估)[：:，,\s　]*([^\n,，;；。]{4,})/g,
      /(?:^|[\s　,，;：；。])(设计)[：:，,\s　]*([^\n,，;；。]{4,})/g,
      /(?:^|[\s　,，;：；。])(实现)[：:，,\s　]*([^\n,，;；。]{4,})/g,
      /(?:^|[\s　,，;：；。])(测试)[：:，,\s　]*([^\n,，;；。]{4,})/g,
      /(?:^|[\s　,，;：；。])(部署)[：:，,\s　]*([^\n,，;；。]{4,})/g,
      /(?:^|[\s　,，;：；。])(优化)[：:，,\s　]*([^\n,，;；。]{4,})/g,
      /(?:^|[\s　,，;：；。])(重构)[：:，,\s　]*([^\n,，;；。]{4,})/g,
      /(?:^|[\s　,，;：；。])(编写)[：:，,\s　]*([^\n,，;；。]{4,})/g,
      /(?:^|[\s　,，;：；。])(生成)[：:，,\s　]*([^\n,，;；。]{4,})/g,
    ];

    const actionMatches = new Map();
    let order = 0;
    for (const pat of actionPatterns) {
      while ((m = pat.exec(taskText)) !== null) {
        const action = m[1];
        const desc = m[2].trim();
        if (desc.length > 3 && !actionMatches.has(desc)) {
          actionMatches.set(desc, { order: order++, description: desc, action });
        }
      }
    }

    if (actionMatches.size >= 2) {
      const sorted = [...actionMatches.values()].sort((a, b) => a.order - b.order);
      sorted.forEach((item, idx) => {
        steps.push({ step: idx + 1, description: item.description, action: item.action });
      });
    }
  }

  // ------ 策略 E：按自然段落换行（≥3行） ------
  if (steps.length < 2) {
    const lines = taskText.split('\n')
      .map(l => l.trim())
      .filter(l => {
        if (l.length < 6) return false;
        if (/^(?:🏃|思考|模式|⚡|#|---)/.test(l)) return false;
        if (/^(?:任务|步骤|输出|验收|结果)[：:]/.test(l)) return false;
        return true;
      });

    if (lines.length >= 3) {
      lines.slice(0, 10).forEach((line, idx) => {
        steps.push({ step: idx + 1, description: line.substring(0, 200) });
      });
    }
  }

  // ------ 策略 F：兜底 ------
  if (steps.length === 0) {
    const clean = taskText
      .replace(/^.*?任务[：:]/s, '')
      .replace(/\n⚡.*/s, '')
      .replace(/\n---.*/s, '')
      .trim()
      .substring(0, 300);
    steps.push({ step: 1, description: clean || '执行完整任务', action: '完整' });
  }

  const finalSteps = steps.slice(0, 10);
  if (level === 'L7' && finalSteps.length < 3) {
    finalSteps.push({ step: finalSteps.length + 1, description: '验证整体结果并输出最终报告', action: '验证' });
  }

  if (finalSteps.length >= 2) {
    for (const s of finalSteps) {
      if (!s.action) {
        const stepAction = s.description.match(/^(搜索|查找|调研|获取|提取|爬取|分析|评估|对比|比较|设计|规划|方案|实现|编写|编码|修改|修复|重构|测试|验证|部署|安装|同步|回顾|回忆|检索|整理|汇总|生成|研究)/);
        s.action = stepAction ? stepAction[1] : `step-${s.step}`;
      }
    }
  }

  return { taskId: genTaskId(taskText), steps: finalSteps };
}

/**
 * 将分解后的步骤写入 shared/decomposed/ 目录
 *
 * v2: 步骤文件包含完整的 toolInfo、timeout、resultFile 字段
 *      供 Worker 或子 agent 读取后直接执行
 *
 * @param {string} taskId
 * @param {Array<{step: number, description: string, action?: string, toolInfo?: object, tool?: string, timeoutMs?: number, retryMax?: number}>} steps - 已富化的步骤
 * @param {string} sourceTask
 * @returns {Promise<string[]>} 写入的文件路径列表
 */
async function writeDecomposedSteps(taskId, steps, sourceTask) {
  await ensureDecomposedDir();
  const written = [];

  for (const s of steps) {
    const fileName = `${taskId}-step${s.step}.json`;
    const resultFileName = `${taskId}-step${s.step}.result.json`;
    const filePath = join(DECOMPOSED_DIR, fileName);
    const resultFilePath = join(DECOMPOSED_DIR, resultFileName);

    // 从 toolInfo 提取工具的详细配置
    const toolInfo = s.toolInfo || inferStepTool(s.description, s.action);

    // ★ 完整的步骤定义：包含独立超时、结果文件、熔断配置
    const payload = {
      decomposedTaskId: taskId,
      step: s.step,
      totalSteps: steps.length,
      description: s.description,
      action: s.action || `step-${s.step}`,
      parentTask: sourceTask.substring(0, 100),
      timestamp: Date.now(),

      // ★ 新增：独立执行配置
      tool: toolInfo.tool,
      mode: toolInfo.mode,
      timeoutMs: toolInfo.timeoutMs || 60000,
      retryMax: toolInfo.retryMax || 1,
      resultFile: resultFilePath,
      circuitBreaker: {
        maxRetries: toolInfo.retryMax || 1,
        delayMs: 2000,
      },
    };

    const tmpPath = filePath + '.tmp';
    await writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
    await rename(tmpPath, filePath);

    written.push(filePath);
  }

  return written;
}

// ====== 新增：读取已分解的步骤文件 ======

/**
 * 读取 shared/decomposed/ 目录中的已分解步骤文件
 * 供 Worker 或子 agent 读取并执行
 *
 * @param {string} taskId
 * @param {number} step
 * @returns {Promise<object|null>} 步骤定义或 null
 */
async function readDecomposedStep(taskId, step) {
  const fileName = `${taskId}-step${step}.json`;
  const filePath = join(DECOMPOSED_DIR, fileName);
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * 列出指定 taskId 的所有分解步骤
 *
 * @param {string} taskId
 * @returns {Promise<Array<{step: number, description: string, tool: string, timeoutMs: number}>>}
 */
async function listDecomposedSteps(taskId) {
  try {
    const files = await import('fs/promises').then(fs => fs.readdir(DECOMPOSED_DIR));
    const stepFiles = files
      .filter(f => f.startsWith(taskId) && f.endsWith('.json') && !f.endsWith('.result.json'))
      .sort();
    const steps = [];
    for (const f of stepFiles) {
      try {
        const content = await readFile(join(DECOMPOSED_DIR, f), 'utf-8');
        const data = JSON.parse(content);
        steps.push({
          step: data.step,
          description: data.description,
          tool: data.tool,
          timeoutMs: data.timeoutMs,
          action: data.action,
          resultFile: data.resultFile,
        });
      } catch {}
    }
    return steps.sort((a, b) => a.step - b.step);
  } catch {
    return [];
  }
}

/**
 * 写入某步骤的执行结果
 * 每步独立结果文件，支持独立熔断
 *
 * @param {string} taskId
 * @param {number} step
 * @param {object} result - { status: 'success'|'error'|'timeout', output?, error?, durationMs }
 * @returns {Promise<string|null>}
 */
async function writeStepResult(taskId, step, result) {
  await ensureDecomposedDir();
  const fileName = `${taskId}-step${step}.result.json`;
  const filePath = join(DECOMPOSED_DIR, fileName);
  const payload = {
    decomposedTaskId: taskId,
    step,
    result,
    timestamp: Date.now(),
  };
  const tmpPath = filePath + '.tmp';
  try {
    await writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
    await rename(tmpPath, filePath);
    return filePath;
  } catch {
    return null;
  }
}

/**
 * 读取某步骤的执行结果
 *
 * @param {string} taskId
 * @param {number} step
 * @returns {Promise<object|null>}
 */
async function readStepResult(taskId, step) {
  const fileName = `${taskId}-step${step}.result.json`;
  const filePath = join(DECOMPOSED_DIR, fileName);
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// ====== 导出 ======

export {
  decomposeTask,
  writeDecomposedSteps,
  DECOMPOSED_DIR,
  ensureDecomposedDir,
  genTaskId,
  inferStepTool,
  buildDAGFromSteps,
  stepsToPipeline,
  routeDecompose,
  readDecomposedStep,
  listDecomposedSteps,
  writeStepResult,
  readStepResult,
};
