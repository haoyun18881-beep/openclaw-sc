/**
 * sc — 代码审查优化的共享工具模块
 *
 * 从 index.js 和 tools/bridge.js 提取的重复代码
 * 两处引用同一份，消除 ~600 行重复
 *
 * v1.1.0 — 2026-06-09 路径安全修复
 */

import { validatePath } from '../security.js';

// ====== 配置常量 ======
const WORKER_MAX_FILES = 50;
const L0_MAX_FILES = 200;
const L0_MAX_SIZE_BYTES = 50 * 1024; // 50KB

// ====== L0 快车路径 ======

/**
 * 🚀 L0 快车路径: 小文件(<200个/<50KB)直接 Node.js 原生 grep
 * 比走 Worker 快 10x，返回与 Worker 搜索结果兼容的格式
 *
 * @param {string} keyword - 搜索关键词
 * @param {string[]} files - 文件路径列表
 * @param {function} [validateFn] - 可选的安全路径验证函数（默认使用 security.js validatePath）
 * @returns {Promise<object|null>} 搜索结果对象或 null（不适合快车路径时）
 */
export async function fastPathSearch(keyword, files, validateFn) {
  if (!files || files.length === 0 || files.length >= L0_MAX_FILES) {
    return null;
  }

  // 🔧 路径安全修复: 始终使用安全验证函数，不提供 fallback 到裸路径
  const _validate = validateFn || validatePath;

  const { stat, readFile } = await import('fs/promises');
  let totalSize = 0;
  const sizeChecked = [];

  for (const f of files) {
    try {
      // 🔧 路径安全: 先 validatePath，再 stat，防止信息泄露
      const safePath = await _validate(f);
      const s = await stat(safePath);
      sizeChecked.push({ file: f, safePath, size: s.size });
      totalSize += s.size;
      if (totalSize > L0_MAX_SIZE_BYTES) break;
    } catch (err) {
      console.warn(`[code-review-shared] stat文件失败 ${f}: ${err?.message || '未知错误'}`);
      totalSize = L0_MAX_SIZE_BYTES + 1;
      break;
    }
  }

  if (totalSize > L0_MAX_SIZE_BYTES) {
    return null;
  }

  const queryLower = keyword.toLowerCase();
  let totalMatches = 0;
  const results = [];

  for (const { file, safePath } of sizeChecked) {
    try {
      const content = await readFile(safePath, 'utf-8');
      const lines = content.split('\n');
      const matches = [];

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(queryLower)) {
          matches.push({ line: i + 1, text: lines[i].trim().substring(0, 200) });
        }
      }

      if (matches.length > 0) {
        totalMatches += matches.length;
        results.push({ file, matchCount: matches.length, matches });
      }
    } catch (e) {
      results.push({ file, error: e.message });
    }
  }

  return {
    keyword,
    total: totalMatches,
    totalFiles: sizeChecked.length,
    results,
    l0FastPath: true,
  };
}

// ====== 文件拆分与结果合并 ======

export function splitFiles(files, numChunks) {
  if (numChunks <= 1) return [files];
  const chunks = [];
  const chunkSize = Math.min(Math.ceil(files.length / numChunks), WORKER_MAX_FILES);
  for (let i = 0; i < files.length; i += chunkSize) {
    chunks.push(files.slice(i, i + chunkSize));
  }
  return chunks;
}

export function mergeSearchResults(results, poolStats) {
  const allResults = [];
  let totalMatches = 0;
  let totalFiles = 0;
  let errorFiles = 0;

  for (const r of results) {
    if (r.results) {
      for (const item of r.results) {
        allResults.push(item);
        totalMatches += item.matchCount || 0;
        if (item.error) errorFiles++;
        else totalFiles++;
      }
    }
  }

  allResults.sort((a, b) => (b.matchCount || 0) - (a.matchCount || 0));

  return {
    keyword: results[0]?.keyword || '',
    totalMatches,
    totalFiles,
    errorFiles,
    results: allResults,
    poolStats,
  };
}

export function mergeLogResults(results, poolStats) {
  const allStats = [];
  for (const r of results) {
    if (r.stats) allStats.push(...r.stats);
  }
  return { stats: allStats, poolStats };
}

// ====== CLI 参数解析 ======

export function parseSearchArgs(args) {
  const files = [];
  let keyword = null;
  let priority = 'normal';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--priority') { priority = args[++i] || 'normal'; }
    else if (!keyword) { keyword = args[i]; }
    else { files.push(args[i]); }
  }
  return { keyword, files, priority };
}

export function parseLogArgs(args) {
  const files = [];
  let priority = 'normal';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--priority') { priority = args[++i] || 'normal'; }
    else { files.push(args[i]); }
  }
  return { files, priority };
}
