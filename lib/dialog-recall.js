/**
 * 🦞 sc v5.37.0 — 对话日记检索模块 (ESM)
 *
 * 多Worker并行扫描 memory/dialog/ 下的日记文件，
 * 按时间×匹配度加权排序返回结果。
 */

import { readdir, stat, readFile } from 'fs/promises';
import { join, resolve, normalize } from 'path';
import { homedir } from 'os';

const OLLAMA_NATIVE_BASE = 'http://127.0.0.1:11434';
const EMBEDDING_TIMEOUT_MS = 10000;
const SEMANTIC_TOP_N = 30;
const FINAL_TOP_N = 20;

const WORKSPACE_DIR = resolve(homedir(), '.openclaw', 'workspace');
const DIALOG_DIR = join(WORKSPACE_DIR, 'memory', 'dialog');

const TIME_DECAY_HALF_LIFE_HOURS = 14;
const TIME_DECAY_FACTOR = Math.LN2 / TIME_DECAY_HALF_LIFE_HOURS;

const MATCH_DENSITY_WEIGHT = 10;
const TIME_DECAY_WEIGHT = 1.0;

const TIME_RANGE_MAP = {
  '3d': 3 * 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
  '2w': 14 * 24 * 60 * 60 * 1000,
  '1m': 30 * 24 * 60 * 60 * 1000,
  'all': Infinity,
};

async function readEmbeddingConfig() {
  const configPath = join(homedir(), '.openclaw', 'openclaw.json');
  try {
    const raw = await readFile(configPath, 'utf-8');
    const cfg = JSON.parse(raw);
    const ecfg = cfg?.models?.providers?.embedding;
    if (ecfg?.models?.length > 0) {
      const baseUrl = (ecfg.baseUrl || OLLAMA_NATIVE_BASE).replace(/\/v1$/, '').replace(/\/+$/, '');
      const model = ecfg.models[0].id || 'bge-m3';
      return { baseUrl, model };
    }
    const ms = cfg?.memorySearch;
    if (ms?.model) {
      return { baseUrl: OLLAMA_NATIVE_BASE, model: ms.model };
    }
  } catch (err) {
    console.warn(`[dialog-recall] \u8bfb\u53d6embedding\u914d\u7f6e\u5931\u8d25: ${err?.message || '未知错误'}`);
  }
  return { baseUrl: OLLAMA_NATIVE_BASE, model: 'bge-m3' };
}

async function getEmbedding(text, signal) {
  const { baseUrl, model } = await readEmbeddingConfig();
  const controller = new AbortController();
  const combinedSignal = signal || controller.signal;
  const timeoutId = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);

  try {
    const url = `${baseUrl}/api/embeddings`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: text }),
      signal: combinedSignal,
    });

    if (!resp.ok) {
      throw new Error(`Ollama HTTP ${resp.status}: ${resp.statusText}`);
    }

    const data = await resp.json();
    if (!data || !Array.isArray(data.embedding)) {
      throw new Error('Ollama \u8fd4\u56de\u7684 embedding \u683c\u5f0f\u5f02\u5e38');
    }
    return data.embedding;
  } finally {
    clearTimeout(timeoutId);
  }
}

function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

const DATE_REGEX = /(\d{4}-\d{2}-\d{2})/;

function extractDateFromFilename(filename) {
  const match = filename.match(DATE_REGEX);
  return match ? match[1] : null;
}

