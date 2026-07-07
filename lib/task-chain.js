/**
 * 🔗 任务链 — 任务链检测与chain scheduler
 *
 * 模仿任务因果链（因果链分析）：
 * 1. 检测 core_routeTask 中的任务链模式（如 cpu_search→cpu_batch→summarize）
 * 2. 自动生成子任务链，用 core_dispatch 批量调度
 * 3. 链中每一步独立存储，某一步失败不影响已成功的步骤
 *
 * 检测规则（built-in chain patterns）:
 *   codeReview→bugFix→validate: 审查→修复→验证  ✅ 存活
 *   ⛔ search-batch-summarize, scan-batch-report, diagnose-report,
 *       research-crossCheck, dispatch-orchestrate, imageBatch-read:
 *       依赖已删除工具，已禁用
 */

import crypto from "crypto";
import { join } from "path";
import { homedir } from "os";
import { readFile, writeFile, mkdir, readdir, stat, unlink } from "fs/promises";

// ====== 配置 ======
const CHAIN_DIR = join(homedir(), '.openclaw', 'workspace', 'plugins', 'sc', 'shared', 'chains');
const STEP_DIR = join(CHAIN_DIR, 'steps');
const CHAIN_LOG_RETENTION_MS = 24 * 60 * 60 * 1000; // 24小时

// ====== 内置链模式 ======

/**
 * 链模式定义：
 * { match: [关键词数组], chain: [步骤定义], confidence: number }
 * 每步：{ name, tool, description, dependsOn?, optional? }
 *
 * ⛔ 已禁用的死链（依赖已删除工具）：
 *   search-batch-summarize  → core_search / core_batch
 *   scan-batch-report       → core_scan / core_batch
 *   diagnose-report         → core_diagnose
 *   research-crossCheck     → cpu_research / cpu_orchestrate
 *   dispatch-orchestrate    → core_dispatch / cpu_orchestrate
 *   imageBatch-read         → core_imageBatch / core_batch
 */
