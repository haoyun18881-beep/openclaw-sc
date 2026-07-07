/**
 * 🦞 sc — 子agent执行中心（task-center）
 *
 * 提供三个核心工具：
 *   core_createTask     — 子agent注册任务，生成taskId，写状态文件
 *   core_reportResult   — 子agent完成任务，结构化压缩结果，原子写文件，不yield
 *   core_collectResults — 主脑收结果，阅后即焚，分批返回
 *
 * 结果自动结构化压缩：
 *   - 提取结论（summary）— 最重要的1-2句话
 *   - 提取关键证据（evidence）— 支撑结论的数据点（最多3）
 *   - 提取建议（recommendation）— 下一步建议
 *   - 压缩率stats（rawSize → compressedSize）
 *
 * 全部写文件到 shared/tasks/ 目录，原子写（tmp+rename）。
 * 子agent调 core_reportResult 后直接退出，不yield。
 * 主脑调 core_collectResults 收集（阅后即焚，读后删文件）。
 */

import { join, dirname } from 'path';
import { homedir } from 'os';
import { readFile, writeFile, mkdir, readdir, unlink, rename, stat } from 'fs/promises';
import { randomBytes, randomUUID } from 'crypto';
import { calculatePriority } from './priority-calc.js';
import { TASK_CENTER_DIR, DEFAULT_BATCH_SIZE } from './constants.js';
import { checkTaskOverSpecificity } from './task-checker.js';
import { StewardGuard } from './steward-rules.js';

// ====== 目录保障 ======

let _ensureCalled = false;

async function ensureTasksDir() {
  try {
    await mkdir(TASK_CENTER_DIR, { recursive: true });
  } catch (err) {
    console.warn(`[task-center] ⚠️ 任务目录创建失败: ${err.message}`);
  }
  _ensureCalled = true;
}

function sanitizeId(id) {
  return String(id || '').replace(/[^a-zA-Z0-9_\-\.]/g, '_');
}

// ====== 内部辅助 ======

/**
 * 单次原子写
 */
