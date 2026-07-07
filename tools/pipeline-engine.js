/**
 * 🦞 sc — 多阶段流水线引擎 (ESM)
 *
 * 声明式多阶段任务编排，支持先后依赖和并行阶段。
 *
 * 设计:
 *   1. DAG解析 — 自动解析 stages 依赖关系
 *   2. 拓扑排序 — 按依赖拆分层级（同层可并行，异层串行）
 *   3. 上下文传递 — 每阶段拿到上游所有输出
 *   4. 容错 — 逐阶段熔断/独立超时/错误收集
 *
 * 使用 core_dispatch + shared-fs 作为基础设施。
 *
 * @module pipeline-engine
 */

import { join } from "path";
import { homedir } from "os";
import { writeFile, readFile, mkdir, unlink } from "fs/promises";
import crypto from "crypto";

// ====== 类型定义（JSDoc 注释） ======

/**
 * @typedef {Object} StageDef
 * @property {string} name  - 阶段名称（唯一标识）
 * @property {('exec'|'pool'|'fn')} [mode='pool']  - 执行模式
 * @property {Object}  task  - 任务定义
 * @property {string[]} [dependsOn] - 依赖的前置阶段名列表
 * @property {boolean}  [optional=false] - 可选阶段（失败不终止流水线）
 * @property {number}   [timeoutMs] - 本阶段超时（ms）
 * @property {Object}   [retry] - retry策略
 * @property {number}   [retry.max=0]   - 最大retry次数
 * @property {number}   [retry.delayMs=1000] - retry间隔
 */

/**
 * @typedef {Object} PipelineDef
 * @property {string}  [name='unnamed']  - 流水线名称
 * @property {StageDef[]} stages - 阶段定义列表
 * @property {Object}  [params] - 全局参数
 * @property {string}  [fallback='abort'] - 阶段失败策略: 'abort'|'skip-dependents'|'continue'
 * @property {number}  [stageTimeoutMs=120000] - 阶段默认超时
 */

/**
 * @typedef {Object} StageResult
 * @property {string}  name       - 阶段名
 * @property {'pending'|'running'|'success'|'failed'|'skipped'} status
 * @property {*}       [output]   - 阶段输出
 * @property {string}  [error]    - 错误信息（仅 failed）
 * @property {number}  durationMs - 执行耗时
 * @property {boolean} [optional=false]
 * @property {number}  [attempts=1]- retry次数
 */

/**
 * @typedef {Object} PipelineResult
 * @property {string}       name        - 流水线名称
 * @property {'running'|'completed'|'failed'|'aborted'} status
 * @property {number}       totalStages - 总阶段数
 * @property {StageResult[]} stages     - 各阶段结果
 * @property {number}       durationMs  - 总耗时
 * @property {string}       [error]     - 流水线级错误
 * @property {Object}       [finalContext] - 最终上下文
 */

// ====== 内部常量 ======
const PIPELINE_DIR = join(homedir(), '.openclaw', 'workspace', 'memory', 'pipeline');
const PID_LENGTH = 8;

// ====== 工具函数 ======

/** 生成全局唯一的流水线实例 ID */
function genPipelineId() {
  return crypto.randomUUID().slice(0, PID_LENGTH);
}

/** 写入阶段输出到persist文件（供后续阶段读取） */
async function writeStageOutput(pipeId, stageName, data) {
  await mkdir(PIPELINE_DIR, { recursive: true });
  const fp = join(PIPELINE_DIR, `${pipeId}__${stageName}.json`);
  const tmp = fp + '.tmp.' + crypto.randomBytes(4).toString('hex');
  await writeFile(tmp, JSON.stringify({ pipeId, stageName, data, ts: Date.now() }, null, 2), 'utf-8');
  try {
    const { rename } = await import('fs/promises');
    await rename(tmp, fp);
  } catch (e) {
    // 原子重命名失败，尝试直接覆盖
    await writeFile(fp, JSON.stringify({ pipeId, stageName, data, ts: Date.now() }, null, 2), 'utf-8');
    await unlink(tmp).catch(() => {});
  }
  return fp;
}