const CHAIN_PATTERNS = [
  // DEAD_CHAIN
  /* ⛔ 死链: search-batch-summarize — 依赖已删除工具(core_search/core_batch)
  {
    id: 'search-batch-summarize',
    match: ['search', 'batch', '读', 'summarize', '搜'],
    confidence: 0.85,
    factory: (taskDesc) => ({
      name: '搜索→批量读→汇总',
      steps: [
        { name: 'search', tool: 'core_search', description: `搜索相关内容: ${taskDesc.substring(0, 80)}`, task: { type: 'search-text', keyword: taskDesc, priority: 'high' }, optional: false, outputKey: 'searchResults', dependsOn: [] },
        { name: 'batch', tool: 'core_batch', description: '批量读取搜索结果文件', task: { type: 'search-text', keyword: `${taskDesc} 读文件`, priority: 'high' }, optional: false, outputKey: 'batchResults', dependsOn: ['search'] },
        { name: 'summarize', tool: 'subagent', description: `汇总分析: ${taskDesc.substring(0, 80)}`, task: { type: 'ai-summarize', text: `${taskDesc} 汇总结果`, priority: 'normal' }, optional: true, outputKey: 'summary', dependsOn: ['batch'] },
      ],
    }),
  },
  */
  // DEAD_CHAIN
  /* ⛔ 死链: scan-batch-report — 依赖已删除工具(core_scan/core_batch)
  {
    id: 'scan-batch-report',
    match: ['scan', '扫描', '目录', '查找', '搜', 'report'],
    confidence: 0.80,
    factory: (taskDesc) => ({
      name: '扫描→读取→报告',
      steps: [
        { name: 'scan', tool: 'core_scan', description: `扫描搜索: ${taskDesc.substring(0, 80)}`, task: { type: 'search-text', keyword: taskDesc, priority: 'high' }, optional: false, outputKey: 'scanResults', dependsOn: [] },
        { name: 'batchRead', tool: 'core_batch', description: '批量读取扫描结果', task: { type: 'search-text', keyword: `${taskDesc} 内容`, priority: 'high' }, optional: false, outputKey: 'readResults', dependsOn: ['scan'] },
      ],
    }),
  },
  */
  {
    id: 'codeReview-bugFix-validate',
    match: ['codeReview', 'bugFix', '审查', '修复', 'code', 'fix'],
    confidence: 0.82,
    factory: (taskDesc) => ({
      name: '代码审查→修复→验证',
      steps: [
        {
          name: 'review',
          tool: 'core_codeEditor', // 🛠 修复: cpu_codeReview → core_codeEditor
          description: `代码审查: ${taskDesc.substring(0, 80)}`,
          task: { type: 'search-text', keyword: `${taskDesc} review`, priority: 'high' },
          optional: false,
          outputKey: 'reviewResults',
          dependsOn: [],
        },
        {
          name: 'fix',
          tool: 'core_codeEditor', // 🛠 修复: cpu_bugFix → core_codeEditor
          description: `自动修复: ${taskDesc.substring(0, 80)}`,
          task: { type: 'search-text', keyword: `${taskDesc} fix`, priority: 'high' },
          optional: true,
          outputKey: 'fixResults',
          dependsOn: ['review'],
        },
      ],
    }),
  },
  // DEAD_CHAIN
  /* ⛔ 死链: diagnose-report — 依赖已删除工具(core_diagnose)
  {
    id: 'diagnose-report',
    match: ['diagnose', '诊断', '体检', 'health'],
    confidence: 0.78,
    factory: (taskDesc) => ({
      name: '系统诊断→报告',
      steps: [
        { name: 'diagnose', tool: 'core_diagnose', description: `系统诊断: ${taskDesc.substring(0, 80)}`, task: { type: 'diagnose', priority: 'high' }, optional: false, outputKey: 'diagnoseResults', dependsOn: [] },
        { name: 'report', tool: 'subagent', description: '生成诊断报告', task: { type: 'ai-summarize', text: `${taskDesc} 生成报告`, priority: 'normal' }, optional: true, outputKey: 'report', dependsOn: ['diagnose'] },
      ],
    }),
  },
  */
  // DEAD_CHAIN
  /* ⛔ 死链: research-crossCheck — 依赖已删除工具(cpu_research/cpu_orchestrate)
  {
    id: 'research-crossCheck',
    match: ['research', '调研', '研究', 'investigate', '查', '分析'],
    confidence: 0.75,
    factory: (taskDesc) => ({
      name: '多维调研→交叉验证',
      steps: [
        { name: 'multiAngle', tool: 'cpu_research', // TODO: remap
        description: `多角度调研: ${taskDesc.substring(0, 80)}`, task: { type: 'search-text', keyword: taskDesc, priority: 'high' }, optional: false, outputKey: 'researchResults', dependsOn: [] },
        { name: 'crossCheck', tool: 'cpu_orchestrate', // TODO: remap
        description: '交叉验证结果', task: { type: 'search-text', keyword: `${taskDesc} cross check`, priority: 'normal' }, optional: true, outputKey: 'crossCheckResults', dependsOn: ['multiAngle'] },
      ],
    }),
  },
  */
  // DEAD_CHAIN
  /* ⛔ 死链: dispatch-orchestrate — 依赖已删除工具(core_dispatch/cpu_orchestrate)
  {
    id: 'dispatch-orchestrate',
    match: ['dispatch', '编排', 'orchestrate', '批量', '并发'],
    confidence: 0.72,
    factory: (taskDesc) => ({
      name: '批量派发→编排',
      steps: [
        { name: 'dispatch', tool: 'core_dispatch', description: `批量派发: ${taskDesc.substring(0, 80)}`, task: { type: 'search-text', keyword: taskDesc, priority: 'high' }, optional: false, outputKey: 'dispatchResults', dependsOn: [] },
        { name: 'orchestrate', tool: 'cpu_orchestrate', // TODO: remap
        description: '结果编排', task: { type: 'search-text', keyword: `${taskDesc} orchestrate`, priority: 'normal' }, optional: true, outputKey: 'orchestrateResults', dependsOn: ['dispatch'] },
      ],
    }),
  },
  */
  // DEAD_CHAIN
  /* ⛔ 死链: imageBatch-read — 依赖已删除工具(core_imageBatch/core_batch)
  {
    id: 'imageBatch-read',
    match: ['image', '图片', 'vision', 'visual', '视觉', 'batch'],
    confidence: 0.74,
    factory: (taskDesc) => ({
      name: '图片批量分析→结果读取',
      steps: [
        { name: 'imageBatch', tool: 'core_imageBatch', description: `图片批量分析: ${taskDesc.substring(0, 80)}`, task: { type: 'image-batch', keyword: taskDesc, priority: 'high' }, optional: false, outputKey: 'imageResults', dependsOn: [] },
        { name: 'read', tool: 'core_batch', description: '批量读取分析结果', task: { type: 'search-text', keyword: `${taskDesc} 结果`, priority: 'normal' }, optional: true, outputKey: 'readResults', dependsOn: ['imageBatch'] },
      ],
    }),
  },
  */
];

