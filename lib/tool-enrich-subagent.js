/**
 * 🛡️ sc — 子agent任务话术enrichment layer (Subagent Task Enrichment)
 *
 * 功能：在 spawn 子 agent 前调用，给任务描述注入工具推荐。
 *       子 agent 拿到任务后直接看见工具推荐，不用自己瞎猜用什么工具。
 *
 * 设计意图：
 *   子 agent（尤其是低配模型 or thinking=off）经常不知道用什么工具，
 *   靠猜容易选错工具，导致质量差、token浪费。
 *   enrichment layer方案 = 在 spawn 之前「包一层」工具推荐提示，
 *   子 agent 看一眼就知道该用什么，不浪费推理资源。
 *
 * 架构三层：
 *   1. Tcell 缓存层（独立实例，阈值 0.75）— 相同任务指纹命中即返回
 *   2. 小树 routeQuick（Worker 关键词匹配）— 50ms 内快速识别工具
 *   3. 降级层 — 任何异常返回原始 taskText，不阻塞 spawn
 *
 * @module tool-enrich-subagent
 */

import { computeSignature, extractKeywords, createEnrichTcell } from './tcell.js';
import { CORE_TOOLS, TASK_TIMEOUT_MAP } from './constants.js';
import { registerToolTier } from './steward-rules.js';

// ====== 默认兜底候选列表（当小树匹配但置信度 < 0.9 时用）======
// 设计原因：小树匹配一个工具但置信度不够时，不能只给一个候选。
// 用兜底候选表补 2 个近似工具，让子 agent 有选择空间。
// 🔧 Fix-11: 修复已删工具映射，所有 value 指向存在的工具
//   - cpu_orchestrate 已删除（原含禁调工具 core_taskPipeline）
const FALLBACK_CANDIDATES = {
  'core_search': [
    { tool: 'web_search', confidence: 0.7, reason: '网络搜索兜底（本地搜不到时转向网络）' },
    { tool: 'core_webSearch', confidence: 0.6, reason: '网络搜索兜底（cpu_orchestrate不存在，改用core_webSearch）' },
  ],
  'web_search': [
    { tool: 'tavily_search', confidence: 0.7, reason: '高级搜索引擎（精确检索）' },
    { tool: 'web_fetch', confidence: 0.65, reason: '网页内容提取（打开指定链接）' },
  ],
  'core_batch': [
    { tool: 'core_spawnWorker', confidence: 0.7, reason: 'Worker池并行处理（批量任务分派）' },
    { tool: 'core_search', confidence: 0.6, reason: '文件全文搜索（批量读不如精准搜）' },
  ],
  'cpu_dialogRecall': [
    { tool: 'core_memorySearch', confidence: 0.7, reason: '记忆语义搜索（讨论过的话题）' },
    { tool: 'core_search', confidence: 0.55, reason: '文件全文搜索（日记文件内搜索）' },
  ],
  'core_processLog': [
    { tool: 'core_memorySearch', confidence: 0.65, reason: '记忆搜索（日志模式分析检索）' },
    { tool: 'core_search', confidence: 0.55, reason: '文件全文搜索（日志文件内搜索）' },
  ],
  'core_diagnose': [
    { tool: 'core_batchVision', confidence: 0.65, reason: '批量看图诊断（视觉分析兜底）' },
    { tool: 'core_search', confidence: 0.5, reason: '文件搜索（协助定位问题文件）' },
  ],
  'default': [
    { tool: 'core_search', confidence: 0.55, reason: '通用文件搜索（万能兜底）' },
    { tool: 'core_webSearch', confidence: 0.5, reason: '网络搜索（万能兜底）' },
  ],
};

/**
 * 构建话术enrichment layer文本
 * 将工具推荐以追加形式注入原始任务描述
 *
 * 设计意图：不修改原始任务文本结构，只在其后追加一段「enrichment layer推荐」。
 * 子 agent 读到这段就知道该用什么工具、为什么用、备选方案是什么。
 *
 * @param {string} taskText - 原始任务描述
 * @param {Array}  recommendations - 推荐列表 [{tool, confidence, reason}]
 * @param {boolean} fromTcell - 是否来自缓存命中
 * @returns {string} 增强版任务描述（原始文本 + enrichment layer）
 */