/** 读取上游阶段的输出 */
async function readStageOutput(pipeId, stageName) {
  const fp = join(PIPELINE_DIR, `${pipeId}__${stageName}.json`);
  try {
    const raw = await readFile(fp, 'utf-8');
    return JSON.parse(raw).data;
  } catch {
    return null;
  }
}

/** 清理流水线产生的临时文件 */
async function cleanupPipeline(pipeId) {
  const { readdir, unlink: ul } = await import('fs/promises');
  try {
    const files = await readdir(PIPELINE_DIR);
    const toDelete = files.filter(f => f.startsWith(pipeId + '__'));
    for (const f of toDelete) {
      await ul(join(PIPELINE_DIR, f)).catch(() => {});
    }
  } catch {}
}

/**
 * 从清理时间 >1h 的旧流水线文件
 */
async function cleanupOldPipelines() {
  const { readdir, stat, unlink: ul } = await import('fs/promises');
  try {
    if (!await mkdir(PIPELINE_DIR, { recursive: true }).then(() => true).catch(() => false)) return;
    const files = await readdir(PIPELINE_DIR);
    const now = Date.now();
    let count = 0;
    for (const f of files) {
      if (!f.includes('__')) continue;
      const fp = join(PIPELINE_DIR, f);
      try {
        const st = await stat(fp);
        if (now - st.mtimeMs > 3600000) {
          await ul(fp);
          count++;
        }
      } catch {}
    }
    if (count > 0) console.log(`[pipeline-engine] 🧹 清理了 ${count} 个旧流水线文件`);
  } catch {}
}
// 每1小时自动清理一次
setInterval(cleanupOldPipelines, 3600000).unref();

// ====== DAG 解析 ======

/**
 * 解析阶段依赖关系，返回拓扑排序后的层级列表。
 * 返回 [[stage1], [stage2, stage3], [stage4], ...]
 * 同一层内可并行执行，不同层串行。
 *
 * @param {StageDef[]} stages
 * @returns {{ levels: string[][], adjacency: Map<string, string[]>, error?: string }}
 */
export function buildDAG(stages) {
  const names = new Set(stages.map(s => s.name));
  const adjacency = new Map();    // name → [dependent names]
  const reverseAdj = new Map();   // name → [dependency names]

  // 初始化邻接表
  for (const s of stages) {
    adjacency.set(s.name, []);
    reverseAdj.set(s.name, s.dependsOn || []);
  }

  // 构建正向依赖
  for (const s of stages) {
    const deps = s.dependsOn || [];
    for (const dep of deps) {
      if (!names.has(dep)) {
        return { levels: [], adjacency, error: `阶段 "${s.name}" 依赖不存在的阶段 "${dep}"` };
      }
      if (dep === s.name) {
        return { levels: [], adjacency, error: `阶段 "${s.name}" 不能依赖自身` };
      }
      adjacency.get(dep).push(s.name);
    }
  }

  // 拓扑排序（Kahn 算法）
  const inDegree = new Map();
  for (const s of stages) {
    inDegree.set(s.name, (s.dependsOn || []).length);
  }

  const queue = [];
  for (const [name, degree] of inDegree) {
    if (degree === 0) queue.push(name);
  }

  const sorted = [];
  while (queue.length > 0) {
    const levelSize = queue.length;
    const level = [];
    for (let i = 0; i < levelSize; i++) {
      const node = queue.shift();
      level.push(node);
      sorted.push(node);
      const neighbors = adjacency.get(node) || [];
      for (const next of neighbors) {
        const deg = inDegree.get(next) - 1;
        inDegree.set(next, deg);
        if (deg === 0) queue.push(next);
      }
    }
    // 检查环：如果 queue 为空但还有未处理的nodes，说明有环
    // 但在 Kahn 算法中，如果环存在，inDegree 永远不为 0 的nodes不会被加入
  }

  if (sorted.length !== stages.length) {
    const unsorted = stages.filter(s => !sorted.includes(s.name)).map(s => s.name);
    return { levels: [], adjacency, error: `检测到循环依赖: ${unsorted.join(', ')}` };
  }

  // 重建分层（按依赖深度）
  const depths = new Map();
  for (const s of stages) {
    depths.set(s.name, 0);
  }

  // 计算每个nodes的深度=max(依赖深度)+1
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of stages) {
      const deps = s.dependsOn || [];
      if (deps.length === 0) continue;
      const maxDepDepth = Math.max(...deps.map(d => depths.get(d) || 0));
      const newDepth = maxDepDepth + 1;
      if (newDepth > (depths.get(s.name) || 0)) {
        depths.set(s.name, newDepth);
        changed = true;
      }
    }
  }

  // 按深度分组
  const maxDepth = Math.max(...depths.values(), 0);
  const levels = [];
  for (let d = 0; d <= maxDepth; d++) {
    const level = stages.filter(s => depths.get(s.name) === d).map(s => s.name);
    if (level.length > 0) levels.push(level);
  }

  return { levels, adjacency, error: undefined };
}

