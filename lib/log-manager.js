/**
 * 🦞 sc 独立日志系统 + hippocampus集成
 *
 * 日志目录: plugins/sc/logs/
 * 分文件: worker-pool.log / error.log / access.log
 * 轮转: 单文件最大5MB, 超限自动切割, 滚动保留5个历史
 * hippocampus: 日志缓冲后每15min写入 memory/hippocampus/logs.jsonl
 */

import { mkdir, appendFile, stat, rename, unlink } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
// 🔧 移除未使用的 existsSync/constants 导入

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ====== 路径常量 ======
const LOG_DIR = join(__dirname, '..', 'logs');
const HIPPOCAMPUS_DIR = join(__dirname, '..', '..', '..', 'memory', 'hippocampus');
const LOGS_JSONL = join(HIPPOCAMPUS_DIR, 'logs.jsonl');

// ====== 轮转常量 ======
const MAX_LOG_SIZE = 5 * 1024 * 1024;  // 5MB
const MAX_LOG_FILES = 5;                // 保留5个历史文件

// ====== 日志文件路径 ======
const LOG_FILES = {
  worker: join(LOG_DIR, 'worker-pool.log'),
  error: join(LOG_DIR, 'error.log'),
  access: join(LOG_DIR, 'access.log'),
};

// ====== hippocampus缓冲 ======
let hippocampusBuffer = [];
let hippocampusTimer = null;
const HIPPOCAMPUS_FLUSH_INTERVAL = 15 * 60 * 1000; // 15min
const MAX_BUFFER_LINES = 10000; // 最大缓冲行数，超出丢弃最旧数据，防OOM

// ====== 轮转锁：防止并发 rotateIfNeeded 的 TOCTOU 竞态 ======
const rotateLocks = new Map();

/**
 * 获取文件粒度的互斥锁（promise-based）
 * @param {string} key - 文件路径
 * @returns {Promise<() => void>} 解锁函数
 */
async function acquireRotateLock(key) {
  while (rotateLocks.has(key)) {
    await rotateLocks.get(key);
  }
  let unlock;
  const promise = new Promise(resolve => { unlock = resolve; });
  rotateLocks.set(key, promise);
  return unlock;
}

// ====== 初始化标记 ======
let _initialized = false;

// ====== 格式化时间戳 ======
function ts() {
  const now = new Date();
  return now.toISOString().replace('T', ' ').substring(0, 19) + '.' +
    String(now.getMilliseconds()).padStart(3, '0');
}