function buildEnrichedTask(taskText, recommendations, fromTcell) {
  // 无推荐 → 原样返回，不追加任何内容
  if (!recommendations || recommendations.length === 0 || !recommendations[0]) {
    return taskText;
  }

  const top = recommendations[0];  // 主推荐（最高置信度的工具）

  // 话术enrichment layer格式：\n\n 隔离让子 agent 知道这是系统注入的推荐
  let shieldText = '\n\n【🛡️ 话术enrichment layer — 工具推荐】\n';

  if (fromTcell) {
    // Tcell 缓存命中：高置信度（0.95），直接推荐
    shieldText += `推荐工具: ${top.tool}\n`;
    shieldText += `置信度: 0.95 (缓存命中)\n`;
    shieldText += `建议: 执行此任务时优先使用 ${top.tool}\n`;
  } else {
    // 小树匹配：带理由 + 置信度
    shieldText += `推荐工具: ${top.tool}\n`;
    shieldText += `置信度: ${typeof top.confidence === 'number' ? top.confidence.toFixed(2) : 'N/A'}\n`;
    shieldText += `理由: ${top.reason || '小树关键词匹配'}\n`;

    // 中低置信度时提供备用候选（子 agent 可自行选择）
    if (recommendations.length > 1) {
      shieldText += '\n备用候选:\n';
      for (let i = 1; i < recommendations.length; i++) {
        const r = recommendations[i];
        shieldText += `  ${i}. ${r.tool} (置信度 ${typeof r.confidence === 'number' ? r.confidence.toFixed(2) : 'N/A'})\n`;
      }
    }
  }

  // 引导句：子 agent 看了就知道可以自由选工具
  shieldText += '\n💡 你可以直接用推荐的工具，也可以根据任务自由选择。\n';

  return taskText + shieldText;
}

/**
 * 构建 Top-3 多候选列表
 * 当小树匹配置信度 < 0.9 时，生成多候选项让子 agent 自行选择
 *
 * @param {object} quickResult - routeQuick 返回值 { tool, confidence, params }
 * @returns {Array} 推荐列表（最多 3 个）
 */
function buildTop3Candidates(quickResult) {
  // 小树已匹配的工具作为第 1 候选
  const candidates = [{
    tool: quickResult.tool,
    confidence: quickResult.confidence,
    reason: `小树关键词匹配（置信度 ${quickResult.confidence.toFixed(2)}）`,
  }];

  // 按工具类型补 2 个近似候选
  const fallbacks = FALLBACK_CANDIDATES[quickResult.tool] || FALLBACK_CANDIDATES['default'];
  for (const fb of fallbacks.slice(0, 2)) {
    candidates.push(fb);
  }

  return candidates;
}

/**
 * 注册 cpu_enrichSubagentTask 工具到 OpenClaw
 *
 * @param {object} ctx - OpenClaw 插件上下文
 * @param {object} deps - 依赖注入 { pool }
 * @param {object} deps.pool - sc Worker 池（用于派发 routeQuick）
 */
