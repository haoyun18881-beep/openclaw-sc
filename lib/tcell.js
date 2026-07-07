/**
 * 🛡️ 高频任务缓存 — 高频任务s级缓存重放系统
 *
 * 核心逻辑：
 *   1. 每次成功任务记录模式签名 hash(任务类型 + 关键词)
 *   2. 缓存命中直接跳转到对应工具，绕过完整路由
 *   3. LRU + 成功率驱逐（低于60%自动淘汰）
 *
 * v1.0 — 2026-05-31
 */

import { join, dirname } from "path";
import { homedir } from "os";
import { readFile, writeFile, mkdir, readdir, unlink, stat, rename } from "fs/promises";
import crypto from "crypto";

// ====== 常量 ======
const TCELL_DIR = join(homedir(), '.openclaw', 'workspace', 'memory', 'shared', 'tcell');
const CACHE_FILE = join(TCELL_DIR, 'cache.json');
// 🧠 设计决策：MAX_CACHE_ENTRIES=500。缓存目上限——管理员从200调到500。
// 40+工具每个约12种参数组合≈480，500刚好够覆盖。
// 过大(1000+)则persistI/O变慢，过小(50)则命中率不够。
const MAX_CACHE_ENTRIES = 500;        // 最大缓存目（管理员从200调到500，40+工具够用）
const MIN_SUCCESS_RATE = 0.6;         // 最低成功率（低于此值自动驱逐）
const EVICTION_SCAN_INTERVAL = 20;    // 每20次操作扫描一次驱逐
const LRU_HALF_LIFE_MS = 3600000;     // LRU时间衰减半周期1小时

/**
 * 计算模式签名
 * @param {string} taskType - 任务类型 (如 cpu_search, cpu_orchestrate)
 * @param {string} keywords - 关键词摘要 (从任务描述中提取的前80字)
 * @returns {string} SHA256 hex 前16位
 */
export function computeSignature(taskType, keywords) {
  const source = `${taskType}::${(keywords || '').trim().toLowerCase()}`;
  return crypto.createHash('sha256').update(source, 'utf-8').digest('hex').substring(0, 16);
}

/**
 * 从任务描述中提取关键词（去停用词，取前80字符）
 * @param {string} taskDesc - 原始任务描述
 * @returns {string} 精简关键词
 */
export function extractKeywords(taskDesc) {
  if (!taskDesc || typeof taskDesc !== 'string') return '';
  // 取前120字符，去除非内容行
  const lines = taskDesc.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('⚡') && !l.startsWith('🏃') && !l.startsWith('思考') && !l.startsWith('---') && !l.startsWith('```'))
    .slice(0, 3);
  return lines.join(' ').substring(0, 80);
}

/**
 * 高频任务快速路径缓存
 */
class FastPathCache {
  constructor() {
    this.cache = new Map(); // signature → { tool, taskType, keywords, successCount, failCount, lastAccess, createdAt }
    this.hitCount = 0;
    this.missCount = 0;
    this.evictionCount = 0;
    this.initialized = false;
    this._opCount = 0;
    // 🧠 实例级 MIN_SUCCESS_RATE，默认使用模块常量。
    // createEnrichTcell 传入独立阈值 0.75 覆盖此值（enrichment layer需求需独立阈值）。
    // 设计原因：不同 Tcell 实例需要不同的成功率阈值，
    // 但原 lookup()/recordResult()/_evictStale() 直接引用模块级常量，
    // 导致实例级覆盖（如 createEnrichTcell 设 tcell.MIN_SUCCESS_RATE=0.75）不生效。
    // 改用 this.MIN_SUCCESS_RATE 让每个实例自己决定淘汰线。
    this.MIN_SUCCESS_RATE = MIN_SUCCESS_RATE;
  }

  /**
   * 初始化：从磁盘加载缓存
   */
  async init() {
    await mkdir(TCELL_DIR, { recursive: true }).catch((err) => {
      console.warn(`[sc] ⚠️ mkdir TCELL_DIR失败: ${err?.message || '未知错误'}`);
    });

    // 支持实例级缓存文件路径（enrichment layer使用独立文件防污染）
    // 当 this.CACHE_FILE 未设置时，回退到模块级 CACHE_FILE
    const cacheFile = this.CACHE_FILE || CACHE_FILE;

    try {
      const raw = await readFile(cacheFile, 'utf-8');
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        for (const entry of data) {
          if (entry.signature && entry.tool) {
            this.cache.set(entry.signature, {
              tool: entry.tool,
              taskType: entry.taskType || '',
              keywords: entry.keywords || '',
              successCount: entry.successCount || 0,
              failCount: entry.failCount || 0,
              lastAccess: entry.lastAccess || 0,
              createdAt: entry.createdAt || 0,
              params: entry.params || {},
              avgDurationMs: entry.avgDurationMs || 0,
            });
          }
        }
        // TODO: 移除调试日志 console.log(`[sc] 🛡️ fast-path cache已加载: ${this.cache.size} 个缓存目`);
      }
    } catch {
      // TODO: 移除调试日志 console.log('[sc] 🛡️ fast-path cache无缓存数据，从头开始');
    }