// ====== 确保日志目录存在 ======
async function ensureLogDir() {
  try {
    await mkdir(LOG_DIR, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

// ====== 日志轮转：检查文件大小，超限则滚动（带锁防TOCTOU竞态） ======
async function rotateIfNeeded(filePath) {
  const unlock = await acquireRotateLock(filePath);
  try {
    let stats;
    try {
      stats = await stat(filePath);
    } catch (err) {
      // ENOENT = 文件还不存在，无需轮转
      if (err.code === 'ENOENT') return;
      throw err;
    }
    if (stats.size < MAX_LOG_SIZE) return;

    // 删除最旧的备份
    const oldest = `${filePath}.${MAX_LOG_FILES}`;
    try { await unlink(oldest); } catch { /* 可能不存在 */ }

    // 移位：.4 → .5, .3 → .4, ..., .1 → .2
    for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
      const src = `${filePath}.${i}`;
      const dst = `${filePath}.${i + 1}`;
      try { await rename(src, dst); } catch { /* 可能不存在 */ }
    }

    // 当前文件 → .1
    await rename(filePath, `${filePath}.1`);
  } catch (err) {
    // 只抛出非预期错误
    if (err.code !== 'ENOENT') throw err;
  } finally {
    // 释放锁
    rotateLocks.delete(filePath);
    unlock();
  }
}

// ====== 写入一行到日志文件（含自动轮转） ======
async function writeLog(filePath, line) {
  try {
    await rotateIfNeeded(filePath);
    await appendFile(filePath, line + '\n', 'utf-8');
  } catch (err) {
    console.error(`[log-manager] ⚠️ 写入日志失败 [${filePath}]: ${err.message}`);
  }
}

// ====== Worker 日志 ======
async function logWorker(workerId, message) {
  const line = `[${ts()}] [Worker-${workerId}] ${message}`;
  await writeLog(LOG_FILES.worker, line);
}

// ====== 错误日志 ======
async function logError(source, message, stack) {
  const stackPart = stack ? `\n${stack}` : '';
  const line = `[${ts()}] [${source}] ${message}${stackPart}`;
  await writeLog(LOG_FILES.error, line);
}

// ====== 访问日志 ======
async function logAccess(tool, params, durationMs, resultStatus) {
  const paramSummary = params
    ? (typeof params === 'string' ? params : JSON.stringify(params).substring(0, 200))
    : '';
  const line = `[${ts()}] [ACCESS] tool=${tool} duration=${durationMs}ms status=${resultStatus || 'ok'} params=${paramSummary}`;
  await writeLog(LOG_FILES.access, line);
}

// ====== Worker 事件日志 ======
async function logWorkerEvent(workerId, event, details) {
  const line = `[${ts()}] [Worker-${workerId}] [${event}] ${details}`;
  await writeLog(LOG_FILES.worker, line);
}

// ====== 通用日志（供 console 拦截使用） ======
async function log(level, source, message) {
  const line = `[${ts()}] [${level.toUpperCase()}] [${source}] ${message}`;
  await writeLog(LOG_FILES.worker, line);
  if (level === 'error' || level === 'warn') {
    await writeLog(LOG_FILES.error, line);
  }
}

// ====== 将缓冲日志刷入hippocampus ======
async function flushToHippocampus() {
  if (hippocampusBuffer.length === 0) return;
  const batch = hippocampusBuffer.splice(0, hippocampusBuffer.length);
  try {
    const lines = batch.map(entry => JSON.stringify(entry)).join('\n') + '\n';
    await appendFile(LOGS_JSONL, lines, 'utf-8');
  } catch (err) {
    console.error(`[log-manager] ⚠️ hippocampuswrite failed: ${err.message}`);
    // 失败时回放缓冲，不丢数据
    hippocampusBuffer.unshift(...batch);
  }
}

// ====== 将日志目加入hippocampus缓冲（队列模式，防OOM） ======
function bufferForHippocampus(entry) {
  hippocampusBuffer.push({
    timestamp: ts(),
    ...entry,
  });
  // 队列模式：超出上限则丢弃最旧数据
  if (hippocampusBuffer.length > MAX_BUFFER_LINES) {
    hippocampusBuffer.splice(0, hippocampusBuffer.length - MAX_BUFFER_LINES);
  }
}

// ====== 启动hippocampus定时刷入 ======
function startHippocampusFlush() {
  if (hippocampusTimer) return;
  hippocampusTimer = setInterval(() => {
    flushToHippocampus().catch(err => {
      console.error(`[log-manager] ⚠️ hippocampus定时刷入失败: ${err.message}`);
    });
  }, HIPPOCAMPUS_FLUSH_INTERVAL);

  // 进程退出前刷一次
  process.on('beforeExit', () => {
    flushToHippocampus().catch(() => {});
  });
}

// ====== 停止hippocampus定时刷入 ======
function stopHippocampusFlush() {
  if (hippocampusTimer) {
    clearInterval(hippocampusTimer);
    hippocampusTimer = null;
  }
  // 最终刷一次
  flushToHippocampus().catch(() => {});
}

// ====== 初始化日志系统 ======
async function initLogger() {
  if (_initialized) return getLogger();
  _initialized = true;

  await ensureLogDir();
  startHippocampusFlush();

  const initMsg = `===== sc 日志系统初始化 [${new Date().toISOString()}] =====`;
  await writeLog(LOG_FILES.worker, initMsg);
  await writeLog(LOG_FILES.error, initMsg);
  await writeLog(LOG_FILES.access, initMsg);

  // TODO: 移除调试日志 console.log('[sc] 📋 日志系统已初始化 (目录: logs/, 轮转: 5MB×5, hippocampus: 15min)');

  return getLogger();
}

// ====== 获取日志 API 引用 ======
function getLogger() {
  return {
    logWorker,
    logError,
    logAccess,
    logWorkerEvent,
    log,
    flush: flushToHippocampus,
    bufferForHippocampus,
    stop: stopHippocampusFlush,
    LOG_DIR,
    initialized: _initialized,
  };
}

export {
  initLogger,
  getLogger,
  logWorker,
  logError,
  logAccess,
  logWorkerEvent,
  log,
  flushToHippocampus,
  bufferForHippocampus,
  startHippocampusFlush,
  stopHippocampusFlush,
};