function dateFromMtime(mtime) {
  const y = mtime.getFullYear();
  const m = String(mtime.getMonth() + 1).padStart(2, '0');
  const d = String(mtime.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseTimeRange(timeRange) {
  const key = (timeRange || 'all').toLowerCase();
  const rangeMs = TIME_RANGE_MAP[key];
  if (rangeMs === undefined) {
    const hourMatch = key.match(/^(\d+)h$/);
    if (hourMatch) {
      return { cutoffMs: parseInt(hourMatch[1], 10) * 60 * 60 * 1000, label: `${hourMatch[1]}h` };
    }
    const dayMatch = key.match(/^(\d+)d$/);
    if (dayMatch) {
      return { cutoffMs: parseInt(dayMatch[1], 10) * 24 * 60 * 60 * 1000, label: `${dayMatch[1]}d` };
    }
    return { cutoffMs: Infinity, label: 'all' };
  }
  return { cutoffMs: rangeMs, label: key };
}

function ageInHours(fileDate, now) {
  return Math.max(0, (now.getTime() - fileDate.getTime()) / (1000 * 60 * 60));
}

function computeScore(ageHours, matchCount, totalLines) {
  const timeDecay = Math.exp(-ageHours * TIME_DECAY_FACTOR);
  const density = totalLines > 0 ? matchCount / totalLines : 0;
  const densityBoost = 1 + density * MATCH_DENSITY_WEIGHT;
  return Math.round(timeDecay * TIME_DECAY_WEIGHT * densityBoost * 10000) / 10000;
}

async function scanDialogFiles(dir, cutoffMs, now, maxFiles = 5000, depth = 0) {
  if (depth > 10) return [];
  const results = [];

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    console.warn(`[dialog-recall] \u626b\u63cf\u76ee\u5f55\u5931\u8d25 ${dir}: ${err?.message || '未知错误'}`);
    return [];
  }

  for (const entry of entries) {
    if (results.length >= maxFiles) break;
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue;
      const subFiles = await scanDialogFiles(fullPath, cutoffMs, now, maxFiles - results.length, depth + 1);
      results.push(...subFiles);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

    let fileDateStr = extractDateFromFilename(entry.name);

    let mtime;
    try {
      const fileStat = await stat(fullPath);
      mtime = fileStat.mtime;
    } catch (err) {
      console.warn(`[dialog-recall] \u83b7\u53d6\u6587\u4ef6\u72b6\u6001\u5931\u8d25 ${fullPath}: ${err?.message}`);
      continue;
    }

    if (!fileDateStr) {
      fileDateStr = dateFromMtime(mtime);
    }

    const fileDate = new Date(fileDateStr);
    if (isNaN(fileDate.getTime())) continue;

    const ageMs = now.getTime() - fileDate.getTime();
    if (ageMs > cutoffMs) continue;

    results.push({
      file: fullPath,
      dateStr: fileDateStr,
      date: fileDate,
      mtime,
    });
  }

  return results;
}

async function dispatchToWorkers(fileInfos, query, withContext, pool, priority) {
  if (fileInfos.length === 0) return [];

  const CHUNK_SIZE = 50;

  const chunks = [];
  for (let i = 0; i < fileInfos.length; i += CHUNK_SIZE) {
    const chunk = fileInfos.slice(i, i + CHUNK_SIZE);
    chunks.push(chunk.map(f => f.file));
  }

  const workerPromises = chunks.map(fileList =>
    pool.exec({
      type: 'dialog-search',
      keyword: query,
      files: fileList,
      withContext: !!withContext,
    }, priority || 'high')
  );

  const rawResults = await Promise.allSettled(workerPromises);

  const allResults = [];
  for (const r of rawResults) {
    if (r.status === 'fulfilled' && r.value && r.value.results) {
      allResults.push(...r.value.results);
    }
  }

  return allResults;
}

function enrichAndScore(searchResults, fileInfoMap, now) {
  return searchResults
    .map(item => {
      const info = fileInfoMap.get(item.file);
      if (!info) return null;
      const ageHrs = ageInHours(info.date, now);
      const matchCount = item.matchCount || 0;
      const totalLines = item.totalLines || 0;
      const score = computeScore(ageHrs, matchCount, totalLines);
      return {
        file: item.file,
        date: info.dateStr,
        ageHours: Math.round(ageHrs * 10) / 10,
        matchCount,
        totalLines,
        matchDensity: totalLines > 0 ? Math.round((matchCount / totalLines) * 10000) / 10000 : 0,
        score,
        matches: item.matches,
        error: item.error,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

async function rerankWithSemantic(enriched, query) {
  if (enriched.length === 0) {
    return { results: [], fallback: false };
  }

  const candidates = enriched.slice(0, SEMANTIC_TOP_N);

  let queryVector;
  try {
    queryVector = await getEmbedding(query);
  } catch (err) {
    console.warn(`[dialog-recall] Ollama embedding \u4e0d\u53ef\u7528, \u964d\u7ea7\u56de\u5173\u952e\u8bcd\u6392\u5e8f: ${err.message}`);
    return { results: enriched.slice(0, FINAL_TOP_N), fallback: true };
  }

  const snippetTasks = candidates.map(async (item) => {
    let snippetText = '';
    if (item.matches && item.matches.length > 0) {
      snippetText = item.matches
        .slice(0, 3)
        .map(m => {
          const lines = m.context || (m.matchedLine ? [m.matchedLine] : []);
          return lines.join(' ');
        })
        .join(' ')
        .substring(0, 512);
    }
    if (!snippetText) {
      snippetText = `\u5bf9\u8bdd\u6587\u4ef6 ${item.file} \u4e2d\u5173\u4e8e "${query}" \u7684\u8bb0\u5f55`;
    }
    return { item, snippetText };
  });

  const snippets = await Promise.all(snippetTasks);

  const embeddingResults = await Promise.allSettled(
    snippets.map(({ snippetText }) => getEmbedding(snippetText))
  );

  const scored = [];
  for (let i = 0; i < snippets.length; i++) {
    const { item } = snippets[i];
    const embResult = embeddingResults[i];
    let semanticScore = 0;
    if (embResult.status === 'fulfilled') {
      semanticScore = cosineSimilarity(queryVector, embResult.value);
    }
    const combinedScore = (item.score * 0.3) + (semanticScore * 0.7);
    scored.push({
      ...item,
      score: Math.round(combinedScore * 10000) / 10000,
      semanticScore: Math.round(semanticScore * 10000) / 10000,
    });
  }

  scored.sort((a, b) => b.score - a.score);

  return { results: scored.slice(0, FINAL_TOP_N), fallback: false };
}

export async function handleDialogRecall(params, pool) {
  const query = params.query;
  if (!query) throw new Error('[dialog-recall] missing query \u53c2\u6570');

  const timeRange = params.timeRange || 'all';
  const withContext = params.context === true;

  const now = new Date();
  const { cutoffMs, label: timeLabel } = parseTimeRange(timeRange);
  const cutoffDate = cutoffMs === Infinity ? null : new Date(now.getTime() - cutoffMs);

  const fileInfos = await scanDialogFiles(DIALOG_DIR, cutoffMs, now);
  if (fileInfos.length === 0) {
    return {
      status: 'success',
      query,
      timeRange: timeLabel,
      totalFiles: 0,
      totalMatches: 0,
      results: [],
      message: cutoffDate
        ? `\u5728 memory/dialog/ \u4e2d\u672a\u627e\u5230 ${timeLabel} \u5185\u7684 .md \u6587\u4ef6`
        : `\u5728 memory/dialog/ \u4e2d\u672a\u627e\u5230\u4efb\u4f55 .md \u6587\u4ef6`,
    };
  }

  const fileInfoMap = new Map();
  for (const info of fileInfos) {
    fileInfoMap.set(info.file, info);
  }

  const searchResults = await dispatchToWorkers(fileInfos, query, withContext, pool);

  const enriched = enrichAndScore(searchResults, fileInfoMap, now);

  const totalMatches = enriched.reduce((s, r) => s + r.matchCount, 0);

  const mode = params.mode || 'keyword';
  let topResults;
  let semanticInfo = null;

  if (mode === 'semantic' && enriched.length > 0) {
    const { results, fallback } = await rerankWithSemantic(enriched, query);
    const embCfg = await readEmbeddingConfig();
    topResults = results;
    semanticInfo = {
      enabled: true,
      model: `${embCfg.model}@${embCfg.baseUrl}`,
      fallback: fallback,
      candidateCount: Math.min(enriched.length, SEMANTIC_TOP_N),
    };
  } else {
    topResults = enriched.slice(0, 50);
  }

  return {
    status: 'success',
    query,
    mode,
    timeRange: timeLabel,
    totalFiles: fileInfos.length,
    searchedFiles: fileInfos.length,
    totalMatches,
    topResultsCount: topResults.length,
    semantic: semanticInfo,
    results: topResults,
    searchInfo: cutoffDate
      ? `\u641c\u7d22\u8303\u56f4: ${timeLabel} (${cutoffDate.toISOString().substring(0, 10)} \u81f3\u4eca)`
      : '\u641c\u7d22\u8303\u56f4: \u5168\u90e8\u65e5\u8bb0\u6587\u4ef6',
  };
}

export default {
  handleDialogRecall,
  scanDialogFiles,
  parseTimeRange,
  computeScore,
};
