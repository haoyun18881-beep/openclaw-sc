/**
 * ⚡ 高优任务抢占模块 — 高优任务抢占
 *
 * 当所有Worker忙碌 + 队列深度 > PREEMPT_QUEUE_THRESHOLD（26）时触发preempt评估：
 * 1. 计算每个活跃任务的优先级分 = f(紧急度 × 价值 × (1 - 运行占比))
 * 2. 最低分任务被抢占，状态序列化到 shared/preempt/
 * 3. 被抢任务在队列头部等待恢复（恢复到原角色的stemcell）
 *
 * 与 Worker 分化协作：stemcell 优先接手被抢占任务（因原Worker可能已满负荷）
 */

import crypto from "crypto";
import { join } from "path";
import { readFile, writeFile, rename, unlink, mkdir, readdir, stat } from "fs/promises";
import { SHARED_DIR, PREEMPT_TASK_TIMEOUT_MS, PREEMPT_MAX_AGE_MS, PREEMPT_QUEUE_THRESHOLD } from './constants.js';

const PREEMPT_DIR = join(SHARED_DIR, 'preempt');

/**
 * 确保 preempt 目录存在
 */
export async function ensurePreemptDir() {
  try { await mkdir(PREEMPT_DIR, { recursive: true }); } catch (err) {
    console.warn(`[sc] ⚠️ mkdir PREEMPT_DIR失败: ${err?.message || '未知错误'}`);
  }
}

/**
 * 计算任务优先级分
 * score = urgency × value × (1 - runtimeRatio)
 *   - urgency: high=1.0, normal=0.6, low=0.3
 *   - value: 任务预估值 [0.1, 1.0]（未设定=0.5）
 *   - runtimeRatio: 已运行时间/超时阈值 [0, 1]
 * 分数越低 → 越容易被preempt
 *
 * 🧠 [设计决策] 高优任务抢占策略：当所有Worker忙碌且队列深度>26（PREEMPT_QUEUE_THRESHOLD）时触发，
 * 按优先级分抢占最低分任务，保持系统响应性。被抢任务序列化到shared/preempt/，
 * 由stemcell兜底恢复。
 * （详见 memory/known-design-decisions.md — 架构设计）
 *
 * @param {object} task - 任务对象
 * @param {object} workerEntry - 正在执行该任务的Worker
 * @param {number} taskTimeoutMs - 该任务类型的超时阈值
 * @returns {number} 优先级分 [0, 1]
 */
function calculatePriorityScore(task, workerEntry, taskTimeoutMs) {
  const priority = task.priority || 'normal';
  const urgency = priority === 'high' ? 1.0 : priority === 'normal' ? 0.6 : 0.3;
  const runtime = Date.now() - (workerEntry.currentJobStartTime || workerEntry.idleSince || Date.now());
  const timeout = taskTimeoutMs || 60000;
  const runtimeRatio = Math.min(1, Math.max(0, runtime / timeout));
  const estimatedValue = task._estimatedValue ?? 0.5;
  const finalScore = urgency * estimatedValue * (1 - runtimeRatio);
  return finalScore;
}

/**
 * 评估是否需要触发preempt
 *
 * @param {object} pool - Worker 池实例（用于 getStats）
 * @param {object} taskQueues - {high, normal, low} 队列
 * @param {Array} workers - Worker 列表
 * @returns {{ shouldPreempt: boolean, target: object|null, reason: string }}
 */
export function evaluatePreemption(pool, taskQueues, workers) {
  const stats = pool.getStats();
  const totalQueued = (taskQueues.high?.length || 0) +
                      (taskQueues.normal?.length || 0) +
                      (taskQueues.low?.length || 0);

  // 阈值检查：所有Worker忙碌 + 队列深度 >= PREEMPT_QUEUE_THRESHOLD 才触发preempt
  if (totalQueued < PREEMPT_QUEUE_THRESHOLD) {
    return { shouldPreempt: false, target: null, reason: `队列深度 ${totalQueued} < ${PREEMPT_QUEUE_THRESHOLD}，无需preempt` };
  }

  const aliveBusy = workers.filter(w => w.alive && w.busy && !w.terminating && w.currentJobId);
  if (aliveBusy.length === 0) {
    return { shouldPreempt: false, target: null, reason: '没有活跃的忙碌Worker' };
  }

  // 遍历所有活跃任务，计算最低分
  let lowestScore = Infinity;
  let targetTask = null;
  let targetWorker = null;

  for (const we of aliveBusy) {
    const jobId = we.currentJobId;
    if (!jobId) continue;

    // 从 pendingJobs 中找原始任务（通过jobId）
    const pendingJob = pool._pendingJobs?.get?.(jobId);
    if (!pendingJob) continue;

    const task = pendingJob._task || pendingJob.task;
    if (!task) continue;

    const taskType = task.type || 'default';
    const typeConfig = pool._taskTimeoutMap?.[taskType] || pool._taskTimeoutMap?.default || {};
    const killTimeout = typeConfig.kill || 120;
    const taskTimeoutMs = (killTimeout || 120) * 1000;

    const score = calculatePriorityScore(task, we, taskTimeoutMs);
    if (score < lowestScore) {
      lowestScore = score;
      targetTask = { task, jobId, workerEntry: we, pendingJob, timeoutMs: taskTimeoutMs, score };
    }
  }

  if (!targetTask) {
    return { shouldPreempt: false, target: null, reason: '未找到可评估的活跃任务' };
  }

  return {
    shouldPreempt: true,
    target: targetTask,
    reason: `preempt评估完成: 最低分=${targetTask.score.toFixed(3)} (任务=${targetTask.task.type}, Worker=${targetTask.workerEntry.id})`,
  };
}

