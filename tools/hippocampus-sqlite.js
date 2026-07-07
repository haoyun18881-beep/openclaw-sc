/**
 * hippocampus-sqlite.js — hippocampus SQLite 存储引擎
 *
 * 提供基于 SQLite + FTS5 的persist存储，作为 hippocampus-store.js 的增强层。
 *
 * 架构：
 *   主存储： SQLite (WAL模式) — workspace/data/hippocampus.db
 *   双写兼容： 可选的 JSONL 双写（兼容现有记录）
 *
 * 表结构：
 *   - events:          工具调用事件
 *   - decisions:       推理决策记录
 *   - entities:        实体发现表
 *   - file_changes:    文件变更追踪
 *   - system_logs:     系统日志
 *   每个表对应一个 FTS5 全文搜索虚拟表
 */

import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync, statSync } from 'fs';
import { randomBytes } from 'crypto';

// ====== 常量 ======
const WORKSPACE_ROOT = join(homedir(), '.openclaw', 'workspace');
const DB_PATH = join(WORKSPACE_ROOT, 'data', 'hippocampus.db');
const EVENTS_FILE = join(WORKSPACE_ROOT, 'memory', 'hippocampus', 'events.jsonl');

const MAX_STRING_LENGTH = 4096; // 单个字段截断长度

// ====== 内部状态 ======
let _db = null;
let _stmtCache = {};  // 预编译语句缓存
let _initialized = false;
let _jsonlWriter = null; // 可选的 JSONL 双写引用

// ====== 工具函数 ======
function generateId(prefix) {
  const ts = Date.now();
  const rand = randomBytes(4).readUInt32BE(0).toString(36);
  return `${prefix}_${ts}_${rand}`;
}

function truncateStr(str, maxLen = MAX_STRING_LENGTH) {
  if (!str) return '';
  const s = typeof str === 'string' ? str : JSON.stringify(str);
  return s.length > maxLen ? s.substring(0, maxLen) + '...' : s;
}

function serialize(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

// ====== 重试工具（多进程 SQLITE_BUSY 容错） ======

/**
 * 在 SQLITE_BUSY/SQLITE_LOCKED 时自动重试，最多3次，指数退避
 * @param {Function} fn - 需要重试的同步操作
 * @returns {*} fn 的返回值
 */
function withRetry(fn) {
  const MAX_RETRIES = 3;
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      // 仅 SQLITE_BUSY (errno=5) 或 SQLITE_LOCKED (errno=6) 重试
      const isLockError = (err.code === 'SQLITE_BUSY' || err.code === 'SQLITE_LOCKED' || err.errno === 5 || err.errno === 6);
      if (isLockError && attempt < MAX_RETRIES - 1) {
        const delayMs = Math.min(50 * Math.pow(2, attempt), 200); // 50ms, 100ms, 200ms
        console.warn(`[hippocampus-SQLite] ⚠️ ${err.code || '数据库锁定'}, 第${attempt + 1}次重试 (${delayMs}ms)...`);
        // 同步阻塞等待（better-sqlite3 是同步 API）
        const deadline = Date.now() + delayMs;
        while (Date.now() < deadline) { /* busy wait */ }
      } else {
        throw err; // 非锁定错误或已达最大重试次数，直接抛出
      }
    }
  }
  throw lastErr;
}

// ====== 数据库初始化 ======

/**
 * 初始化 SQLite 数据库，创建所有表和 FTS5 索引
 */