export async function register(ctx, deps = {}) {
  const { pool } = deps;

  // 延迟初始化 enrichTcell（不阻塞 plugin activate）
  // 放在工具第一次执行时懒加载
  let enrichTcell = null;
  let enrichTcellReady = false;
  // 🧠 保存 init Promise 以便 execute 中等待初始化完成
  // 设计原因：createEnrichTcell 在 register 阶段发起异步初始化，
  // 如果 execute 在初始化完成前被调用，enrichTcell 为 null。
  // 用 enrichTcellInitPromise 让 execute 主动 await 等待，避免第一批命中丢失。
  let enrichTcellInitPromise = null;

  // 异步初始化 enrichTcell
  enrichTcellInitPromise = createEnrichTcell().then(tcell => {
    enrichTcell = tcell;
    enrichTcellReady = true;
    return tcell; // 返回 tcell 以便 execute 中 await 获取
  }).catch(err => {
    // enrichTcell init failed → 降级为无缓存模式，不影响主功能
    enrichTcellReady = false;
    console.warn(`[sc] ⚠️ enrichment layerTcellinit failed（降级为无缓存）: ${err.message}`);
    return null;
  });

  /**
   * 🛡️ cpu_enrichSubagentTask：子agent任务话术enrichment layer
   *
   * 主 agent 在 spawn 子 agent 前调用此工具，给任务描述注入工具推荐。
   * 子 agent 拿到增强版任务描述后直接看到推荐工具，不自己猜。
   *
   * 输入：
   *   taskText  - 原始子 agent 任务描述（必填）
   *   returnOnly - 可选，true 时仅返回结构化推荐不生成enrichment layer文本
   *
   * 输出：
   *   status        - "success" | "degraded"
   *   enrichedTask  - 增强版任务描述（returnOnly=true 时为 null）
   *   recommendations - 结构化推荐列表
   *   tcellHit      - 是否 Tcell 缓存命中
   *   confidence    - 综合置信度
   *   bigTreePending - 是否正在异步跑大树兜底
   */
  ctx.registerTool({
    name: 'cpu_enrichSubagentTask',
    description: '🛡️ 子agent任务话术enrichment layer — 在spawn子agent前调用此工具，给任务描述注入工具推荐。返回增强版任务描述和结构化推荐列表。子agent拿到enrichment layer后直接看到该用什么工具。',
    parameters: {
      type: 'object',
      properties: {
        taskText: {
          type: 'string',
          description: '原始子agent任务描述文本',
        },
        returnOnly: {
          type: 'boolean',
          description: '仅返回结构化推荐而不生成enrichedTask文本（默认false）',
        },
      },
      required: ['taskText'],
    },
    async execute(_toolCallId, params) {
      const { taskText, returnOnly } = params || {};

      // edges界情况：空/非法 taskText → 直接返回原始文本
      // 设计原因：enrichment layer不应因输入异常而阻塞 spawn 流程
      if (!taskText || typeof taskText !== 'string') {
        return {
          status: 'success',
          enrichedTask: taskText || '',
          recommendations: [],
          tcellHit: false,
          confidence: 0,
          note: 'taskText为空，跳过enrichment layer',
        };
      }

      try {
        // ====== 第一步：计算任务指纹 ======
        // 使用 enrich_subagent 作为独立签名空间，与原 tcell 不冲突
        const keywords = extractKeywords(taskText);
        const sig = computeSignature('enrich_subagent', keywords);

        // ====== 第二步：Tcell 缓存查询（独立实例，阈值 0.75）======
        // 设计原因：相同任务文本多次 enrich 时，直接返回缓存结果
        // 省去 routeQuick 的 Worker 调用。每次约省 50ms。
        // Tcell 命中给 0.95 固定置信度（保留 5% 不确定性）
        // 🔧 Bug 3 修复：如果 enrichTcell 尚未异步初始化完成，等待其初始化再查缓存。
        // 设计原因：createEnrichTcell 在 register 阶段发起异步初始化，
        // 如果 execute 在初始化完成前被调用，enrichTcell 为 null。
        // 传统检查 enrichTcellReady 会跳过缓存层，导致前几次命中丢失。
        // 主动 await initPromise 可让首次命中也能走缓存。
        if (!enrichTcellReady && enrichTcellInitPromise) {
          // 🧠 还在初始化中，等待完成
          const t = await enrichTcellInitPromise;
          if (t) {
            enrichTcell = t;
            enrichTcellReady = true;
          }
        }
        if (enrichTcellReady && enrichTcell) {
          const cachedResult = enrichTcell.lookup(sig);
          if (cachedResult && cachedResult.hit && cachedResult.entry) {
            // 从缓存中提取之前推荐的 tool 构建推荐列表
            const cachedTool = cachedResult.entry.tool;
            const rec = [{
              tool: cachedTool,
              confidence: 0.95,
              reason: '话术enrichment layer缓存命中（任务指纹匹配）',
            }];

            // 缓存命中 → 直接返回，跳过 routeQuick
            return {
              status: 'success',
              enrichedTask: returnOnly ? null : buildEnrichedTask(taskText, rec, true),
              recommendations: rec,
              tcellHit: true,
              confidence: 0.95,
            };
          }
        }

        // ====== 第三步：小树 routeQuick 匹配（Worker 池并行）======
        // 设计原因：Tcell 未命中时走小树，50ms 内完成关键词匹配
        // 用 pool.exec 派到 Worker 线程执行，不阻塞主线程
        let quickResult;
        try {
          quickResult = await pool.exec({ type: 'route-quick', text: taskText }, 'high');
        } catch (poolErr) {
          // pool.exec 失败（如队列满、Worker 挂起等）→ 降级返回原始文本
          // 走兜底路径：两 default 候选
          const fallbackRec = [
            { tool: 'core_search', confidence: 0.55, reason: '通用文件搜索（兜底）' },
            { tool: 'core_webSearch', confidence: 0.5, reason: '网络搜索（兜底）' },
          ];
          return {
            status: 'degraded',
            enrichedTask: returnOnly ? null : taskText,
            recommendations: fallbackRec,
            tcellHit: false,
            confidence: 0.5,
            bigTreePending: false,
            note: `enrichment layer降级（pool.exec失败）: ${poolErr.message}`,
          };
        }

        // 小树完全不匹配
        if (!quickResult || !quickResult.matched) {
          return {
            status: 'success',
            enrichedTask: null,              // 无推荐，不注入enrichment layer
            recommendations: [],             // 空推荐列表
            tcellHit: false,
            confidence: 0,
            note: '小树无匹配，无工具推荐。子 agent 自行选择工具。',
          };
        }

        // ====== 第四步：根据置信度组织推荐列表 ======
        let recommendations;
        let bigTreePending = false;

        if (quickResult.confidence >= 0.9) {
          // ✅ 高置信度 → 单推荐（最可能的工具）
          recommendations = [{
            tool: quickResult.tool,
            confidence: quickResult.confidence,
            reason: `小树关键词匹配（识别为 ${quickResult.params?.level || '通用'} 级任务）`,
          }];
        } else {
          // ⚠️ 中低置信度 → Top-3 多候选，推荐仅供参考
          recommendations = buildTop3Candidates(quickResult);
          bigTreePending = true;
        }

        // 更新 Tcell 缓存（记录本次匹配结果以供下次使用）
        if (enrichTcellReady && enrichTcell && recommendations.length > 0) {
          enrichTcell.add(sig, recommendations[0].tool, 'enrich_subagent', taskText, {
            confidence: quickResult.confidence,
          });
        }

        // ====== 第五步：构建返回结果 ======
        const enrichedTask = returnOnly
          ? null
          : buildEnrichedTask(taskText, recommendations, false);

        return {
          status: 'success',
          enrichedTask,
          recommendations,
          tcellHit: false,
          confidence: quickResult.confidence || 0.5,
          bigTreePending,
          note: bigTreePending
            ? `中置信度匹配 (${quickResult.confidence.toFixed(2)})，推荐仅供参考，子agent自行判断`
            : `小树匹配: ${quickResult.tool} (置信度 ${quickResult.confidence.toFixed(2)})`,
        };
      } catch (err) {
        // ====== 异常熔断：任何错误降级返回原始 taskText ======
        // 设计原因：enrichment layer是「锦上添花」功能，失败不应阻塞 spawn
        // 主 agent 拿到的 enrichedTask 保险丝后仍是原始文本
        console.error(`[sc] ❌ cpu_enrichSubagentTask 出错: ${err.message}`);
        return {
          status: 'degraded',
          enrichedTask: taskText,   // 降级返回原始文本
          recommendations: [],
          confidence: 0,
          note: `enrichment layer降级: ${err.message}`,
        };
      }
    },
  });

  // 🛡️ 三件套：白名单 + 超时 + 管家规则
  // 确保子agent能正常调用此工具
  try {
    // 1. 追加到 CORE_TOOLS 白名单（让 before_tool_call 放行）
    if (!CORE_TOOLS.includes('cpu_enrichSubagentTask')) {
      CORE_TOOLS.push('cpu_enrichSubagentTask');
    }

    // 2. 超时配置（短期查询，无需长时间超时）
    if (!TASK_TIMEOUT_MAP['cpu_enrichSubagentTask']) {
      TASK_TIMEOUT_MAP['cpu_enrichSubagentTask'] = { warn: 10, kill: 30, label: '子agentenrichment layer' };
    }

    // 3. 注册管家规则（safe 等级，放行）
    registerToolTier('cpu_enrichSubagentTask', 'safe');
  } catch (err) {
    console.warn(`[sc] ⚠️ enrichment layer三件套注册失败: ${err.message}`);
  }

  // TODO: 移除调试日志 console.log('[sc] 🛡️ cpu_enrichSubagentTask enrichment layer工具已注册');
}