/**
 * 序列化被抢占任务的状态到 shared/preempt/
 *
 * @param {object} target - evaluatePreemption 返回的 target
 * @returns {Promise<string|null>} 状态文件路径，失败返回 null
 */
export async function savePreemptState(target) {
  try {
    await ensurePreemptDir();
    const jobId = target.jobId;
    const state = {
      jobId,
      task: target.task,
      preemptedAt: Date.now(),
      preemptedFromWorker: target.workerEntry.id,
      workerRole: target.workerEntry.role,
      score: target.score,
      partialResult: target.workerEntry.partialResult || null,
      pendingJobResolve: null,  // 不序列化函数引用
      pendingJobReject: null,
    };
    const fp = join(PREEMPT_DIR, `${jobId}.json`);
    const tmp = join(PREEMPT_DIR, `${jobId}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
    await rename(tmp, fp);
    return fp;
  } catch (err) {
    console.warn(`[sc] ⚠️ 保存preempt状态失败: ${err.message}`);
    return null;
  }
}

/**
 * 读取被抢占任务的状态
 *
 * @param {string} jobId - 被抢占任务的 jobId
 * @returns {Promise<object|null>} 任务状态
 */
export async function readPreemptState(jobId) {
  try {
    await ensurePreemptDir();
    const fp = join(PREEMPT_DIR, `${jobId}.json`);
    const content = await readFile(fp, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    console.warn(`[sc] ⚠️ 读取preempt状态失败(jobId=${jobId}): ${err?.message || '未知错误'}`);
    return null;
  }
}

/**
 * 清除指定的抢占状态文件（恢复或超时删除后调用）
 *
 * @param {string} jobId
 */
export async function clearPreemptState(jobId) {
  try {
    const fp = join(PREEMPT_DIR, `${jobId}.json`);
    await unlink(fp).catch(() => {});
  } catch (err) {
    console.warn(`[sc] ⚠️ 清理preempt状态失败(jobId=${jobId}): ${err?.message || '未知错误'}`);
  }
}

/**
 * 列出所有被抢占但尚未恢复的任务
 * 会过滤掉超过 PREEMPT_MAX_AGE_MS 的失效率任务
 *
 * @returns {Promise<Array>} 待恢复任务列表（按被抢时间升序）
 */
export async function listPreemptedTasks() {
  try {
    await ensurePreemptDir();
    const files = await readdir(PREEMPT_DIR).catch(() => []);
    const tasks = [];
    const now = Date.now();
    let cleaned = 0;

    for (const f of files) {
      if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
      const fp = join(PREEMPT_DIR, f);
      try {
        const content = await readFile(fp, 'utf-8');
        const state = JSON.parse(content);
        const age = now - (state.preemptedAt || now);
        if (age > PREEMPT_MAX_AGE_MS) {
          await unlink(fp);
          cleaned++;
          continue;
        }
        tasks.push({
          ...state,
          stateFilePath: fp,
          ageMs: age,
          ageSec: Math.round(age / 1000),
        });
      } catch (err) {
        // 损坏的文件也清理
        console.warn(`[sc] ⚠️ 读取preempt文件失败 ${f}: ${err?.message || '未知错误'}`);
        try { await unlink(fp); cleaned++; } catch (e2) {
          console.warn(`[sc] ⚠️ 删除损坏preempt文件失败 ${f}: ${e2?.message || '未知错误'}`);
        }
      }
    }

    if (cleaned > 0) {
      // TODO: 移除调试日志 console.log(`[sc] 🧹 清理了 ${cleaned} 个过期/损坏的抢占状态文件`);
    }

    // 按被抢时间升序（最老的优先恢复）
    tasks.sort((a, b) => (a.preemptedAt || 0) - (b.preemptedAt || 0));
    return tasks;
  } catch (err) {
    console.warn(`[sc] ⚠️ list preempted tasks failed: ${err.message}`);
    return [];
  }
}

/**
 * 清理超时的抢占状态文件
 */
export async function cleanupExpiredPreemptStates() {
  try {
    await ensurePreemptDir();
    const files = await readdir(PREEMPT_DIR).catch(() => []);
    const now = Date.now();
    let cleaned = 0;
    for (const f of files) {
      if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
      const fp = join(PREEMPT_DIR, f);
      try {
        const content = await readFile(fp, 'utf-8');
        const state = JSON.parse(content);
        if (now - (state.preemptedAt || now) > PREEMPT_MAX_AGE_MS) {
          await unlink(fp);
          cleaned++;
        }
      } catch (err) {
        console.warn(`[sc] ⚠️ 清理过期preempt文件失败 ${f}: ${err?.message || '未知错误'}`);
        try { await unlink(fp); cleaned++; } catch (e2) {
          console.warn(`[sc] ⚠️ 删除过期preempt文件失败 ${f}: ${e2?.message || '未知错误'}`);
        }
      }
    }
    if (cleaned > 0) console.log(`[sc] 🧹 清理了 ${cleaned} 个过期抢占状态`);
  } catch (err) {
    console.warn(`[sc] ⚠️ cleanupExpiredPreemptStates失败: ${err?.message || '未知错误'}`);
  }
}

export default {
  ensurePreemptDir,
  evaluatePreemption,
  savePreemptState,
  readPreemptState,
  clearPreemptState,
  listPreemptedTasks,
  cleanupExpiredPreemptStates,
};