async function atomicWrite(fp, data) {
  const tmpSuffix = randomBytes(4).toString('hex');
  const tmp = fp + `.${tmpSuffix}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  await rename(tmp, fp);
}

/**
 * 安全读取+删除（阅后即焚核心）
 * 先 stat 检查文件是否存在，避免并发场景下 rename 竞态
 */
async function readAndDelete(fp) {
  // stat 检查：文件不存在则直接返回 null，避免 rename 竞态
  try {
    await stat(fp);
  } catch {
    return null;
  }

  const readingFp = fp.replace(/\.json$/, '.reading.json');
  try {
    await rename(fp, readingFp);
    const content = await readFile(readingFp, 'utf-8');
    await unlink(readingFp);
    try { await unlink(fp); } catch {} // 清理原文件（rename后原文件可能残留）
    return JSON.parse(content);
  } catch (err) {
    // rename 失败时尝试直接读
    try { await unlink(readingFp); } catch {}
    try {
      const content = await readFile(fp, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }
}

/**
 * 打包结果到任务状态文件
 */
function buildTaskFile(taskId, type, priority, status, output, errors, compensate, startedAt, completedAt) {
  const taskFile = {
    taskId,
    type,
    priority,
    status,
    output: output || {},
    errors: errors || [],
    progress: status === 'done' ? 100 : (status === 'failed' ? 0 : 50),
    startedAt: startedAt || new Date().toISOString(),
    completedAt: completedAt || (status === 'done' || status === 'failed' ? new Date().toISOString() : null),
    compensations: compensate || [],
  };
  return taskFile;
}

/**
 * 结构化压缩：提取 conclusion/evidence/recommendation
 * 不是简单截断，而是按优先级结构化重组
 */
function structuralCompress(data) {
  const rawSize = JSON.stringify(data).length;
  if (rawSize === 0) {
    return {
      summary: '',
      evidence: [],
      recommendation: '',
      compressionStats: { rawSize: 0, compressedSize: 21, ratio: 0, method: 'empty' },
    };
  }

  // 如果data已经是结构化对象，直接提取
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const hasStructured = data.summary || data.evidence || data.recommendation;
    if (hasStructured) {
      const compressedStr = JSON.stringify({
        summary: data.summary || '',
        evidence: (data.evidence || []).slice(0, 3),
        recommendation: data.recommendation || '',
      });
      return {
        summary: String(data.summary || '').substring(0, 500),
        evidence: (data.evidence || []).slice(0, 3),
        recommendation: String(data.recommendation || '').substring(0, 500),
        compressionStats: {
          rawSize,
          compressedSize: compressedStr.length,
          ratio: rawSize > 0 ? Math.round((1 - compressedStr.length / rawSize) * 100) : 0,
          method: 'structured',
        },
      };
    }
  }

  // 非结构化 → 自动提取
  let rawStr = '';
  try {
    rawStr = typeof data === 'string' ? data : JSON.stringify(data);
  } catch {
    rawStr = String(data);
  }

  // 自动提取
  let summary = '';
  let evidence = [];
  let recommendation = '';

  if (rawStr.length < 500) {
    // 短内容，整体当摘要
    summary = rawStr;
  } else {
    // 长内容 → 取前200字做摘要
    summary = rawStr.substring(0, 200) + (rawStr.length > 200 ? '...' : '');

    // 找关键数据点：带 ":" 或 "=" 且非标点符号结尾的行
    const lines = rawStr.split('\n').filter(l => l.trim());
    const dataPoints = lines.filter(l =>
      l.includes(':') || l.includes('=') || l.includes('→') || l.includes('->')
    ).filter(l => !l.match(/^[{}[\]]/));

    // 最多取3
    evidence = dataPoints.slice(0, 3).map(l => l.substring(0, 200));

    // 推荐：取包含"建议"/"推荐"/"should"/"need"/"must"的行
    const recLines = lines.filter(l =>
      /建议|推荐|推荐|should|need|must|next|下一步|then/i.test(l)
    );
    recommendation = recLines.length > 0
      ? recLines.slice(0, 2).join('; ').substring(0, 500)
      : '';
  }

  const compressedObj = { summary, evidence, recommendation };
  const compressedSize = JSON.stringify(compressedObj).length;

  return {
    summary,
    evidence,
    recommendation,
    compressionStats: {
      rawSize,
      compressedSize,
      ratio: rawSize > 0 ? Math.round((1 - compressedSize / rawSize) * 100) : 0,
      method: 'auto-extract',
    },
  };
}

// ====== Excel 公开API ======

/**
 * core_createTask — 注册任务
 * 子agent调此工具注册任务，生成taskId，写状态文件
 *
 * @param {Object} params
 * @param {string} params.type - 任务类型（search/code/analysis/system等）
 * @param {number} [params.priority] - 手动指定优先级(0-10)，不传则自动计算
 * @param {number} [params.timeout] - 超时s数（可选）
 * @returns {Promise<{status: string, taskId: string, priority: number}>}
 */
export async function core_createTask(params) {
  const type = params?.type || 'general';
  const manualPriority = params?.priority;
  const timeout = params?.timeout || 120;

  await ensureTasksDir();

  // 生成taskId
  const taskId = `${sanitizeId(type)}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;

  // 自动计算优先级
  const priority = (manualPriority !== undefined && manualPriority !== null)
    ? Math.max(0, Math.min(10, manualPriority))
    : await calculatePriority(type);

  // ⚠️ 先做提示词质量检查，再写文件（确保 specificityWarn 写入persist）
  const taskText = params?.description || params?.taskName || params?.task || '';
  const specificityCheck = checkTaskOverSpecificity(taskText);

  const taskFile = buildTaskFile(
    taskId,
    type,
    priority,
    'running',
    {},
    [],
    [],
    new Date().toISOString(),
    null
  );

  // 提示词质量检查结果合并到 taskFile（在 atomicWrite 之前）
  if (specificityCheck.level === 'warn') {
    taskFile.specificityWarn = {
      reasons: specificityCheck.reasons,
      suggestion: specificityCheck.suggestion,
    };
  }

  // StewardGuard estimateDelegate：判断是否应派子agent，结果写入 taskFile
  try {
    const delegateEval = StewardGuard.estimateDelegate(taskText);
    taskFile.delegateEval = delegateEval;
  } catch (delegateErr) {
    // estimateDelegate 失败不阻断主流程
    taskFile.delegateEval = { shouldDelegate: null, reason: `评估异常: ${delegateErr.message}`, suggestedLevel: 'auto', tools: ['core_routeTask'] };
  }

  // 合并 timeout 和 createdAt 到主文件（原子性：单文件写入，消除双写孤儿文件）
  taskFile.timeout = timeout;
  taskFile.createdAt = Date.now();

  const fp = join(TASK_CENTER_DIR, `${sanitizeId(taskId)}.json`);
  await atomicWrite(fp, taskFile);

  return {
    status: 'success',
    taskId,
    priority,
    specificityWarn: specificityCheck.level === 'warn' ? specificityCheck.reasons : undefined,
    message: `任务 ${taskId} 已注册（类型=${type}, 优先级=${priority}）` + 
      (specificityCheck.level === 'warn' ? ` ⚠️ 提示词过于具体：${specificityCheck.reasons[0]}` : ''),
  };
}