// ====== 链检测 ======

/**
 * 检测任务描述是否匹配某个链模式
 * @param {string} taskDesc - 原始任务描述
 * @returns {{ matched: boolean, chain: object|null, confidence: number, chainId: string|null }}
 */
function detectChain(taskDesc) {
  if (!taskDesc || typeof taskDesc !== 'string') {
    return { matched: false, chain: null, confidence: 0, chainId: null };
  }

  const query = taskDesc.toLowerCase();

  // 按置信度排序，选最佳匹配
  let bestMatch = null;
  let bestScore = 0;

  for (const pattern of CHAIN_PATTERNS) {
    let matchCount = 0;
    for (const kw of pattern.match) {
      if (query.includes(kw.toLowerCase())) matchCount++;
    }
    const score = (matchCount / pattern.match.length) * pattern.confidence;
    if (score > bestScore && matchCount >= 1) {
      bestScore = score;
      bestMatch = pattern;
    }
  }

  // 🧠 设计决策：bestScore >= 0.2 为链检测触发阈值。
  // 存活链仅剩 codeReview-bugFix-validate (0.82)
  // 其余6条死链已注释（search-batch-summarize, scan-batch-report,
  //   diagnose-report, research-crossCheck, dispatch-orchestrate, imageBatch-read）
  // 0.2 拦截过多链（噪声），低于 0.5 防漏掉真正有链模式的任务。
  // 数学：0.2 = 1/5 模式匹配度，最低要求至少 1 个关键词命中且置信度 > 0.2
  if (bestMatch && bestScore >= 0.2) {
    const chain = bestMatch.factory(taskDesc);
    return {
      matched: true,
      chain,
      confidence: Math.round(bestScore * 100) / 100,
      chainId: bestMatch.id,
    };
  }

  return { matched: false, chain: null, confidence: 0, chainId: null };
}

// ====== 链步骤persist ======

async function ensureChainDirs() {
  try { await mkdir(CHAIN_DIR, { recursive: true }); } catch {}
  try { await mkdir(STEP_DIR, { recursive: true }); } catch {}
}

/**
 * 生成全局唯一的链ID
 */