export function initDB() {
  if (_initialized && _db) return { success: true };

  try {
    // 确保目录存在
    const dbDir = dirname(DB_PATH);
    if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

    // 打开数据库
    _db = new Database(DB_PATH);

    // 启用 WAL 模式 — 读写并发友好
    _db.pragma('journal_mode = WAL');

    // 启用外键
    _db.pragma('foreign_keys = ON');

    // 设置 busy_timeout 为 5000ms（better-sqlite3 内置重试）
    _db.pragma('busy_timeout = 5000');

    // 创建基础表 + FTS5 索引
    _db.exec(`
      -- ====== 事件表 ======
      CREATE TABLE IF NOT EXISTS events (
        eventId    TEXT PRIMARY KEY,
        type       TEXT NOT NULL DEFAULT 'tool_call',
        timestamp  TEXT NOT NULL,
        toolName   TEXT,
        params     TEXT,
        result     TEXT,
        duration   INTEGER DEFAULT 0,
        status     TEXT DEFAULT 'success',
        sessionId  TEXT DEFAULT ''
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
        eventId UNINDEXED,
        toolName,
        params,
        result,
        status,
        content='events',
        content_rowid='rowid'
      );

      -- 触发器：保持 FTS 与基础表同步
      CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
        INSERT INTO events_fts(rowid, eventId, toolName, params, result, status)
        VALUES (new.rowid, new.eventId, new.toolName, new.params, new.result, new.status);
      END;

      CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
        INSERT INTO events_fts(events_fts, rowid, eventId, toolName, params, result, status)
        VALUES ('delete', old.rowid, old.eventId, old.toolName, old.params, old.result, old.status);
      END;

      CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
        INSERT INTO events_fts(events_fts, rowid, eventId, toolName, params, result, status)
        VALUES ('delete', old.rowid, old.eventId, old.toolName, old.params, old.result, old.status);
        INSERT INTO events_fts(rowid, eventId, toolName, params, result, status)
        VALUES (new.rowid, new.eventId, new.toolName, new.params, new.result, new.status);
      END;

      -- ====== 决策表 ======
      CREATE TABLE IF NOT EXISTS decisions (
        decisionId  TEXT PRIMARY KEY,
        timestamp   TEXT NOT NULL,
        context     TEXT,
        decision    TEXT,
        reasoning   TEXT,
        outcome     TEXT
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
        decisionId UNINDEXED,
        context,
        decision,
        reasoning,
        outcome,
        content='decisions',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS decisions_ai AFTER INSERT ON decisions BEGIN
        INSERT INTO decisions_fts(rowid, decisionId, context, decision, reasoning, outcome)
        VALUES (new.rowid, new.decisionId, new.context, new.decision, new.reasoning, new.outcome);
      END;

      CREATE TRIGGER IF NOT EXISTS decisions_ad AFTER DELETE ON decisions BEGIN
        INSERT INTO decisions_fts(decisions_fts, rowid, decisionId, context, decision, reasoning, outcome)
        VALUES ('delete', old.rowid, old.decisionId, old.context, old.decision, old.reasoning, old.outcome);
      END;

      CREATE TRIGGER IF NOT EXISTS decisions_au AFTER UPDATE ON decisions BEGIN
        INSERT INTO decisions_fts(decisions_fts, rowid, decisionId, context, decision, reasoning, outcome)
        VALUES ('delete', old.rowid, old.decisionId, old.context, old.decision, old.reasoning, old.outcome);
        INSERT INTO decisions_fts(rowid, decisionId, context, decision, reasoning, outcome)
        VALUES (new.rowid, new.decisionId, new.context, new.decision, new.reasoning, new.outcome);
      END;

      -- ====== 实体表 ======
      CREATE TABLE IF NOT EXISTS entities (
        entityId    TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        type        TEXT DEFAULT 'unknown',
        properties  TEXT,
        timestamp   TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
        entityId UNINDEXED,
        name,
        type,
        properties,
        content='entities',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS entities_ai AFTER INSERT ON entities BEGIN
        INSERT INTO entities_fts(rowid, entityId, name, type, properties)
        VALUES (new.rowid, new.entityId, new.name, new.type, new.properties);
      END;

      CREATE TRIGGER IF NOT EXISTS entities_ad AFTER DELETE ON entities BEGIN
        INSERT INTO entities_fts(entities_fts, rowid, entityId, name, type, properties)
        VALUES ('delete', old.rowid, old.entityId, old.name, old.type, old.properties);
      END;

      CREATE TRIGGER IF NOT EXISTS entities_au AFTER UPDATE ON entities BEGIN
        INSERT INTO entities_fts(entities_fts, rowid, entityId, name, type, properties)
        VALUES ('delete', old.rowid, old.entityId, old.name, old.type, old.properties);
        INSERT INTO entities_fts(rowid, entityId, name, type, properties)
        VALUES (new.rowid, new.entityId, new.name, new.type, new.properties);
      END;

      -- ====== 文件变更表 ======
      CREATE TABLE IF NOT EXISTS file_changes (
        changeId     TEXT PRIMARY KEY,
        timestamp    TEXT NOT NULL,
        filePath     TEXT NOT NULL,
        action       TEXT NOT NULL,
        content      TEXT,
        previousHash TEXT
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS file_changes_fts USING fts5(
        changeId UNINDEXED,
        filePath,
        action,
        content,
        previousHash,
        content='file_changes',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS file_changes_ai AFTER INSERT ON file_changes BEGIN
        INSERT INTO file_changes_fts(rowid, changeId, filePath, action, content, previousHash)
        VALUES (new.rowid, new.changeId, new.filePath, new.action, new.content, new.previousHash);
      END;

      CREATE TRIGGER IF NOT EXISTS file_changes_ad AFTER DELETE ON file_changes BEGIN
        INSERT INTO file_changes_fts(file_changes_fts, rowid, changeId, filePath, action, content, previousHash)
        VALUES ('delete', old.rowid, old.changeId, old.filePath, old.action, old.content, old.previousHash);
      END;

      CREATE TRIGGER IF NOT EXISTS file_changes_au AFTER UPDATE ON file_changes BEGIN
        INSERT INTO file_changes_fts(file_changes_fts, rowid, changeId, filePath, action, content, previousHash)
        VALUES ('delete', old.rowid, old.changeId, old.filePath, old.action, old.content, old.previousHash);
        INSERT INTO file_changes_fts(rowid, changeId, filePath, action, content, previousHash)
        VALUES (new.rowid, new.changeId, new.filePath, new.action, new.content, new.previousHash);
      END;

      -- ====== 系统日志表 ======
      CREATE TABLE IF NOT EXISTS system_logs (
        logId      TEXT PRIMARY KEY,
        timestamp  TEXT NOT NULL,
        level      TEXT NOT NULL DEFAULT 'info',
        module     TEXT,
        message    TEXT,
        metadata   TEXT
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS system_logs_fts USING fts5(
        logId UNINDEXED,
        level,
        module,
        message,
        metadata,
        content='system_logs',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS system_logs_ai AFTER INSERT ON system_logs BEGIN
        INSERT INTO system_logs_fts(rowid, logId, level, module, message, metadata)
        VALUES (new.rowid, new.logId, new.level, new.module, new.message, new.metadata);
      END;

      CREATE TRIGGER IF NOT EXISTS system_logs_ad AFTER DELETE ON system_logs BEGIN
        INSERT INTO system_logs_fts(system_logs_fts, rowid, logId, level, module, message, metadata)
        VALUES ('delete', old.rowid, old.logId, old.level, old.module, old.message, old.metadata);
      END;

      CREATE TRIGGER IF NOT EXISTS system_logs_au AFTER UPDATE ON system_logs BEGIN
        INSERT INTO system_logs_fts(system_logs_fts, rowid, logId, level, module, message, metadata)
        VALUES ('delete', old.rowid, old.logId, old.level, old.module, old.message, old.metadata);
        INSERT INTO system_logs_fts(rowid, logId, level, module, message, metadata)
        VALUES (new.rowid, new.logId, new.level, new.module, new.message, new.metadata);
      END;
    `);

    // 预编译常用语句
    _stmtCache = {
      insertEvent: _db.prepare(`
        INSERT OR REPLACE INTO events (eventId, type, timestamp, toolName, params, result, duration, status, sessionId)
        VALUES (@eventId, @type, @timestamp, @toolName, @params, @result, @duration, @status, @sessionId)
      `),
      insertDecision: _db.prepare(`
        INSERT OR REPLACE INTO decisions (decisionId, timestamp, context, decision, reasoning, outcome)
        VALUES (@decisionId, @timestamp, @context, @decision, @reasoning, @outcome)
      `),
      insertEntity: _db.prepare(`
        INSERT OR REPLACE INTO entities (entityId, name, type, properties, timestamp)
        VALUES (@entityId, @name, @type, @properties, @timestamp)
      `),
      insertFileChange: _db.prepare(`
        INSERT OR REPLACE INTO file_changes (changeId, timestamp, filePath, action, content, previousHash)
        VALUES (@changeId, @timestamp, @filePath, @action, @content, @previousHash)
      `),
      insertSystemLog: _db.prepare(`
        INSERT OR REPLACE INTO system_logs (logId, timestamp, level, module, message, metadata)
        VALUES (@logId, @timestamp, @level, @module, @message, @metadata)
      `),
      // 按时间查询事件
      queryEventsByTime: _db.prepare(`
        SELECT * FROM events
        WHERE timestamp >= @since AND timestamp <= @until
        ORDER BY timestamp DESC
        LIMIT @limit
      `),
      // 按工具名查询事件
      queryEventsByTool: _db.prepare(`
        SELECT * FROM events
        WHERE toolName = @toolName
        ORDER BY timestamp DESC
        LIMIT @limit
      `),
    };

    _initialized = true;
    // TODO: 移除调试日志 console.log(`[hippocampus-SQLite] ✅ 存储引擎已初始化: ${DB_PATH}`);
    return { success: true, dbPath: DB_PATH };
  } catch (err) {
    console.error('[hippocampus-SQLite] ❌ init failed:', err.message);
    _initialized = false;
    _db = null;
    return { success: false, error: err.message };
  }
}