/**
 * core_reportResult — 完成任务（子agent调）
 * 对data做结构化压缩，原子写任务文件，不yield直接退出
 *
 * @param {Object} params
 * @param {string} params.taskId - 任务ID（由core_createTask返回）
 * @param {string} params.status - 状态: 'success' | 'error' | 'timeout'
 * @param {Object} [params.data] - 原始结果数据
 * @param {string} [params.error] - 错误信息
 * @returns {Promise<{status: string, taskId: string, compressed: boolean, compressionStats: Object}>}
 */
export async function core_reportResult(params) {
  const taskId = params?.taskId;
  if (!taskId) {
    return { status: 'error', errorCode: 'MISSING_TASK_ID', errorDetail: 'missing taskId 参数' };
  }

  const resultStatus = params?.status || 'success';
  const rawData = params?.data || {};
  const rawError = params?.error || '';

  await ensureTasksDir();

  // 1. 结构化压缩
  const compressed = structuralCompress(rawData);

  // 2. 读取现有任务文件（如果存在的话），以保留优先级和类型
  let existingTask = null;
  const existingFp = join(TASK_CENTER_DIR, `${sanitizeId(taskId)}.json`);
  try {
    const existingRaw = await readFile(existingFp, 'utf-8');
    existingTask = JSON.parse(existingRaw);
  } catch {}

  // 3. 写任务文件
  const taskFile = buildTaskFile(
    taskId,
    existingTask?.type || 'general',
    existingTask?.priority || 5,
    resultStatus === 'success' ? 'done' : resultStatus === 'error' ? 'failed' : 'timeout',
    compressed,
    rawError ? [rawError] : (existingTask?.errors || []),
    [],
    existingTask?.startedAt || new Date().toISOString(),
    new Date().toISOString()
  );

  await atomicWrite(existingFp, taskFile);

  // 清理旧版元数据标记（v2.0前遗留的 .meta.json，向后兼容）
  const metaFp = join(TASK_CENTER_DIR, `${sanitizeId(taskId)}.meta.json`);
  try { await unlink(metaFp); } catch {}

  return {
    status: 'success',
    taskId,
    compressed: true,
    compressionStats: compressed.compressionStats,
  };
}

/**
 * core_collectResults — 主脑收结果
 * 扫 shared/tasks/ 目录，取已完成任务，阅后即焚
 *
 * @param {Object} [params]
 * @param {number} [params.batchSize] - 每次返回的任务数（默认DEFAULT_BATCH_SIZE）
 * @returns {Promise<{status: string, collected: number, results: Array, errors: Array}>}
 */
export async function core_collectResults(params) {
  const batchSize = params?.batchSize || DEFAULT_BATCH_SIZE;

  await ensureTasksDir();

  // 收集结果：主文件（不含 .meta. 和 .tmp 和 .reading.）
  let files = [];
  try {
    files = await readdir(TASK_CENTER_DIR);
  } catch {
    return { status: 'success', collected: 0, results: [], errors: [] };
  }

  const taskFiles = files.filter(f =>
    f.endsWith('.json') &&
    !f.endsWith('.meta.json') &&
    !f.endsWith('.tmp') &&
    !f.endsWith('.reading.json')
  );

  // 按修改时间排序（最新的优先）
  const withMtime = await Promise.all(
    taskFiles.map(async (f) => {
      try {
        const st = await stat(join(TASK_CENTER_DIR, f));
        return { name: f, mtime: st.mtimeMs };
      } catch {
        return { name: f, mtime: 0 };
      }
    })
  );
  withMtime.sort((a, b) => b.mtime - a.mtime);
  const sortedFiles = withMtime.map(f => f.name);

  // 阅后即焚
  const results = [];
  const errors = [];
  const toCollect = sortedFiles.slice(0, batchSize);

  for (const f of toCollect) {
    try {
      const data = await readAndDelete(join(TASK_CENTER_DIR, f));
      if (data !== null) {
        results.push(data);
      }
    } catch (err) {
      errors.push({ file: f, error: err.message });
    }
  }

  // 清理孤儿 .reading.json（上一轮崩溃遗留）
  const readingFiles = files.filter(f => f.endsWith('.reading.json'));
  for (const rf of readingFiles) {
    try { await unlink(join(TASK_CENTER_DIR, rf)); } catch {}
  }

  return {
    status: 'success',
    collected: results.length,
    results,
    errors: errors.length > 0 ? errors : undefined,
  };
}