    this.initialized = true;
  }

  /**
   * 从任务描述生成签名
   * @param {string} taskType - 任务类型
   * @param {string} taskDesc - 完整任务描述
   * @returns {string} 签名
   */
  makeSignature(taskType, taskDesc) {
    return computeSignature(taskType, extractKeywords(taskDesc));
  }

  /**
   * 查询缓存（命中即返回缓存结果，更新LRU）
   * @param {string} signature - 模式签名
   * @returns {{ hit: boolean, entry: object|null, bypassRoute: boolean }}
   */
  lookup(signature) {
    if (!this.initialized || !signature) {
      this.missCount++;
      return { hit: false, entry: null, bypassRoute: false };
    }

    const entry = this.cache.get(signature);
    if (!entry) {
      this.missCount++;
      return { hit: false, entry: null, bypassRoute: false };
    }

    // 检查成功率
    const totalCalls = entry.successCount + entry.failCount;
    const successRate = totalCalls > 0 ? entry.successCount / totalCalls : 0;

    if (successRate < this.MIN_SUCCESS_RATE) {
      // 成功率不足，自动驱逐
      this.cache.delete(signature);
      this.evictionCount++;
      this.missCount++;
      this._persist();
      return { hit: false, entry: null, bypassRoute: false, evicted: true, reason: `成功率 ${(successRate*100).toFixed(1)}% < ${(this.MIN_SUCCESS_RATE*100)}%` };
    }

    // LRU更新
    entry.lastAccess = Date.now();
    this.hitCount++;

    // 缓存命中 → 跳过路由
    return {
      hit: true,
      entry: {
        tool: entry.tool,
        taskType: entry.taskType,
        keywords: entry.keywords,
        successRate,
        totalCalls,
        avgDurationMs: entry.avgDurationMs,
        params: entry.params || {},
      },
      bypassRoute: true,
    };
  }

  /**
   * 记录缓存命中后的执行结果
   * @param {string} signature - 模式签名
   * @param {boolean} success - 是否成功
   * @param {number} durationMs - 耗时
   */
  recordResult(signature, success, durationMs) {
    if (!signature) return;

    const entry = this.cache.get(signature);
    if (!entry) return;

    if (success) {
      entry.successCount++;
      // 滚动平均耗时
      if (entry.avgDurationMs > 0) {
        entry.avgDurationMs = Math.round((entry.avgDurationMs * 0.7) + (durationMs || 0) * 0.3);
      } else {
        entry.avgDurationMs = durationMs || 0;
      }
    } else {
      entry.failCount++;
    }

    entry.lastAccess = Date.now();

    // 检查是否需要驱逐
    const total = entry.successCount + entry.failCount;
    if (total >= 3) {
      const rate = entry.successCount / total;
      if (rate < this.MIN_SUCCESS_RATE) {
        this.cache.delete(signature);
        this.evictionCount++;
        // TODO: 移除调试日志 console.log(`[sc] 🛡️ fast-path cache驱逐: ${signature} (成功率 ${(rate*100).toFixed(1)}% < ${(this.MIN_SUCCESS_RATE * 100).toFixed(0)}%)`);
      }
    }

    this._opCount++;
    if (this._opCount % EVICTION_SCAN_INTERVAL === 0) {
      this._evictStale();
    }

    this._persist();
  }

  /**
   * 记录新的缓存目
   * @param {string} signature - 模式签名
   * @param {string} tool - 路由到的工具
   * @param {string} taskType - 任务类型
   * @param {string} taskDesc - 任务描述
   * @param {object} params - 相关参数
   */
  add(signature, tool, taskType, taskDesc, params = {}) {
    if (!this.initialized || !signature || !tool) return;
    if (this.cache.has(signature)) return; // 已存在不覆盖

    const keywords = extractKeywords(taskDesc);
    const entry = {
      tool,
      taskType: taskType || '',
      keywords,
      successCount: 1,   // 首次记录视为成功
      failCount: 0,
      lastAccess: Date.now(),
      createdAt: Date.now(),
      params,
      avgDurationMs: 0,
    };

    this.cache.set(signature, entry);

    // 超过上限时驱逐最久未访问的
    if (this.cache.size > MAX_CACHE_ENTRIES) {
      this._evictLRU();
    }

    this._persist();
  }

  /**
   * 获取缓存stats摘要
   */
  getStats() {
    const entries = [];
    for (const [sig, entry] of this.cache) {
      const total = entry.successCount + entry.failCount;
      entries.push({
        signature: sig.substring(0, 12) + '...',
        tool: entry.tool,
        taskType: entry.taskType,
        totalCalls: total,
        successRate: total > 0 ? (entry.successCount / total * 100).toFixed(1) + '%' : 'N/A',
        lastAccess: entry.lastAccess ? Math.round((Date.now() - entry.lastAccess) / 60000) + 'm ago' : 'never',
        avgDurationMs: entry.avgDurationMs,
      });
    }

    // 按上次访问时间降序
    entries.sort((a, b) => {
      const aTime = a.lastAccess === 'never' ? 0 : parseInt(a.lastAccess);
      const bTime = b.lastAccess === 'never' ? 0 : parseInt(b.lastAccess);
      return aTime - bTime;
    });

    return {
      totalEntries: this.cache.size,
      maxEntries: MAX_CACHE_ENTRIES,
      hitCount: this.hitCount,
      missCount: this.missCount,
      hitRate: (this.hitCount + this.missCount) > 0
        ? (this.hitCount / (this.hitCount + this.missCount) * 100).toFixed(1) + '%'
        : '0.0%',
      evictionCount: this.evictionCount,
      recentEntries: entries.slice(0, 20),
    };
  }

  /**
   * 检查特定任务是否在缓存中（用于before路由判断）
   */
  check(taskType, taskDesc) {
    const signature = this.makeSignature(taskType, taskDesc);
    return this.lookup(signature);
  }

  /**
   * LRU驱逐：淘汰最久未访问的
   */
  _evictLRU() {
    let oldestSig = null;
    let oldestTime = Infinity;
    for (const [sig, entry] of this.cache) {
      if (entry.lastAccess < oldestTime) {
        oldestTime = entry.lastAccess;
        oldestSig = sig;
      }
    }
    if (oldestSig) {
      this.cache.delete(oldestSig);
      this.evictionCount++;
    }
  }

  /**
   * 扫描并驱逐过期目（低成功率 + 7天未访问）
   */
  _evictStale() {
    const now = Date.now();
    const sevenDays = 7 * 24 * 3600 * 1000;
    let evicted = 0;

    for (const [sig, entry] of this.cache) {
      // 7天未访问
      if (now - entry.lastAccess > sevenDays) {
        this.cache.delete(sig);
        evicted++;
        continue;
      }

      // 低于成功率
      const total = entry.successCount + entry.failCount;
      if (total >= 3) {
        const rate = entry.successCount / total;
        if (rate < this.MIN_SUCCESS_RATE) {
          this.cache.delete(sig);
          evicted++;
        }
      }
    }

    if (evicted > 0) {
      this.evictionCount += evicted;
      // TODO: 移除调试日志 console.log(`[sc] 🛡️ fast-path cache扫描驱逐: ${evicted} 个过期目`);
    }
  }

  /**
   * persist到磁盘
   */
  async _persist() {
    // 🧠 串行化写文件：后发写入排队等前一次完成，避免并发 writeFile 竞争。
    // 设计原因：多个连续 _persist() 调用时，后写的完成可能比先写的早，
    // 最后磁盘上存的是旧数据（写文件竞争）。
    // 用 Promise 链保证每次写入严格顺序执行。
    if (!this._persistLock) {
      this._persistLock = Promise.resolve();
    }
    this._persistLock = this._persistLock.then(async () => {
      try {
        const data = [];
        for (const [signature, entry] of this.cache) {
          data.push({ signature, ...entry });
        }
        await mkdir(TCELL_DIR, { recursive: true }).catch((err) => {
          console.warn(`[sc] ⚠️ mkdir TCELL_DIR失败(persist): ${err?.message || '未知错误'}`);
        });
        // 支持实例级缓存文件路径（enrichment layer使用独立文件防污染）
        // 当 this.CACHE_FILE 未设置时，回退到模块级 CACHE_FILE
        const cacheFile = this.CACHE_FILE || CACHE_FILE;
        await writeFile(cacheFile, JSON.stringify(data, null, 2), 'utf-8');
      } catch (err) {
        console.warn(`[sc] ⚠️ fast-path cachepersist失败: ${err.message}`);
      }
    });
    return this._persistLock;
  }
}