// ====== 设置 JSONL 双写兼容 ======

/**
 * 启用 JSONL 双写（向后兼容 hippocampus-store.js）
 * 传入已有的 recordEvent 函数引用
 */
export function enableJsonlDualWrite(recordEventFn) {
  _jsonlWriter = recordEventFn;
  // TODO: 移除调试日志 console.log('[hippocampus-SQLite] 🔗 JSONL 双写已启用');
}

// ====== 事件操作 ======

/**
 * 插入一工具调用事件（同时支持双写到 JSONL）
 */
export function insertEvent({ toolName, params, result, duration, status, sessionId, type = 'tool_call' }) {
  if (!_initialized || !_db) {
    const initResult = initDB();
    if (!initResult.success) return { success: false, error: '数据库未初始化', dbError: initResult.error };
  }

  try {
    const eventId = generateId('hippo');
    const timestamp = new Date().toISOString();

    withRetry(() => {
      _stmtCache.insertEvent.run({
        eventId,
        type,
        timestamp,
        toolName: truncateStr(toolName),
        params: serialize(params),
        result: serialize(result),
        duration: typeof duration === 'number' ? Math.round(duration) : 0,
        status: status || (result && !result.error ? 'success' : 'error'),
        sessionId: truncateStr(sessionId || ''),
      });
    });

    // JSONL 双写（如果启用了）
    if (_jsonlWriter && typeof _jsonlWriter === 'function') {
      _jsonlWriter({ toolName, params, result, duration, status, sessionId })
        .catch(err => console.warn('[hippocampus-SQLite] ⚠️ JSONL dual write failed:', err.message));
    }

    return { success: true, eventId };
  } catch (err) {
    console.error('[hippocampus-SQLite] ❌ insertEvent 失败:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * 查询事件 — 支持多种过滤方式
 *
 * @param {Object} opts
 * @param {string}  [opts.toolName]   - 按工具名过滤
 * @param {string}  [opts.since]      - 起始时间 (ISO8601)
 * @param {string}  [opts.until]      - 结束时间 (ISO8601)
 * @param {number}  [opts.limit=50]   - 最大返回数
 * @param {string}  [opts.status]     - 按状态过滤 success/error
 * @returns {Array}
 */
export function queryEvents({ toolName, since, until, limit = 50, status } = {}) {
  if (!_initialized || !_db) {
    const initResult = initDB();
    if (!initResult.success) return [];
  }

  try {
    let sql = 'SELECT * FROM events WHERE 1=1';
    const params = {};

    if (toolName) {
      sql += ' AND toolName = @toolName';
      params.toolName = toolName;
    }
    if (since) {
      sql += ' AND timestamp >= @since';
      params.since = since;
    }
    if (until) {
      sql += ' AND timestamp <= @until';
      params.until = until;
    }
    if (status) {
      sql += ' AND status = @status';
      params.status = status;
    }

    sql += ' ORDER BY timestamp DESC LIMIT @limit';
    params.limit = Math.min(limit, 1000);

    const stmt = _db.prepare(sql);
    const rows = stmt.all(params);

    // 反序列化 JSON 字段
    return rows.map(r => ({
      ...r,
      params: r.params ? tryParse(r.params) : null,
      result: r.result ? tryParse(r.result) : null,
    }));
  } catch (err) {
    console.error('[hippocampus-SQLite] ❌ queryEvents 失败:', err.message);
    return [];
  }
}

// ====== 全文搜索 ======

/**
 * 跨表全文搜索（FTS5）
 *
 * @param {string}  query             - 搜索关键词（FTS5 查询语法）
 * @param {Object}  [opts]
 * @param {string}  [opts.table]      - 限定搜索的表: events|decisions|entities|file_changes|system_logs
 * @param {number}  [opts.limit=20]   - 最大返回数
 * @param {string}  [opts.since]      - 起始时间过滤
 * @param {string}  [opts.until]      - 结束时间过滤
 * @returns {Array<{table, rowid, rank, snippet, row: Object}>}
 */
export function searchFTS(query, { table, limit = 20, since, until } = {}) {
  if (!_initialized || !_db) {
    const initResult = initDB();
    if (!initResult.success) return [];
  }

  if (!query || !query.trim()) return [];

  const results = [];
  const tables = table
    ? [{ name: table, pk: `${table.slice(0, -1)}Id`, tsCol: 'timestamp' }]
    : [
        { name: 'events', pk: 'eventId', tsCol: 'timestamp' },
        { name: 'decisions', pk: 'decisionId', tsCol: 'timestamp' },
        { name: 'entities', pk: 'entityId', tsCol: 'timestamp' },
        { name: 'file_changes', pk: 'changeId', tsCol: 'timestamp' },
        { name: 'system_logs', pk: 'logId', tsCol: 'timestamp' },
      ];

  for (const t of tables) {
    try {
      const ftsTable = `${t.name}_fts`;
      const sanitizedQuery = query.replace(/['\"]/g, '').trim();

      let sql;
      const ftsParams = { query: sanitizedQuery, limit: Math.min(limit, 200) };

      // 先查 FTS5 获取 rowid 和 rank
      sql = `
        SELECT rowid, rank
        FROM ${ftsTable}
        WHERE ${ftsTable} MATCH @query
        ORDER BY rank
        LIMIT @limit
      `;

      const ftsRows = _db.prepare(sql).all(ftsParams);

      if (ftsRows.length === 0) continue;

      // 再取原始数据
      const rowids = ftsRows.map(r => r.rowid);
      // 使用命名参数 @id0,@id1,... 避免混合 ? 和 @named 参数（better-sqlite3 不支持混合风格）
      const idParams = {};
      const placeholders = rowids.map((id, i) => {
        idParams[`id${i}`] = id;
        return `@id${i}`;
      }).join(',');

      // 合并所有参数为单一对象
      const allParams = { ...idParams };

      // 时间范围过滤（统一用命名参数）
      let dataSql = `SELECT rowid, * FROM ${t.name} WHERE rowid IN (${placeholders})`;
      if (since) { dataSql += ` AND ${t.tsCol} >= @since`; allParams.since = since; }
      if (until) { dataSql += ` AND ${t.tsCol} <= @until`; allParams.until = until; }

      const dataStmt = _db.prepare(dataSql);
      const dataRows = dataStmt.all(allParams);

      // 合并结果
      for (const ftsRow of ftsRows) {
        const dataRow = dataRows.find(dr => dr.rowid === ftsRow.rowid);
        if (dataRow) {
          results.push({
            table: t.name,
            rowid: ftsRow.rowid,
            rank: ftsRow.rank,
            row: dataRow,
          });
        }
      }
    } catch (err) {
      console.warn(`[hippocampus-SQLite] ⚠️ 搜索 ${t.name} 时出错:`, err.message);
    }
  }

  // 按 rank 排序（FTS5 相关性分数）
  results.sort((a, b) => a.rank - b.rank);
  return results.slice(0, limit);
}

// ====== 其他表的插入接口 ======

export function insertDecision({ context, decision, reasoning, outcome }) {
  if (!_initialized || !_db) {
    const initResult = initDB();
    if (!initResult.success) return { success: false, error: '数据库未初始化' };
  }

  try {
    const decisionId = generateId('deci');
    const timestamp = new Date().toISOString();

    withRetry(() => {
      _stmtCache.insertDecision.run({
        decisionId,
        timestamp,
        context: truncateStr(context),
        decision: truncateStr(decision),
        reasoning: truncateStr(reasoning),
        outcome: truncateStr(outcome),
      });
    });

    return { success: true, decisionId };
  } catch (err) {
    console.error('[hippocampus-SQLite] ❌ insertDecision 失败:', err.message);
    return { success: false, error: err.message };
  }
}

export function insertEntity({ name, type = 'unknown', properties }) {
  if (!_initialized || !_db) {
    const initResult = initDB();
    if (!initResult.success) return { success: false, error: '数据库未初始化' };
  }

  try {
    const entityId = generateId('enti');
    const timestamp = new Date().toISOString();

    withRetry(() => {
      _stmtCache.insertEntity.run({
        entityId,
        name: truncateStr(name),
        type: truncateStr(type),
        properties: serialize(properties),
        timestamp,
      });
    });

    return { success: true, entityId };
  } catch (err) {
    console.error('[hippocampus-SQLite] ❌ insertEntity 失败:', err.message);
    return { success: false, error: err.message };
  }
}

export function insertFileChange({ filePath, action, content, previousHash }) {
  if (!_initialized || !_db) {
    const initResult = initDB();
    if (!initResult.success) return { success: false, error: '数据库未初始化' };
  }

  try {
    const changeId = generateId('file');
    const timestamp = new Date().toISOString();

    withRetry(() => {
      _stmtCache.insertFileChange.run({
        changeId,
        timestamp,
        filePath: truncateStr(filePath),
        action: truncateStr(action),
        content: truncateStr(content, 8192),
        previousHash: truncateStr(previousHash),
      });
    });

    return { success: true, changeId };
  } catch (err) {
    console.error('[hippocampus-SQLite] ❌ insertFileChange 失败:', err.message);
    return { success: false, error: err.message };
  }
}

export function insertSystemLog({ level = 'info', module, message, metadata }) {
  if (!_initialized || !_db) {
    const initResult = initDB();
    if (!initResult.success) return { success: false, error: '数据库未初始化' };
  }

  try {
    const logId = generateId('log');
    const timestamp = new Date().toISOString();

    withRetry(() => {
      _stmtCache.insertSystemLog.run({
        logId,
        timestamp,
        level: truncateStr(level),
        module: truncateStr(module),
        message: truncateStr(message),
        metadata: serialize(metadata),
      });
    });

    return { success: true, logId };
  } catch (err) {
    console.error('[hippocampus-SQLite] ❌ insertSystemLog 失败:', err.message);
    return { success: false, error: err.message };
  }
}

// ====== 数据库stats ======

/**
 * 获取各表记录数stats
 */
export function getStats() {
  if (!_initialized || !_db) {
    return { success: false, error: '数据库未初始化' };
  }

  try {
    const tables = ['events', 'decisions', 'entities', 'file_changes', 'system_logs'];
    const stats = {};

    for (const table of tables) {
      const row = _db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get();
      stats[table] = row.count;
    }

    // 数据库文件大小
    stats.dbPath = DB_PATH;
    stats.dbSizeBytes = existsSync(DB_PATH) ? statSync(DB_PATH).size : 0;

    return { success: true, ...stats };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ====== 关闭 ======

/**
 * 关闭数据库连接
 */
export function close() {
  if (_db) {
    try {
      _db.close();
    } catch (err) {
      console.warn('[hippocampus-SQLite] ⚠️ 关闭连接时出错:', err.message);
    }
    _db = null;
    _initialized = false;
    _stmtCache = {};
  }
}

// ====== 内部工具 ======

function tryParse(str) {
  if (!str || str === 'null' || str === 'undefined') return null;
  try { return JSON.parse(str); } catch { return str; }
}

// ====== 自动初始化（模块加载时） ======
initDB();

export default {
  initDB,
  insertEvent,
  insertDecision,
  insertEntity,
  insertFileChange,
  insertSystemLog,
  queryEvents,
  searchFTS,
  enableJsonlDualWrite,
  getStats,
  close,
};