// ====== Checkpoint 系统（子agent强杀保护）======

const CHECKPOINT_SHARED_DIR = join(homedir(), '.openclaw', 'workspace', 'memory', 'shared');

export const CHECKPOINT_DIR = join(CHECKPOINT_SHARED_DIR, 'checkpoints');
const CHECKPOINT_MAX_AGE_MS = 30 * 60 * 1000; // 30min

let _checkpointDirEnsured = false;

export async function ensureCheckpointDir() {
  if (_checkpointDirEnsured) return;
  try { await mkdir(CHECKPOINT_DIR, { recursive: true }); _checkpointDirEnsured = true; } catch {}
}

/**
 * 从 checkpoint session JSONL 文件中提取已完成的步骤
 */
function extractCheckpointSteps(messages) {
  const steps = [];
  for (const msg of messages) {
    if (msg?.type === 'message' && msg?.message?.role === 'assistant') {
      const content = typeof msg.message?.content === 'string' ? msg.message.content : '';
      const stepMatches = content.matchAll(/步骤\s*[：:]\s*([^\n。]+)/g);
      for (const m of stepMatches) steps.push(m[1].trim());
    }
    if (msg?.type === 'tool_call') {
      steps.push(`调用了 ${msg.toolName || msg.name || 'unknown'}`);
    }
  }
  return [...new Set(steps)].slice(0, 20);
}

/**
 * 从 checkpoint session 消息中提取部分输出结果
 */
function extractCheckpointOutputs(messages) {
  const outputs = {};
  for (const msg of messages) {
    if (msg?.type === 'tool_result') {
      const toolName = msg.toolName || msg.name || 'unknown';
      const result = typeof msg.result === 'string' ? msg.result.substring(0, 500) : JSON.stringify(msg.result || '').substring(0, 500);
      if (result && result !== '{}') outputs[toolName] = result;
    }
    if (msg?.type === 'message' && msg?.message?.role === 'user') {
      const text = typeof msg.message?.content === 'string' ? msg.message.content : '';
      if (text) outputs['lastUserInput'] = text.substring(0, 1000);
    }
  }
  return outputs;
}

/**
 * 从 checkpoint session 消息中提取错误计数
 */
function extractCheckpointErrors(messages, sessionData = {}) {
  let count = 0;
  for (const msg of messages) {
    if (msg?.type === 'tool_result' && msg.error) count++;
    if (msg?.type === 'tool_call' && msg.error) count++;
  }
  for (const s of Object.values(sessionData)) {
    if (s?.errorCount) count += s.errorCount;
    if (s?.errors?.length) count += s.errors.length;
  }
  return count;
}

/**
 * 保存 checkpoint 到 shared/checkpoints/{sessionId}.json
 * 增强版：尝试读取 session 的 JSONL 文件获取完整上下文，提取已完成步骤、部分结果、错误计数
 *
 * @param {string} sessionId - 子agent session ID
 * @param {Object} [extraData={}] - 额外数据
 * @param {string} [extraData.taskName] - 任务名称
 * @param {string[]} [extraData.completedSteps] - 手动指定的已完成步骤
 * @param {Object} [extraData.partialOutputs] - 手动指定的部分输出
 * @param {number} [extraData.errorCount] - 手动指定的错误计数
 * @returns {Promise<string|null>} 文件路径或 null
 */
