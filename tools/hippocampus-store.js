/**
 * hippocampus-store.js — hippocampus存储
 * 
 * 提供 recordEvent() 接口，自动记录工具调用事件到hippocampus永久存储。
 * 
 * 存储架构：
 *   主存储： ~/.openclaw/workspace/memory/hippocampus/events.jsonl
 *   次级存储（高水位时自动启用归档）
 * 
 * 每记录的 schema：
 *   {
 *     eventId: "hippo_<timestamp>_<random>",
 *     type: "tool_call",
 *     timestamp: "ISO8601",
 *     toolName: "cpu_xxx",
 *     params: { ... },        // 参数（自动截断）
 *     result: { ... },        // 返回结果（自动截断）
 *     duration: 123,          // 耗时(ms)
 *     status: "success" | "error",
 *     sessionId: "xxx",
 *   }
 *
 * v1.0.3 — 2026-06-10
 *   - 修复空catch块加warn日志
 *   - queryRecentEvents JSON.parse 加 try-catch 防崩溃
 */

import { appendFile, mkdir, writeFile, readFile, access } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';
import { existsSync } from 'fs';

// ====== 常量 ======
const WORKSPACE_ROOT = join(homedir(), '.openclaw', 'workspace');
const EVENTS_FILE = join(WORKSPACE_ROOT, 'memory', 'hippocampus', 'events.jsonl');
const INDEX_FILE = join(WORKSPACE_ROOT, 'memory', 'hippocampus', 'index.json');
const MAX_PARAMS_LENGTH = 512;   // 参数截断长度
const MAX_RESULT_LENGTH = 1024;  // 结果截断长度
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB 自动归档

// ====== 内部状态 ======
let _initialized = false;
let _fallbackDir = null;

// ====== 路径工具 ======
function ensureDir(p) {
  return mkdir(dirname(p), { recursive: true });
}

function generateEventId() {
  const ts = Date.now();
  const rand = randomBytes(4).readUInt32BE(0).toString(36);
  return `hippo_${ts}_${rand}`;
}

function truncateObj(obj, maxLen) {
  if (!obj) return obj;
  // 先试试完整序列化是否超长
  const str = JSON.stringify(obj);
  if (str.length <= maxLen) return obj;
  // 超长了：不截断JSON字符串（那样必然破坏结构），
  // 而是在对象结构层面递归截断字符串值，保证输出永远是合法 JSON
  const result = deepTruncate(obj, maxLen);
  const finalStr = JSON.stringify(result);
  // 如果递归截断后仍然超长（罕见），回退到标记截断
  if (finalStr.length > maxLen) {
    return { _truncated: true, _keys: typeof obj === 'object' ? Object.keys(obj).slice(0, 20) : undefined };
  }
  return result;
}

/**
 * 递归截断对象中的字符串值，保证 JSON 结构完整
 * 每个字符串值按比例分配预算，确保整体不超过 maxLen
 */
function deepTruncate(value, budget) {
  if (typeof value === 'string') {
    if (value.length <= budget) return value;
    // 留 '..."' 的余量（3字符），最多截到20字符
    const keep = Math.max(20, budget - 3);
    return value.substring(0, keep) + '...';
  }
  if (Array.isArray(value)) {
    return value.map(item => deepTruncate(item, Math.floor(budget / Math.max(value.length, 1))));
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    const result = {};
    for (const key of keys) {
      result[key] = deepTruncate(value[key], Math.max(20, Math.floor(budget / Math.max(keys.length, 1))));
    }
    return result;
  }
  return value;
}

// ====== 初始化 ======
let _writeQueue = Promise.resolve();

async function initStore() {
  if (_initialized) return true;

  // 主存储路径
  try {
    await ensureDir(EVENTS_FILE);
    // 确保文件存在
    try { await access(EVENTS_FILE); } catch { await writeFile(EVENTS_FILE, '', 'utf-8'); }
    // 确保索引文件存在
    try { await access(INDEX_FILE); } catch {
      await writeFile(INDEX_FILE, JSON.stringify({
        version: 1,
        created: new Date().toISOString(),
        totalEvents: 0,
        lastEventId: null,
      }, null, 2), 'utf-8');
    }
    _initialized = true;
    return true;
  } catch (err) {
    // 主存储不可用，启用回退：写入临时目录
    _fallbackDir = join(homedir(), '.openclaw', 'workspace', 'memory', 'hippocampus_fallback');
    try {
      const fbFile = join(_fallbackDir, 'events.jsonl');
      await ensureDir(fbFile);
      try { await access(fbFile); } catch { await writeFile(fbFile, '', 'utf-8'); }
      console.warn('[hippocampus] ⚠️ 主存储不可用，切换到回退路径:', _fallbackDir);
      _initialized = true;
      return true;
    } catch (fbErr) {
      console.warn('[hippocampus] ❌ 存储init failed（主+回退均不可用）:', fbErr.message);
      return false;
    }
  }
}