// 单例
// ====== enrichment layer专用 Tcell 实例（独立阈值 0.75 + 独立persist文件） ======
// 与主 tcell 完全隔离，不共享签名空间。
// 设计原因：原 tcell 服务于 core_routeTask 的高频任务缓存，命中后绕过路由整个流程。
// enrichment layer tcell 服务于 enrichSubagentTask 的签名缓存，命中后跳过 enrich 逻辑直接返回推荐。
// 两者任务类型完全不同，混用会导致签名空间污染。
// 原 tcell 阈值为 0.6（成功率淘汰线），enrichment layer需要 0.75（置信度触发线）。
const ENRICH_THRESHOLD = 0.75;
const ENRICH_CACHE_FILE = join(TCELL_DIR, 'enrich-cache.json');

/**
 * 创建enrichment layer专用 Tcell 实例
 * - 独立阈值：0.75（原 tcell 为 0.6）
 * - 独立persist文件：enrich-cache.json（不污染主 cache.json）
 * - 实例完全隔离，后续可独立调参
 * 
 * @returns {Promise<FastPathCache>} 配置好的 enrichTcell 实例
 */
export async function createEnrichTcell() {
  const tcell = new FastPathCache();
  tcell.MIN_SUCCESS_RATE = ENRICH_THRESHOLD;  // 覆盖阈值为 0.75
  tcell.CACHE_FILE = ENRICH_CACHE_FILE;        // 独立缓存文件防签名空间污染
  await tcell.init();                          // 从磁盘加载
  return tcell;
}

export const tcell = new FastPathCache();

export default tcell;