export async function saveCheckpoint(sessionId, extraData = {}) {
  try {
    await ensureCheckpointDir();

    // 1. 读取 session 的 JSONL 文件获取最近消息（真正执行过的上下文）
    let sessionMessages = [];
    try {
      const sessionsDir = join(homedir(), '.openclaw', 'agents', 'main', 'sessions');
      const files = await readdir(sessionsDir).catch(() => []);
      const jsonlFile = files.find(f => f.startsWith(sessionId) && f.endsWith('.jsonl') && !f.includes('.trajectory'));
      if (jsonlFile) {
        const raw = await readFile(join(sessionsDir, jsonlFile), 'utf-8');
        sessionMessages = raw.trim().split('\n').slice(-50).map(l => {
          try { return JSON.parse(l); } catch { return null; }
        }).filter(Boolean);
      }
    } catch {}

    // 2. 尝试从 sessions.json 读取会话元数据
    let sessionData = {};
    try {
      const sessionsJsonPath = join(homedir(), '.openclaw', 'agents', 'main', 'sessions.json');
      const raw = await readFile(sessionsJsonPath, 'utf-8');
      const data = JSON.parse(raw);
      for (const [key, session] of Object.entries(data)) {
        if (session.sessionId === sessionId) {
          sessionData[key] = { ...session };
        }
      }
    } catch {}

    // 3. 从消息中提取完成步骤、部分输出、错误计数
    const completedSteps = extractCheckpointSteps(sessionMessages);
    const partialOutputs = extractCheckpointOutputs(sessionMessages);
    const errorCount = extractCheckpointErrors(sessionMessages, sessionData);

    // 4. 构建 checkpoint（extraData 优先级高于自动提取，允许手动覆盖）
    const checkpoint = {
      sessionId,
      taskName: extraData.taskName || '',
      sessionData,
      recentMessages: sessionMessages.slice(-20),
      completedSteps: extraData.completedSteps?.length ? extraData.completedSteps : completedSteps,
      partialOutputs: extraData.partialOutputs ? { ...extraData.partialOutputs, ...partialOutputs } : partialOutputs,
      errorCount: extraData.errorCount ?? errorCount,
      interruptedAt: Date.now(),
      createdAt: Date.now(),
    };

    const safeName = (sessionId || 'unknown').replace(/[^a-zA-Z0-9_\-]/g, '_').substring(0, 100);
    const fp = join(CHECKPOINT_DIR, `${safeName}.json`);
    await atomicWrite(fp, checkpoint);
    // TODO: 移除调试日志 console.log(`[task-center] 💾 Checkpoint 已保存: ${sessionId}`);
    return fp;
  } catch (err) {
    console.warn(`[task-center] ⚠️ Checkpoint 保存失败: ${err.message}`);
    return null;
  }
}

/**
 * 读取 checkpoint, 30min过期自动清理
 *
 * @param {string} sessionId - 子agent session ID
 * @returns {Promise<Object|null>} checkpoint 对象或 null
 */
export async function readCheckpoint(sessionId) {
  try {
    await ensureCheckpointDir();
    const safeId = (sessionId || 'unknown').replace(/[^a-zA-Z0-9_\-]/g, '_').substring(0, 100);
    const fp = join(CHECKPOINT_DIR, `${safeId}.json`);
    const content = await readFile(fp, 'utf-8');
    const checkpoint = JSON.parse(content);

    const age = Date.now() - (checkpoint.createdAt || checkpoint.interruptedAt || 0);
    if (age > CHECKPOINT_MAX_AGE_MS) {
      // TODO: 移除调试日志 console.log(`[task-center] ⏰ Checkpoint ${sessionId} 已过期 (${Math.round(age / 60000)}min > 30min)`);
      await unlink(fp).catch(() => {});
      return null;
    }

    return checkpoint;
  } catch {
    return null;
  }
}

/**
 * 清理超过30min的 checkpoint 文件
 */
export async function cleanupCheckpoints() {
  try {
    await ensureCheckpointDir();
    const files = await readdir(CHECKPOINT_DIR).catch(() => []);
    const now = Date.now();
    let cleaned = 0;
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const content = await readFile(join(CHECKPOINT_DIR, f), 'utf-8');
        const cp = JSON.parse(content);
        const age = now - (cp.createdAt || cp.interruptedAt || 0);
        if (age > CHECKPOINT_MAX_AGE_MS) {
          await unlink(join(CHECKPOINT_DIR, f));
          cleaned++;
        }
      } catch {
        // 损坏的文件也清理
        try { await unlink(join(CHECKPOINT_DIR, f)); cleaned++; } catch {}
      }
    }
    if (cleaned > 0) console.log(`[task-center] 🧹 清理了 ${cleaned} 个过期 Checkpoint`);
  } catch {}
}