function genChainId() {
  return `chain_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * persist一个链实例到 shared/chains/
 * @param {object} chainDef - { chainId, name, steps, taskDesc, status }
 * @returns {string} 链ID
 */
async function persistChain(chainDef) {
  await ensureChainDirs();
  const chainId = chainDef.chainId || genChainId();
  const safeName = chainId.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const fp = join(CHAIN_DIR, `${safeName}.json`);
  const entry = {
    ...chainDef,
    chainId,
    createdAt: Date.now(),
    stepStatus: chainDef.stepStatus || chainDef.steps.map(s => ({
      name: s.name,
      status: 'pending',
      result: null,
      error: null,
      startedAt: null,
      completedAt: null,
    })),
  };
  await writeFile(fp, JSON.stringify(entry, null, 2), 'utf-8');
  return chainId;
}

/**
 * 更新链实例中的某一步状态
 * @param {string} chainId
 * @param {string} stepName
 * @param {string} status - pending|running|success|failed|skipped
 * @param {object|null} result
 * @param {string|null} error
 */
async function updateChainStepStatus(chainId, stepName, status, result = null, error = null) {
  const safeName = chainId.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const fp = join(CHAIN_DIR, `${safeName}.json`);
  try {
    const raw = await readFile(fp, 'utf-8');
    const chain = JSON.parse(raw);
    const step = chain.stepStatus.find(s => s.name === stepName);
    if (step) {
      step.status = status;
      if (status === 'running') step.startedAt = Date.now();
      if (status === 'success' || status === 'failed') step.completedAt = Date.now();
      if (result !== null) step.result = result;
      if (error !== null) step.error = error;
      chain.updatedAt = Date.now();
      // 检查是否全部完成
      const allDone = chain.stepStatus.every(s => s.status === 'success' || s.status === 'failed' || s.status === 'skipped');
      if (allDone) chain.status = 'completed';
      await writeFile(fp, JSON.stringify(chain, null, 2), 'utf-8');
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取链状态
 */
async function readChain(chainId) {
  const safeName = chainId.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const fp = join(CHAIN_DIR, `${safeName}.json`);
  try {
    const raw = await readFile(fp, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 清理超过24小时的链日志
 */
async function cleanupChainLogs() {
  try {
    await ensureChainDirs();
    const files = await readdir(CHAIN_DIR);
    const now = Date.now();
    let cleaned = 0;
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const fp = join(CHAIN_DIR, f);
      try {
        const st = await stat(fp);
        if (now - st.mtimeMs > CHAIN_LOG_RETENTION_MS) {
          await unlink(fp);
          cleaned++;
        }
      } catch {}
    }
    // 清理 steps/ 子目录
    const stepFiles = await readdir(STEP_DIR).catch(() => []);
    for (const f of stepFiles) {
      if (!f.endsWith('.json')) continue;
      const fp = join(STEP_DIR, f);
      try {
        const st = await stat(fp);
        if (now - st.mtimeMs > CHAIN_LOG_RETENTION_MS) {
          await unlink(fp);
          cleaned++;
        }
      } catch {}
    }
    if (cleaned > 0) console.log(`[chain scheduler] 🧹 清理了 ${cleaned} 个过期链日志`);
  } catch {}
}

// ====== 独立步骤执行 ======

/**
 * 执行链中的单一步骤（独立于其他步骤）
 * 失败不影响已成功的步骤
 * @param {object} step - 步骤定义
 * @param {object} pool - Worker 池引用
 * @returns {Promise<object>} { success, result, error }
 */
async function executeStep(step, pool) {
  if (!step || !step.task) {
    return { success: false, error: 'missing任务定义' };
  }

  try {
    const result = await pool.exec(step.task, step.task?.priority || 'normal');
    return { success: true, result };
  } catch (err) {
    // 步骤独立存储失败，不抛出
    console.warn(`[chain scheduler] ⚠️ 步骤 "${step.name}" 失败: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * 执行完整的链（按依赖拓扑排序串行+并行）
 * @param {object} chainDef - { steps, stepStatus }
 * @param {object} pool - Worker 池引用
 * @param {function} updateFn - (stepName, status, result, error) => void
 * @returns {Array<object>} 每步的执行结果
 */
async function executeChain(chainDef, pool, updateFn) {
  const steps = chainDef.steps;
  const updateStatus = updateFn || ((name, status, result, err) =>
    updateChainStepStatus(chainDef.chainId, name, status, result, err));

  // 构建依赖图
  const depGraph = new Map();
  for (const step of steps) {
    deps: for (const dep of (step.dependsOn || [])) {
      if (steps.find(s => s.name === dep)) {
        if (!depGraph.has(dep)) depGraph.set(dep, []);
        depGraph.get(dep).push(step.name);
      }
    }
  }

  // 拓扑排序：先找无依赖的，逐步移除
  const executed = new Set();
  const skipped = new Set();
  const results = [];

  // 找出入度为0的步骤（没有依赖的）
  async function tryExecuteReadyStep() {
    for (const step of steps) {
      if (executed.has(step.name) || skipped.has(step.name)) continue;

      const deps = step.dependsOn || [];
      const allDepsDone = deps.every(d => executed.has(d));
      const anyDepFailed = deps.some(d => {
        const r = results.find(rr => rr.name === d);
        return r && !r.success && !step.optional;
      });

      if (allDepsDone) {
        // 如果有依赖失败了且此步骤不(可选/必须)，跳过
        if (anyDepFailed) {
          skipped.add(step.name);
          await updateStatus(step.name, 'skipped', null, '依赖失败，跳过');
          results.push({ name: step.name, success: false, skipped: true, error: '依赖失败，跳过' });
          continue; // 继续检查其他可执行的
        }

        // 执行此步骤
        executed.add(step.name);
        await updateStatus(step.name, 'running');
        const stepResult = await executeStep(step, pool);
        if (stepResult.success) {
          await updateStatus(step.name, 'success', stepResult.result);
        } else {
          const status = step.optional ? 'skipped' : 'failed';
          await updateStatus(step.name, status, null, stepResult.error);
        }
        results.push({ name: step.name, ...stepResult });
        return true; // 执行了一个步骤，重新检查
      }
    }

    // 检查是否有步骤永远无法执行（死锁或全部跳过）
    const remaining = steps.filter(s => !executed.has(s.name) && !skipped.has(s.name));
    for (const step of remaining) {
      const deps = step.dependsOn || [];
      const deadLock = deps.some(d => remaining.some(r => r.name === d) && !executed.has(d));
      if (deadLock) {
        skipped.add(step.name);
        await updateStatus(step.name, 'skipped', null, '死锁依赖');
        results.push({ name: step.name, success: false, skipped: true, error: '死锁依赖' });
        return true;
      }
    }

    return false; // 没有可执行的步骤了
  }

  // 主循环：不断执行ready步骤直到全部完成
  for (let i = 0; i < steps.length * 2; i++) {
    const didRun = await tryExecuteReadyStep();
    if (!didRun) break; // 没有ready步骤了
  }

  return results;
}

// ====== 集成到 core_routeTask 的路由结果 ======

/**
 * 检查任务是否匹配链模式，返回链式路由决策
 * @param {string} taskDesc - 原始任务描述
 * @param {object} quickResult - core_routeTask 的小树结果
 * @returns {object|null} 链式路由结果或null
 */
function getChainRoute(taskDesc, quickResult) {
  const chainMatch = detectChain(taskDesc);

  if (!chainMatch.matched) {
    // 检查 quickResult 中是否有链式线索
    // 如 route-quick 返回了多个阶段的操作
    if (quickResult?.chainHint) {
      const hint = quickResult.chainHint;
      // 尝试根据提示构建链
      // TODO: 移除调试日志 console.log(`[chain scheduler] 🔗 route-quick 返回了链提示: ${hint}`);
    }
    return null;
  }

  const chainId = genChainId();
  const chainDef = {
    chainId,
    name: chainMatch.chain.name,
    steps: chainMatch.chain.steps,
    taskDesc: taskDesc.substring(0, 200),
    status: 'created',
    stepStatus: chainMatch.chain.steps.map(s => ({
      name: s.name,
      status: 'pending',
      result: null,
      error: null,
      startedAt: null,
      completedAt: null,
    })),
  };

  // 异步persist（不阻塞返回）
  persistChain(chainDef).catch(err => {
    console.warn(`[chain scheduler] ⚠️ 链persist失败: ${err.message}`);
  });

  return {
    matched: true,
    chainId,
    confidence: chainMatch.confidence,
    chain: {
      name: chainMatch.chain.name,
      totalSteps: chainMatch.chain.steps.length,
      steps: chainMatch.chain.steps.map(s => ({
        name: s.name,
        tool: s.tool,
        description: s.description,
        dependsOn: s.dependsOn,
        optional: s.optional,
      })),
    },
  };
}

/**
 * 执行已检测到的链
 * @param {string} chainId - persist的链ID
 * @param {object} pool - Worker 池引用
 * @returns {Promise<object>} 执行结果
 */
async function executeDetectedChain(chainId, pool) {
  const chain = await readChain(chainId);
  if (!chain) {
    return { success: false, error: `链 ${chainId} 未找到` };
  }

  const allSteps = chain.steps;
  const depGraph = new Map();
  for (const step of allSteps) {
    const deps = step.dependsOn || [];
    for (const dep of deps) {
      if (!depGraph.has(dep)) depGraph.set(dep, []);
      depGraph.get(dep).push(step.name);
    }
  }

  // 获取ready的步骤（所有依赖已完成）
  function getReadySteps(completed) {
    return allSteps.filter(s => {
      if (completed.has(s.name)) return false;
      const deps = s.dependsOn || [];
      return deps.every(d => completed.has(d));
    });
  }

  const completed = new Set();
  const results = [];

  while (completed.size < allSteps.length) {
    const ready = getReadySteps(completed);
    if (ready.length === 0) break;

    // 并行执行ready步骤
    const readyResults = await Promise.allSettled(
      ready.map(async (step) => {
        await updateChainStepStatus(chainId, step.name, 'running');
        const result = await executeStep(step, pool);
        if (result.success) {
          await updateChainStepStatus(chainId, step.name, 'success', result.result);
          completed.add(step.name);
        } else if (step.optional) {
          await updateChainStepStatus(chainId, step.name, 'skipped', null, result.error);
          completed.add(step.name); // 可选步骤失败也算完成
        } else {
          await updateChainStepStatus(chainId, step.name, 'failed', null, result.error);
          completed.add(step.name); // 🛠 修复: 非可选步骤失败也必须加入 completed，防止死循环
          // 非可选步骤失败 → 标记其依赖链上的所有后序步骤为 skipped
          const cascadeSkip = [];
          function markCascade(name) {
            const dependents = depGraph.get(name) || [];
            for (const dep of dependents) {
              if (!completed.has(dep)) {
                cascadeSkip.push(dep);
                completed.add(dep);
                markCascade(dep);
              }
            }
          }
          markCascade(step.name);
          for (const skipName of cascadeSkip) {
            await updateChainStepStatus(chainId, skipName, 'skipped', null, '因前置步骤失败跳过');
          }
        }
        return { name: step.name, ...result };
      })
    );

    for (const r of readyResults) {
      if (r.status === 'fulfilled') results.push(r.value);
      else results.push({ name: 'unknown', success: false, error: r.reason?.message });

      // 如果非可选步骤失败则停止调度新步骤
      if (r.status === 'fulfilled' && !r.value.success && !ready.find(s => s.name === r.value.name)?.optional) {
        // 已通过 cascadeSkip 处理
      }
    }
  }

  return { success: true, chainId, results };
}

// ====== core_routeTask 集成 ======

/**
 * 在 core_routeTask 的 L5+ 路由中检测链模式
 * 返回链信息并persist，可由调用方调 executeDetectedChain 执行
 */
function enrichRouteWithChain(routeResult, taskDesc) {
  if (!taskDesc) return routeResult;

  // 只对 subagent/路由类任务尝试链检测
  // 🛠 修复: 移除已删除的 cpu_orchestrate
  const candidates = ['subagent', 'core_dispatch'];
  const target = routeResult.decision || routeResult.recommendedTool || routeResult.strategy;
  if (!candidates.includes(target) && !routeResult.strategy?.includes('chain')) return routeResult;

  const chainMatch = getChainRoute(taskDesc, routeResult);
  if (!chainMatch) return routeResult;

  return {
    ...routeResult,
    chainMode: true,
    chain: chainMatch,
    note: `${routeResult.note || ''} | 🔗 任务链检测: ${chainMatch.chain.name} (${chainMatch.chain.totalSteps}步，链ID=${chainMatch.chainId})`,
  };
}

// ====== 公开 API 汇总 ======

/**
 * 列出所有链，按更新时间倒序排列
 *
 * 性能说明（问题13已审）：
 * - limit=50 已到位，防止返回过多结果
 * - stat() 在 readFile+JSON.parse 之前过滤过期文件，避免不必要的大文件读取
 * - 24h 清理兜底：cleanupChainLogs 每小时执行一次，删除超24小时的文件
 * - 因此目录中文件数有自然上限（最多24小时内的文件），stat→readFile+JSON.parse 性能可接受
 * - 排序后 slice(limit) 确保返回结果受控
 *
 * @param {number} [limit=50] - 最多返回数
 * @returns {Promise<Array<{chainId, name, status, stepCount, createdAt, updatedAt}>>}
 */
async function listChains(limit = 50) {
  try {
    await ensureChainDirs();
    const files = await readdir(CHAIN_DIR);
    const now = Date.now();
    const chains = [];

    for (const f of files) {
      if (!f.endsWith('.json')) continue;

      const fp = join(CHAIN_DIR, f);
      try {
        // 快速过滤：stat 检查 24h 过期，避免不必要的 readFile
        const st = await stat(fp);
        if (now - st.mtimeMs > CHAIN_LOG_RETENTION_MS) continue;

        // 只读基本信息（不解析完整内容以节省性能）
        const raw = await readFile(fp, 'utf-8');
        const chain = JSON.parse(raw);
        chains.push({
          chainId: chain.chainId || f.replace('.json', ''),
          name: chain.name || 'unnamed',
          status: chain.status || 'unknown',
          stepCount: (chain.steps || chain.stepStatus || []).length,
          createdAt: chain.createdAt || null,
          updatedAt: chain.updatedAt || chain.createdAt || st.mtimeMs,
        });
      } catch {
        // 损坏的JSON跳过
        continue;
      }
    }

    // 按 updatedAt 倒序
    chains.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    return chains.slice(0, Math.max(1, limit));
  } catch {
    return [];
  }
}

export {
  detectChain,
  getChainRoute,
  enrichRouteWithChain,
  executeDetectedChain,
  executeChain,
  executeStep,
  persistChain,
  readChain,
  updateChainStepStatus,
  cleanupChainLogs,
  genChainId,
  listChains,
};

export default {
  detectChain,
  getChainRoute,
  enrichRouteWithChain,
  executeDetectedChain,
  executeChain,
  executeStep,
  persistChain,
  readChain,
  updateChainStepStatus,
  cleanupChainLogs,
  genChainId,
  listChains,
};