// ====== 核心 API 接口 ======

/**
 * 记录一个工具调用事件到hippocampus
 * 
 * @param {Object} event - 事件数据
 * @param {string} event.toolName - 工具名
 * @param {Object} [event.params] - 调用参数
 * @param {Object} [event.result] - 返回结果
 * @param {number} event.duration - 耗时(ms)
 * @param {string} event.status - "success" 或 "error"
 * @param {string} [event.sessionId] - 会话ID
 * @returns {Promise<Object>} { success: boolean, eventId?: string, error?: string }
 */
export async function recordEvent({ toolName, params, result, duration, status, sessionId }) {
  try {
    if (!toolName) {
      return { success: false, error: 'missing toolName' };
    }

    const initialized = await initStore();
    if (!initialized) {
      return { success: false, error: 'hippocampus存储不可用' };
    }

    const eventId = generateEventId();
    const entry = {
      eventId,
      type: 'tool_call',
      timestamp: new Date().toISOString(),
      toolName,
      params: truncateObj(params, MAX_PARAMS_LENGTH),
      result: truncateObj(result, MAX_RESULT_LENGTH),
      duration: typeof duration === 'number' ? Math.round(duration) : 0,
      status: status || (result && !result.error ? 'success' : 'error'),
      sessionId: sessionId || '',
    };

    const line = JSON.stringify(entry) + '\n';

    // 串行写入（防并发交错）
    _writeQueue = _writeQueue.then(async () => {
      const targetFile = _fallbackDir
        ? join(_fallbackDir, 'events.jsonl')
        : EVENTS_FILE;
      
      await appendFile(targetFile, line, 'utf-8');

      // 更新索引stats
      try {
        const raw = await readFile(INDEX_FILE, 'utf-8');
        const idx = JSON.parse(raw);
        idx.totalEvents = (idx.totalEvents || 0) + 1;
        idx.lastEventId = eventId;
        idx.lastUpdated = new Date().toISOString();
        await writeFile(INDEX_FILE, JSON.stringify(idx, null, 2), 'utf-8');
      } catch (e) {
        // 索引更新失败不影响主流程
        console.warn('[hippocampus] ⚠️ 索引更新失败:', e.message);
      }

      // 检查文件大小，触发归档
      try {
        const stats = await import('fs').then(fs => fs.promises.stat(targetFile));
        if (stats.size > MAX_FILE_SIZE) {
          await rotateLog(targetFile);
        }
      } catch (e) {
        // 文件大小检查非关键
        console.warn('[hippocampus] ⚠️ 文件大小检查失败:', e.message);
      }
    });

    await _writeQueue;
    return { success: true, eventId };
  } catch (err) {
    console.warn('[hippocampus] ❌ recordEvent 失败:', err.message);
    return { success: false, error: err.message };
  }
}

// ====== 文件轮转归档 ======
async function rotateLog(filePath) {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const archivePath = filePath.replace('.jsonl', `_${ts}.jsonl`);
    const { rename } = await import('fs/promises');
    await rename(filePath, archivePath);
    await writeFile(filePath, '', 'utf-8');
    // TODO: 移除调试日志 console.log(`[hippocampus] 📦 事件日志已归档: ${archivePath}`);
  } catch (err) {
    console.warn('[hippocampus] ⚠️ archive failed:', err.message);
  }
}

// ====== 查询接口 ======

/**
 * 查询最近的事件（同步操作，不依赖索引）
 */
export async function queryRecentEvents(limit = 20) {
  try {
    const targetFile = _fallbackDir
      ? join(_fallbackDir, 'events.jsonl')
      : EVENTS_FILE;
    
    try { await access(targetFile); } catch { return []; }

    const raw = await readFile(targetFile, 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    const recent = lines.slice(-limit);
    return recent.map(l => {
      try {
        return JSON.parse(l);
      } catch (e) {
        console.warn('[hippocampus] ⚠️ 跳过损坏的事件行:', e.message, l.substring(0, 60));
        return null;
      }
    }).filter(Boolean);
  } catch (err) {
    console.warn('[hippocampus] ⚠️ queryRecentEvents 失败:', err.message);
    return [];
  }
}

export default { recordEvent, queryRecentEvents };