// ====== 阶段执行器 ======

/**
 * 执行单阶段
 *
 * @param {Object} ctx - 执行上下文
 * @param {string} ctx.pipeId
 * @param {StageDef} ctx.stageDef
 * @param {Object} ctx.context - 上游阶段传递的上下文
 * @param {Function} ctx.poolExec - pool.exec 函数引用
 * @returns {Promise<StageResult>}
 */
async function runStage(ctx) {
  const { pipeId, stageDef, context, poolExec } = ctx;
  const startTime = Date.now();
  const name = stageDef.name;
  const maxAttempts = (stageDef.retry?.max || 0) + 1;
  const stageTimeout = stageDef.timeoutMs || 120000;

  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // ✅ 使用 AbortController + Promise.race 替代 setTimeout+throw
      // 超时 reject 在 Promise 链中传播，可被外层 try-catch 安全捕获
      const abortController = new AbortController();

      const timeoutPromise = new Promise((_, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`阶段 "${name}" 超时 ${stageTimeout}ms (第${attempt}次尝试)`));
        }, stageTimeout);
        // AbortController 信号触发时清理定时器，防止内存泄漏
        abortController.signal.addEventListener('abort', () => clearTimeout(timer));
      });

      // 构建工作 Promise（按 mode 分支）
      let workPromise;

      switch (stageDef.mode || 'pool') {
        case 'pool': {
          const taskArgs = { ...stageDef.task };
          if (context) taskArgs._pipelineContext = context;
          workPromise = poolExec(taskArgs, 'high');
          break;
        }

        case 'exec': {
          const taskArgs = {
            type: 'exec',
            command: stageDef.task.command || '',
            cwd: stageDef.task.cwd,
            env: stageDef.task.env,
            _pipelineContext: context,
          };
          workPromise = poolExec(taskArgs, 'high');
          break;
        }

        case 'fn': {
          if (typeof stageDef.task.fn === 'function') {
            workPromise = stageDef.task.fn(context);
          } else {
            throw new Error('fn 模式需要提供可调用函数');
          }
          break;
        }

        default:
          throw new Error(`未知执行模式: ${stageDef.mode}`);
      }

      // Promise.race: 工作 vs 超时，谁先完成谁胜出
      const output = await Promise.race([workPromise, timeoutPromise]);

      // 工作完成 → 取消超时定时器（通过 AbortController 清理，同时触发 clearTimeout）
      abortController.abort();

      // persist输出，供依赖阶段读取
      await writeStageOutput(pipeId, name, output).catch(() => {});

      return {
        name,
        status: 'success',
        output,
        durationMs: Date.now() - startTime,
        optional: stageDef.optional || false,
        attempts: attempt,
      };
    } catch (err) {
      // 超时 reject、workPromise reject、fn 同步 throw 均在此被统一捕获
      lastError = err;
      if (attempt < maxAttempts) {
        const delay = stageDef.retry?.delayMs || 1000;
        // TODO: 移除调试日志 console.log(`[pipeline] 阶段 "${name}" 第${attempt}次失败, ${delay}ms后retry: ${err.message}`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  // 所有retry都用尽
  return {
    name,
    status: 'failed',
    error: lastError?.message || '未知错误',
    durationMs: Date.now() - startTime,
    optional: stageDef.optional || false,
    attempts: maxAttempts,
  };
}

// ====== 流水线主入口 ======

/**
 * 执行多阶段流水线
 *
 * @param {PipelineDef} pipelineDef
 * @param {Object} options
 * @param {Function} options.poolExec    - pool.exec 引用
 * @param {boolean}  [options.cleanup=true] - 完成后是否清理临时文件
 * @param {AbortSignal} [options.signal] - 取消信号
 * @returns {Promise<PipelineResult>}
 */
export async function runPipeline(pipelineDef, options = {}) {
  const startTime = Date.now();
  const pipeId = genPipelineId();
  const poolExec = options.poolExec;
  const cleanup = options.cleanup !== false;
  const signal = options.signal;

  if (!poolExec) {
    throw new Error('[pipeline-engine] missing poolExec，无法执行流水线');
  }

  const stages = pipelineDef.stages || [];
  if (stages.length === 0) {
    return {
      name: pipelineDef.name || 'unnamed',
      status: 'completed',
      totalStages: 0,
      stages: [],
      durationMs: 0,
      finalContext: {},
    };
  }

  // 确保临时目录存在
  await mkdir(PIPELINE_DIR, { recursive: true });

  // 1. 解析 DAG
  const { levels, error: dagError } = buildDAG(stages);

  if (dagError) {
    return {
      name: pipelineDef.name || 'unnamed',
      status: 'failed',
      totalStages: stages.length,
      stages: [],
      durationMs: Date.now() - startTime,
      error: dagError,
    };
  }

  // stageDef 的快速查找表
  const stageDefMap = new Map(stages.map(s => [s.name, s]));

  // 2. 逐层执行
  const stageResults = [];
  const stageOutputs = {}; // name → output（运行时上下文）
  let pipelineFailed = false;
  const fallback = pipelineDef.fallback || 'abort';

  for (const level of levels) {
    if (pipelineFailed && fallback === 'abort') {
      // 跳过剩余所有阶段（break前已标记），这段不会再执行到
      continue;
    }

    if (signal?.aborted) {
      pipelineFailed = true;
      for (const name of level) {
        stageResults.push({
          name,
          status: 'skipped',
          durationMs: 0,
          optional: stageDefMap.get(name)?.optional || false,
          error: '流水线被取消',
        });
      }
      const remainingLevels = levels.slice(levels.indexOf(level) + 1);
      for (const lvl of remainingLevels) {
        for (const name of lvl) {
          stageResults.push({
            name,
            status: 'skipped',
            durationMs: 0,
            optional: stageDefMap.get(name)?.optional || false,
            error: '流水线被取消',
          });
        }
      }
      break;
    }

    // 同层并行执行
    const levelPromises = level.map(async (name) => {
      const sd = stageDefMap.get(name);
      if (!sd) {
        return {
          name,
          status: 'failed',
          error: `阶段定义丢失: ${name}`,
          durationMs: 0,
          optional: false,
          attempts: 0,
        };
      }

      // 检查是否有依赖失败（skip-dependents 模式）
      if (fallback === 'skip-dependents' && sd.dependsOn) {
        for (const dep of sd.dependsOn) {
          const depResult = stageResults.find(r => r.name === dep);
          if (depResult && depResult.status === 'failed') {
            return {
              name,
              status: 'skipped',
              error: `依赖阶段 "${dep}" 失败`,
              durationMs: 0,
              optional: sd.optional || false,
              attempts: 0,
            };
          }
        }
      }

      // 构建本阶段上下文 = 上游所有依赖的输出
      const context = { pipeline: { name: pipelineDef.name || 'unnamed', pipeId } };
      if (sd.dependsOn && sd.dependsOn.length > 0) {
        context.stageOutputs = {};
        for (const dep of sd.dependsOn) {
          const depOutput = stageOutputs[dep];
          if (depOutput !== undefined) {
            context.stageOutputs[dep] = depOutput;
          } else {
            // 尝试从文件读取persist输出
            const fileOutput = await readStageOutput(pipeId, dep);
            if (fileOutput !== undefined) {
              context.stageOutputs[dep] = fileOutput;
              stageOutputs[dep] = fileOutput; // 缓存
            }
          }
        }
      } else {
        context.stageOutputs = {};
      }
      context.params = pipelineDef.params || {};

      const result = await runStage({
        pipeId,
        stageDef: sd,
        context,
        poolExec,
      });

      // 记录输出
      if (result.status === 'success' && result.output !== undefined) {
        stageOutputs[name] = result.output;
      }

      // 检查是否应该终止流水线
      if (result.status === 'failed' && !result.optional) {
        pipelineFailed = true;
      }

      return result;
    });

    const results = await Promise.allSettled(levelPromises);
    for (const r of results) {
      if (r.status === 'fulfilled') {
        stageResults.push(r.value);
      } else {
        stageResults.push({
          name: 'unknown',
          status: 'failed',
          error: `阶段执行异常: ${r.reason?.message || '未知'}`,
          durationMs: 0,
          optional: false,
          attempts: 0,
        });
        pipelineFailed = true;
      }
    }

    if (pipelineFailed && fallback === 'abort') {
      // 先标记剩余所有阶段为 skipped
      const remainingLevels = levels.slice(levels.indexOf(level) + 1);
      for (const lvl of remainingLevels) {
        for (const name of lvl) {
          stageResults.push({
            name,
            status: 'skipped',
            durationMs: 0,
            optional: stageDefMap.get(name)?.optional || false,
            attempts: 0,
            error: '流水线已终止',
          });
        }
      }
      break;
    }
  }

  // 3. 计算结果
  const totalStages = stages.length;
  const completedCount = stageResults.filter(r => r.status === 'success').length;
  const failedCount = stageResults.filter(r => r.status === 'failed').length;
  const mandatoryFailed = stageResults.filter(r => r.status === 'failed' && !r.optional).length;
  const skippedCount = stageResults.filter(r => r.status === 'skipped').length;

  let pipelineStatus;
  if (mandatoryFailed > 0 && fallback !== 'continue') {
    pipelineStatus = 'failed';
  } else if (pipelineFailed) {
    pipelineStatus = 'failed';
  } else {
    pipelineStatus = 'completed';
  }

  if (signal?.aborted) {
    pipelineStatus = 'aborted';
  }

  // 4. 清理临时文件
  if (cleanup) {
    cleanupPipeline(pipeId).catch(() => {});
  }

  return {
    name: pipelineDef.name || 'unnamed',
    status: pipelineStatus,
    pipelineId: pipeId,
    totalStages,
    completedStages: completedCount,
    failedStages: failedCount,
    skippedStages: skippedCount,
    stages: stageResults,
    durationMs: Date.now() - startTime,
    error: pipelineFailed ? `${failedCount} 个阶段失败, ${skippedCount} 个阶段被跳过` : undefined,
    finalContext: stageOutputs,
  };
}

/**
 * 验证流水线定义的合法性（不执行）
 * @param {PipelineDef} def
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validatePipeline(def) {
  const errors = [];
  const warnings = [];

  if (!def) {
    errors.push('流水线定义为空');
    return { valid: false, errors, warnings };
  }

  const stages = def.stages || [];
  if (stages.length === 0) {
    errors.push('流水线至少需要 1 个阶段');
  }

  // 检查名称唯一性
  const names = new Set();
  for (const s of stages) {
    if (!s.name || typeof s.name !== 'string') {
      errors.push('每个阶段必须提供 name');
      continue;
    }
    if (names.has(s.name)) {
      errors.push(`阶段名称重复: ${s.name}`);
    }
    names.add(s.name);
  }

  // 检查依赖合法性
  for (const s of stages) {
    const deps = s.dependsOn || [];
    for (const d of deps) {
      if (!names.has(d)) {
        errors.push(`阶段 "${s.name}" 依赖不存在的阶段 "${d}"`);
      }
    }
  }

  // 检查循环依赖
  if (errors.length === 0) {
    const { error: dagError } = buildDAG(stages);
    if (dagError) errors.push(dagError);
  }

  // 警告
  for (const s of stages) {
    if (s.parallel !== undefined) {
      warnings.push(`阶段 "${s.name}": parallel 参数已弃用，并行由 DAG 自动推断`);
    }
    if (s.retry?.max > 5) {
      warnings.push(`阶段 "${s.name}": retry次数 (${s.retry.max}) 超过建议值 5`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export default {
  runPipeline,
  validatePipeline,
  buildDAG,
  cleanupPipeline,
};
