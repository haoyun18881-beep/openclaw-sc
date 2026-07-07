
import { fileURLToPath, pathToFileURL } from 'url';
import { basename, dirname, join, normalize } from 'path';
import { cpus, homedir, EOL, freemem, totalmem } from 'os';
import { validatePath } from '../security.js';
import http from 'http';
import { spawn, spawnSync } from 'child_process';
import { readdir, readFile as rf } from 'fs/promises';
import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'fs';
import {
  handleCoreStats,
  handleCoreImageBatch,
} from '../lib/tool-handlers.js';
import { getEnv } from '../lib/env.js';
import { MCP_PORT } from '../lib/constants.js';
import { handleDialogRecall } from '../lib/dialog-recall.js';
import { fastPathSearch, splitFiles, mergeSearchResults, mergeLogResults, parseSearchArgs, parseLogArgs } from '../lib/code-review-shared.js';

import { getToolTiers } from '../lib/steward-rules.js';
// system-tools.js handleSystemRun — 仅 worker.js 内部使用，bridge 不需要
// task-chain.js — 已删除，功能由 pipeline 替代
// task-center.js — 已删除，功能由 pipeline 替代
// pipeline-engine.js — 仅 index.js 内部使用
// task-checker.js — 已删除
// task-profiles.js pickSubagentModel — 仅 index.js 使用
// tool-selector.js — 已删除

import { detectToolInjection } from '../lib/prompt-injection.js';
import { recordEvent as hippoRecordEvent } from './hippocampus-store.js';
import { multiPathSearch } from './hippocampus-multi-search.js';
import { qdrantSearch, qdrantBuild } from '../vector/usearch-http.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ====== Path resolution: support from tools/ 和 插件根目录两种调用 ======
const PLUGIN_DIR = (() => {
  if (basename(__dirname) === 'tools') {
    return join(__dirname, '..');
  }
  return __dirname;
})();

const SC_TASKCARD_GUARD_MODE = (process.env.SC_TASKCARD_GUARD_MODE || 'warn').toLowerCase();
const SC_PROMPT_MAX_CHARS = Number(process.env.SC_PROMPT_MAX_CHARS || 30000);
const SC_PIPELINE_MAX_GROUPS = Number(process.env.SC_PIPELINE_MAX_GROUPS || 100);

// External CPU instance injection（index.js 主动传入，避免循环依赖）
let _externalCpuInstance = null;

/**
 * 由 index.js 在Start MCP Server 时调用，传入已实例化的 cpu 对象
 * 从此 getCore() 优先返回外部实例，不再动态 import index.js
 */
export function setCpuInstance(instance) {
  _externalCpuInstance = instance;
}

// Dynamic import, fallback when no external instance
let cpuInstance = null;
async function getCore() {
  if (_externalCpuInstance) return _externalCpuInstance;
  if (!cpuInstance) {
    cpuInstance = await import(pathToFileURL(join(PLUGIN_DIR, 'index.js')).href);
  }
  return cpuInstance.default || cpuInstance;
}

// ====== USearch HTTP 查询（NSSM常驻 18793） ======
// qdrantSearch 由 ../vector/usearch-http.js 导入

// ====== CLI help ======
function showHelp() {
  console.log(`
sc v5.37.0 — CLI Bridge

Usage:
  node bridge.js search <keyword> [files...]      Parallel text search
  node bridge.js log <files...>                   Parallel log analysis
  node bridge.js stats                            Pool status
  node bridge.js resolve <provider> <modelId>     Model config resolve
  node bridge.js route <taskText>                 Multi-core decision engine
  node bridge.js mcp [--port <port>]              Start MCP Server (SSE)
  node bridge.js sync [--quick]                   Parallel sync to E:+G:
  node bridge.js --help                           This help

Options:
  --priority high|normal|low    任务Priority (default normal)
  --port <port>                 MCP Server 端口 (default 18790)

Examples:
  node bridge.js search "错误" C:\\logs\\*.log C:\\diary\\*.md
  node bridge.js log C:\\logs\\app.log
  node bridge.js resolve deepseek [model-id]
  node bridge.js route "帮我搜索一下配置文件"
  node bridge.js stats
  node bridge.js mcp --port 18790
`);
}

// ====== CLI entry ======
async function main() {
  try {
    const args = process.argv.slice(2);
    if (args.length === 0) { showHelp(); process.exit(0); }

    const cmd = args[0];
    const core = await getCore();

    switch (cmd) {
      case 'search': {
        const { keyword, files, priority } = parseSearchArgs(args.slice(1));
        if (!keyword) { console.error('Missing search keyword'); process.exit(1); }
        if (!files || files.length === 0) { console.error('Missing file list'); process.exit(1); }
        const poolStats = core.getStats();
        const tasks = splitFiles(files, poolStats.maxWorkers || 4);
        const results = await Promise.all(
          tasks.map(filesChunk =>
            core.pool.exec({ type: 'search-text', keyword, files: filesChunk }, priority)
          )
        );
        const merged = mergeSearchResults(results, poolStats);
        // TODO: 移除调试日志 console.log(JSON.stringify(merged, null, 2));
        break;
      }

      case 'log': {
        const { files, priority } = parseLogArgs(args.slice(1));
        if (!files || files.length === 0) { console.error('Missing file list'); process.exit(1); }
        const poolStats = core.getStats();
        const tasks = splitFiles(files, poolStats.maxWorkers || 4);
        const results = await Promise.all(
          tasks.map(filesChunk =>
            core.pool.exec({ type: 'process-log', files: filesChunk }, priority)
          )
        );
        const merged = mergeLogResults(results, poolStats);
        // TODO: 移除调试日志 console.log(JSON.stringify(merged, null, 2));
        break;
      }

      case 'stats': {
        const stats = core.getStats();
        // TODO: 移除调试日志 console.log(JSON.stringify(stats, null, 2));
        break;
      }

      case 'build': {
        // 🧠 USearch 增量编译
        const buildFiles = args.files || [];
        try {
          const buildResult = await qdrantBuild(buildFiles);
          result = {
            content: [{ type: "text", text: `🧠 USearch 增量完成: +${buildResult.added} 条, 共 ${buildResult.total} 条, ${buildResult.elapsed_ms}ms` }],
            status: 'success',
            action: 'build',
            mode: 'usearch',
            added: buildResult.added,
            total_in_index: buildResult.total,
            elapsed_ms: buildResult.elapsed_ms,
          };
        } catch (e) {
          result = {
            content: [{ type: "text", text: `⚠️ USearch 增量失败: ${e.message}` }],
            status: 'error',
            action: 'build',
            error: e.message,
          };
        }
        break;
      }

      case 'resolve': {
        const provider = args[1];
        const modelId = args[2];
        if (!provider || !modelId) { console.error('Usage: node bridge.js resolve <provider> <modelId>'); process.exit(1); }
        const result = await core.pool.exec({ type: 'resolve-model', provider, modelId });
        // TODO: 移除调试日志 console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'json': {
        const jsonAction = args[1];
        const jsonInput = args.slice(2).filter(a => !a.startsWith('--')).join(' ');
        const jsonIndentIdx = args.indexOf('--indent');
        const jsonIndent = jsonIndentIdx >= 0 ? parseInt(args[jsonIndentIdx + 1], 10) : 2;
        const validJsonActions = ['format', 'validate', 'convert', 'csv2json', 'json2csv'];
        if (!jsonAction || !validJsonActions.includes(jsonAction)) {
          console.error(`Usage: node bridge.js json <${validJsonActions.join('|')}> <input> [--indent N]`);
          process.exit(1);
        }
        if (!jsonInput) { console.error('Missing input'); process.exit(1); }
        try {
          const result = handleJsonTool({ action: jsonAction, input: jsonInput, indent: jsonIndent });
          // TODO: 移除调试日志 console.log(JSON.stringify(result, null, 2));
        } catch (e) {
          console.error(JSON.stringify({ status: 'error', message: e.message }, null, 2));
          process.exit(1);
        }
        break;
      }

      case 'route': {
        const taskText = args.slice(1).join(' ');
        if (!taskText) { console.error('Usage: node bridge.js route <taskText>'); process.exit(1); }
        const result = await core.pool.exec({ type: 'route-quick', text: taskText }, 'high');
        // TODO: 移除调试日志 console.log(JSON.stringify({
    // task: taskText,
    // quickResult: result,
    // note: result.matched ? `建议工具: ${result.tool} (置信度: ${result.confidence})` : '未匹配到直接工具，需走完整评估',
    // }, null, 2));
        break;
      }

      case 'sync': {
        const isQuick = args.includes('--quick');
        const pool = core.pool;
        const [eResult, gResult] = await Promise.all([
          pool.exec({ type: 'sync-archive', target: 'E', quick: isQuick }, 'normal').catch(e => ({ error: e.message })),
          pool.exec({ type: 'sync-archive', target: 'G', quick: isQuick }, 'normal').catch(e => ({ error: e.message })),
        ]);
        // TODO: 移除调试日志 console.log(JSON.stringify({ mode: isQuick ? 'quick' : 'full', E: eResult, G: gResult, timestamp: new Date().toISOString() }, null, 2));
        break;
      }

      case 'mcp': {
        const portIdx = args.indexOf('--port');
        const port = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : MCP_PORT;
        await startMcpServer(port);
        break;
      }

      case '--help':
      case '-h':
        showHelp();
        break;

      default:
        console.error(`Unknown命令: ${cmd}`);
        showHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error('main 执行出错:', err);
    process.exit(1);
  }
}

// ====== 共享工具函数（统一来自 lib/code-review-shared.js）======
// parseSearchArgs, parseLogArgs, splitFiles, mergeSearchResults, mergeLogResults
// 由 import 从 ../lib/code-review-shared.js 引入

const DEFAULT_SEARCH_CONFIG = {
  backends: ['tavily', 'ddg', 'direct_http'],
  tavily: {
    apiKeyEnv: 'TAVILY_API_KEY',
    timeout: 30000,
    maxRetries: 1,
    searchDepth: 'advanced',
  },
  ddg: {
    baseUrl: 'https://api.duckduckgo.com',
    htmlBaseUrl: 'https://html.duckduckgo.com/html/',
    timeout: 30000,
  },
  searxng: {
    baseUrl: '',
    timeout: 30000,
  },
  direct_http: {
    timeout: 30000,
    maxContentLength: 50000,
    searchUrl: 'https://www.bing.com/search',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) OpenClaw-sc-webSearch/1.0 Safari/537.36',
  },
};

const searchBackendState = {
  tavily: {
    exhaustedMonth: null,
  },
};

function getLocalMonthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function getSearchConfig(config) {
  const raw = config?.search || {};
  return {
    backends: normalizeSearchBackends(raw.backends || DEFAULT_SEARCH_CONFIG.backends),
    tavily: { ...DEFAULT_SEARCH_CONFIG.tavily, ...(raw.tavily || {}) },
    ddg: { ...DEFAULT_SEARCH_CONFIG.ddg, ...(raw.ddg || {}) },
    searxng: { ...DEFAULT_SEARCH_CONFIG.searxng, ...(raw.searxng || {}) },
    direct_http: { ...DEFAULT_SEARCH_CONFIG.direct_http, ...(raw.direct_http || {}) },
  };
}

function normalizeSearchBackends(backends) {
  const list = Array.isArray(backends) ? backends : String(backends || '').split(',');
  const seen = new Set();
  return list
    .map(v => String(v || '').trim().toLowerCase())
    .filter(v => v && !seen.has(v) && seen.add(v));
}

function clampMaxResults(value, fallback = 5) {
  const n = Number(value || fallback);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), 20);
}

function makeBackendError(backend, message, extra = {}) {
  return Object.assign(new Error(message || 'backend unavailable'), {
    backend,
    code: extra.code || -32603,
    status: extra.status,
    safeMessage: extra.safeMessage || '搜索服务暂时不可用，已切换备用渠道',
    quotaExhausted: Boolean(extra.quotaExhausted),
  });
}

function isTavilyExhausted() {
  return searchBackendState.tavily.exhaustedMonth === getLocalMonthKey();
}

function markTavilyExhausted() {
  searchBackendState.tavily.exhaustedMonth = getLocalMonthKey();
}

function isTavilyQuotaError(status, data, text) {
  const blob = [
    status === 429 ? '429' : '',
    typeof text === 'string' ? text : '',
    data?.detail?.error,
    data?.error,
    data?.message,
  ].filter(Boolean).join(' ').toLowerCase();
  return status === 429 ||
    blob.includes('usage limit') ||
    blob.includes('quota') ||
    blob.includes('rate limit') ||
    blob.includes('too many requests');
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new Error(`请求超时(${timeoutMs}ms)`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function readLimitedResponseText(resp, maxBytes = 50000) {
  if (!resp.body || typeof resp.body.getReader !== 'function') {
    const text = await resp.text();
    return text.slice(0, maxBytes);
  }

  const reader = resp.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      const remaining = maxBytes - total;
      chunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk);
      total += Math.min(chunk.length, remaining);
      if (chunk.length > remaining) {
        try { await reader.cancel(); } catch {}
        break;
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  return Buffer.concat(chunks).toString('utf8');
}

function tryParseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function decodeHtmlEntities(text) {
  const named = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  return String(text || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (_, ent) => {
    if (ent[0] === '#') {
      const isHex = ent[1]?.toLowerCase() === 'x';
      const code = parseInt(ent.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    }
    return named[ent.toLowerCase()] ?? '';
  });
}

function htmlToText(html) {
  return decodeHtmlEntities(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\r/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractHtmlTitle(html) {
  const match = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? htmlToText(match[1]).slice(0, 200) : '';
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function unwrapDuckDuckGoUrl(rawUrl) {
  const cleaned = decodeHtmlEntities(rawUrl || '');
  try {
    const withProtocol = cleaned.startsWith('//') ? `https:${cleaned}` : cleaned;
    const url = new URL(withProtocol);
    const uddg = url.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : withProtocol;
  } catch {
    return cleaned;
  }
}

function normalizeSearchResult(item, backend) {
  const url = item?.url || item?.href || item?.link || '';
  return {
    title: String(item?.title || item?.name || url || '(untitled)').trim(),
    url,
    content: String(item?.content || item?.snippet || item?.body || '').trim(),
    source: backend,
    score: item?.score,
  };
}

function dedupeSearchResults(results, maxResults) {
  const seen = new Set();
  const deduped = [];
  for (const item of results || []) {
    const normalized = normalizeSearchResult(item, item?.source || item?.backend || 'unknown');
    const key = (normalized.url || normalized.title).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(normalized);
    if (deduped.length >= maxResults) break;
  }
  return deduped;
}

function flattenDdgRelatedTopics(topics, out = []) {
  for (const topic of topics || []) {
    if (topic?.Topics) {
      flattenDdgRelatedTopics(topic.Topics, out);
      continue;
    }
    if (topic?.FirstURL || topic?.Text) {
      out.push({
        title: topic.Text ? topic.Text.split(' - ')[0] : topic.FirstURL,
        url: topic.FirstURL || '',
        content: topic.Text || '',
      });
    }
  }
  return out;
}

async function tavilySearch(query, maxResults, searchConfig, rootConfig) {
  if (isTavilyExhausted()) {
    throw makeBackendError('tavily', 'tavily quota exhausted this month', { quotaExhausted: true });
  }

  const tavilyKey = getEnv(searchConfig.tavily.apiKeyEnv || 'TAVILY_API_KEY') || rootConfig?.apiKeys?.tavily;
  if (!tavilyKey) {
    throw makeBackendError('tavily', 'tavily api key not configured', { code: -32000 });
  }

  const retries = Math.max(1, Number(searchConfig.tavily.maxRetries || 1));
  let lastError;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const resp = await fetchWithTimeout('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: tavilyKey,
          query,
          search_depth: searchConfig.tavily.searchDepth || 'advanced',
          max_results: maxResults,
          include_answer: true,
        }),
      }, Number(searchConfig.tavily.timeout || 10000));
      const text = await resp.text();
      const data = tryParseJson(text) || {};
      if (!resp.ok || isTavilyQuotaError(resp.status, data, text)) {
        if (isTavilyQuotaError(resp.status, data, text)) markTavilyExhausted();
        throw makeBackendError('tavily', `tavily unavailable status=${resp.status}`, {
          status: resp.status,
          quotaExhausted: isTavilyQuotaError(resp.status, data, text),
        });
      }
      return {
        backend: 'tavily',
        answer: data.answer || '',
        results: dedupeSearchResults((data.results || []).map(r => ({
          title: r.title,
          url: r.url,
          content: r.content || r.raw_content || '',
          score: r.score,
          source: 'tavily',
        })), maxResults),
      };
    } catch (e) {
      lastError = e;
      if (e?.quotaExhausted || attempt === retries - 1) break;
    }
  }
  throw lastError || makeBackendError('tavily', 'tavily unavailable');
}

async function duckDuckGoSearch(query, maxResults, searchConfig) {
  const baseUrl = String(searchConfig.ddg.baseUrl || DEFAULT_SEARCH_CONFIG.ddg.baseUrl).replace(/\/+$/, '');
  const timeout = Number(searchConfig.ddg.timeout || 10000);
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    no_redirect: '1',
    no_html: '1',
    skip_disambig: '1',
  });
  const results = [];
  let answer = '';

  try {
    const resp = await fetchWithTimeout(`${baseUrl}/?${params.toString()}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': searchConfig.direct_http.userAgent,
      },
    }, timeout);
    const text = await resp.text();
    const data = tryParseJson(text) || {};
    if (!resp.ok) {
      throw makeBackendError('ddg', `duckduckgo instant answer status=${resp.status}`, { status: resp.status });
    }
    answer = data.AbstractText || data.Answer || '';
    if (data.AbstractURL || data.AbstractText) {
      results.push({
        title: data.Heading || data.AbstractSource || query,
        url: data.AbstractURL || '',
        content: data.AbstractText || data.Answer || '',
        source: 'duckduckgo',
      });
    }
    results.push(...flattenDdgRelatedTopics(data.RelatedTopics).map(r => ({ ...r, source: 'duckduckgo' })));
  } catch (e) {
    // Instant Answer经常没有通用网页结果，继续尝试HTML端点。
  }

  if (results.length < maxResults) {
    try {
      results.push(...await duckDuckGoHtmlSearch(query, maxResults - results.length, searchConfig));
    } catch (e) {
      if (results.length === 0 && !answer) throw e;
    }
  }

  const finalResults = dedupeSearchResults(results, maxResults);
  if (finalResults.length === 0 && !answer) {
    throw makeBackendError('ddg', 'duckduckgo returned no results');
  }
  return { backend: 'duckduckgo', answer, results: finalResults };
}

async function duckDuckGoHtmlSearch(query, maxResults, searchConfig) {
  const htmlBase = String(searchConfig.ddg.htmlBaseUrl || DEFAULT_SEARCH_CONFIG.ddg.htmlBaseUrl);
  const url = `${htmlBase}${htmlBase.includes('?') ? '&' : '?'}${new URLSearchParams({ q: query }).toString()}`;
  const resp = await fetchWithTimeout(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': searchConfig.direct_http.userAgent,
    },
  }, Number(searchConfig.ddg.timeout || 10000));
  if (!resp.ok) {
    throw makeBackendError('ddg', `duckduckgo html status=${resp.status}`, { status: resp.status });
  }
  const html = await readLimitedResponseText(resp, 300000);
  const blocks = html.split(/<div[^>]+class=["'][^"']*result[^"']*["'][^>]*>/i).slice(1);
  const results = [];
  for (const block of blocks) {
    const linkMatch = block.match(/<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const snippetMatch = block.match(/class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/i);
    const parsedUrl = unwrapDuckDuckGoUrl(linkMatch[1]);
    if (!isHttpUrl(parsedUrl)) continue;
    results.push({
      title: htmlToText(linkMatch[2]),
      url: parsedUrl,
      content: snippetMatch ? htmlToText(snippetMatch[1]) : '',
      source: 'duckduckgo',
    });
    if (results.length >= maxResults) break;
  }
  return results;
}

async function searxngSearch(query, maxResults, searchConfig) {
  const baseUrl = String(searchConfig.searxng.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) {
    throw makeBackendError('searxng', 'searxng baseUrl not configured');
  }
  const params = new URLSearchParams({ q: query, format: 'json' });
  const resp = await fetchWithTimeout(`${baseUrl}/search?${params.toString()}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': searchConfig.direct_http.userAgent,
    },
  }, Number(searchConfig.searxng.timeout || 10000));
  const text = await resp.text();
  const data = tryParseJson(text) || {};
  if (!resp.ok) {
    throw makeBackendError('searxng', `searxng status=${resp.status}`, { status: resp.status });
  }
  const results = dedupeSearchResults((data.results || []).map(r => ({
    title: r.title,
    url: r.url,
    content: r.content || r.snippet || '',
    source: 'searxng',
    score: r.score,
  })), maxResults);
  if (results.length === 0) {
    throw makeBackendError('searxng', 'searxng returned no results');
  }
  return { backend: 'searxng', answer: data.answers?.[0] || '', results };
}

async function directHttpFetch(url, searchConfig) {
  if (!isHttpUrl(url)) {
    throw Object.assign(new Error('url 必须是 http/https'), { code: -32602 });
  }
  const directConfig = searchConfig.direct_http;
  const maxBytes = Number(directConfig.maxContentLength || 50000);
  const resp = await fetchWithTimeout(url, {
    redirect: 'follow',
    headers: {
      Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8',
      'User-Agent': directConfig.userAgent,
    },
  }, Number(directConfig.timeout || 10000));
  const raw = await readLimitedResponseText(resp, maxBytes);
  if (!resp.ok) {
    throw Object.assign(new Error(`HTTP ${resp.status}`), { code: -32603, status: resp.status });
  }
  const contentType = resp.headers.get('content-type') || '';
  const content = /html|xml/i.test(contentType) || /<html[\s>]/i.test(raw)
    ? htmlToText(raw)
    : raw.trim();
  return {
    backend: 'direct_http',
    results: [{
      url: resp.url || url,
      title: extractHtmlTitle(raw),
      content: content.slice(0, maxBytes),
      contentType,
      status: resp.status,
      truncated: raw.length >= maxBytes,
    }],
  };
}

async function directHttpSearch(query, maxResults, searchConfig) {
  if (!isHttpUrl(query)) {
    return directHttpSearchPage(query, maxResults, searchConfig);
  }
  const fetched = await directHttpFetch(query, searchConfig);
  const item = fetched.results?.[0] || {};
  return {
    backend: 'direct_http',
    answer: item.content?.slice(0, 500) || '',
    results: [{
      title: item.title || item.url || query,
      url: item.url || query,
      content: item.content || '',
      source: 'direct_http',
    }].slice(0, maxResults),
  };
}

async function directHttpSearchPage(query, maxResults, searchConfig) {
  const directConfig = searchConfig.direct_http;
  const baseUrl = String(directConfig.searchUrl || DEFAULT_SEARCH_CONFIG.direct_http.searchUrl);
  const joiner = baseUrl.includes('?') ? '&' : '?';
  const url = `${baseUrl}${joiner}${new URLSearchParams({ q: query }).toString()}`;
  const resp = await fetchWithTimeout(url, {
    redirect: 'follow',
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': directConfig.userAgent,
    },
  }, Number(directConfig.timeout || 10000));
  if (!resp.ok) {
    throw makeBackendError('direct_http', `direct search status=${resp.status}`, { status: resp.status });
  }
  const html = await readLimitedResponseText(resp, 300000);
  const results = parseBingHtmlResults(html, maxResults);
  if (results.length === 0) {
    throw makeBackendError('direct_http', 'direct search returned no results');
  }
  return {
    backend: 'direct_http',
    answer: '',
    results,
  };
}

function parseBingHtmlResults(html, maxResults) {
  const blocks = String(html || '').split(/<li[^>]+class=["'][^"']*\bb_algo\b[^"']*["'][^>]*>/i).slice(1);
  const results = [];
  for (const block of blocks) {
    const linkMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const parsedUrl = decodeHtmlEntities(linkMatch[1]);
    if (!isHttpUrl(parsedUrl)) continue;
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    results.push({
      title: htmlToText(linkMatch[2]),
      url: parsedUrl,
      content: snippetMatch ? htmlToText(snippetMatch[1]) : '',
      source: 'direct_http',
    });
    if (results.length >= maxResults) break;
  }
  return dedupeSearchResults(results, maxResults);
}

async function runWebSearch(args, config) {
  const searchConfig = getSearchConfig(config);
  const query = args?.query;
  if (!query) throw Object.assign(new Error('缺少 query'), { code: -32602 });
  const maxResults = clampMaxResults(args?.maxResults || args?.max_results || 5);
  const errors = [];
  let fallbackUsed = false;

  for (const backend of searchConfig.backends) {
    try {
      let backendResult;
      switch (backend) {
        case 'tavily':
          backendResult = await tavilySearch(query, maxResults, searchConfig, config);
          break;
        case 'ddg':
        case 'duckduckgo':
          backendResult = await duckDuckGoSearch(query, maxResults, searchConfig);
          break;
        case 'searxng':
          backendResult = await searxngSearch(query, maxResults, searchConfig);
          break;
        case 'direct_http':
          backendResult = await directHttpSearch(query, maxResults, searchConfig);
          break;
        default:
          throw makeBackendError(backend, `unknown backend: ${backend}`);
      }
      return {
        action: 'web_search',
        query,
        backend: backendResult.backend || backend,
        fallbackUsed,
        notice: fallbackUsed ? '搜索服务暂时不可用，已切换备用渠道' : undefined,
        answer: backendResult.answer || '',
        results: (backendResult.results || []).slice(0, maxResults),
      };
    } catch (e) {
      fallbackUsed = true;
      errors.push({ backend, status: e?.status || null, quotaExhausted: Boolean(e?.quotaExhausted) });
      console.warn(`[webSearch] backend=${backend} failed status=${e?.status || 'n/a'} quota=${Boolean(e?.quotaExhausted)}`);
    }
  }

  throw Object.assign(new Error('搜索服务暂时不可用，备用渠道也未返回结果'), {
    code: -32603,
    safeErrors: errors,
  });
}

async function runWebFetch(args, config) {
  const searchConfig = getSearchConfig(config);
  const url = args?.url;
  if (!url) throw Object.assign(new Error('缺少 url'), { code: -32602 });
  const fetched = await directHttpFetch(url, searchConfig);
  return {
    action: 'web_fetch',
    backend: 'direct_http',
    ...fetched,
  };
}

// ====== MCP Server ======

/**
 * 启动 MCP over SSE Server
 * 使用 Node.js 内置 http 模块，零依赖
 */
// ====== ⑨ 熔断器状态（MCP 工具级别 — 双通道痛觉系统）======
// 双通道设计：
//   A-delta（快通道）：60秒内相同session+工具连续失败≥3次→仅该session熔断30秒
//   C纤维（慢通道）  ：每5分钟聚合所有工具成败比，<50%→emergency（仅主agent）
// 🔧 2026-06-09 改造：按 sessionId 隔离熔断，不改连坐。一个兵死了不影响其他兵。

// ---- A-delta 快通道状态 ----
const aDeltaErrors = new Map(); // "sessionId:toolName" -> [{errorMsg, timestamp}]
const circuitBreakerState = new Map(); // "sessionId:toolName" -> { meltedUntil }

function _makeCircuitKey(toolName, sessionId) {
  return `${sessionId || 'anon'}:${toolName}`;
}

// ====== 子agent spawn 上限计数（Map<sessionId, count>）======
const activeSpawns = new Map();

function isToolMelted(toolName, sessionId) {
  if (!toolName) return false;
  const key = _makeCircuitKey(toolName, sessionId);
  const state = circuitBreakerState.get(key);
  if (!state) return false;
  if (Date.now() >= state.meltedUntil) {
    circuitBreakerState.delete(key);
    return false;
  }
  return true;
}

/**
 * A-delta 快通道 + C纤维慢通道：记录失败事件
 * 1) A-delta: 60秒窗口内同一session+工具失败≥7次→仅该session熔断60秒（不连坐）
 * 2) C纤维:    累积成败统计，触发5分钟聚合检查
 * @param {string} toolName
 * @param {string} errorMsg
 * @param {string} [sessionId]
 */
function recordToolFailure(toolName, errorMsg, sessionId) {
  if (!toolName) return;
  const now = Date.now();
  const aDeltaKey = _makeCircuitKey(toolName, sessionId);

  // ---- A-delta 快通道 ----
  let queue = aDeltaErrors.get(aDeltaKey);
  if (!queue) {
    queue = [];
    aDeltaErrors.set(aDeltaKey, queue);
  }
  queue.push({ errorMsg: errorMsg || '', timestamp: now });

  // 清理超过60秒的旧记录
  const cutoff = now - 60_000; // 60秒窗口
  const recent = queue.filter(e => e.timestamp >= cutoff);
  aDeltaErrors.set(aDeltaKey, recent);

  // 统计相同错误模式的出现次数
  const patternCounts = new Map();
  for (const entry of recent) {
    const msg = entry.errorMsg || '';
    patternCounts.set(msg, (patternCounts.get(msg) || 0) + 1);
  }

  // 阈值: ≥20次 → 30秒熔断
  for (const [msg, count] of patternCounts) {
    if (count >= 20) {
      const meltDuration = 30_000; // 熔断30秒
      const meltKey = _makeCircuitKey(toolName, sessionId);
      circuitBreakerState.set(meltKey, { meltedUntil: now + meltDuration });

      writeCircuitBreakerLog({
        type: 'a_delta_circuit_break',
        tool: toolName,
        sessionId: sessionId || 'anon',
        reason: `A-delta: ${sessionId||'anon'} 在60秒内"${(msg || '').substring(0, 80)}" 出现${count}次 → 仅该session熔断60秒`,
        diagnosis: {
          channel: 'A-delta（快通道）',
          pattern: (msg || '').substring(0, 120),
          count,
          windowMs: 60_000,
          meltMs: meltDuration,
          isolated: true,
        },
      }).catch(() => {});
      console.warn(`[sc MCP] A-delta熔断: ${toolName} session=${sessionId||'anon'} 连续失败${count}次 → 冷却60秒`);
      break; // 一次熔断只记录一个错误模式
    }
  }

}

/**
 * 记录成功：
 * 1) A-delta: 一次成功重置该session的错误队列（清空证据）
 * 2) C纤维:    递增成功计数
 * 3) 熔断状态:  一次成功解除该session的熔断
 * @param {string} toolName
 * @param {string} [sessionId]
 */
function recordToolSuccess(toolName, sessionId) {
  if (!toolName) return;
  const aDeltaKey = _makeCircuitKey(toolName, sessionId);

  // A-delta: 一次成功清除该session的失败队列
  aDeltaErrors.delete(aDeltaKey);

  // 一次成功解除该session的熔断
  const meltKey = _makeCircuitKey(toolName, sessionId);
  circuitBreakerState.delete(meltKey);

}/** 本地 writeCircuitBreakerLog（与 index.js 同名函数写入同一文件）*/
async function writeCircuitBreakerLog(entry) {
  try {
    const { readFile, writeFile } = await import('fs/promises');
    const { join: jn } = await import('path');
    const { homedir: hd } = await import('os');
    const logPath = jn(hd(), '.openclaw', 'workspace', 'memory', 'shared', 'circuit-breaker-log.json');
    let log = [];
    try {
      const raw = await readFile(logPath, 'utf-8');
      log = JSON.parse(raw);
    } catch {}
    if (!Array.isArray(log)) log = [];
    entry.timestamp = new Date().toISOString();
    log.push(entry);
    if (log.length > 100) log = log.slice(-100);
    await writeFile(logPath, JSON.stringify(log, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[sc Bridge] ⚠️ circuit breaker write failed:', err.message);
  }
}

/** 从工具参数和结果中提取关键词，用于联想缓存 */
function extractToolKeywords(toolName, params, result) {
  const keywords = [toolName];
  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params)) {
      if (typeof v === 'string' && v.length < 100) keywords.push(v);
      if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') keywords.push(...v.slice(0, 3));
    }
  }
  if (result && typeof result === 'object') {
    const type = result.type || result.status || '';
    if (type) keywords.push(type);
    if (result.topic) keywords.push(result.topic);
    if (result.summary) keywords.push(result.summary?.substring(0, 50));
  }
  return [...new Set(keywords.filter(Boolean))];
}

async function startMcpServer(port = MCP_PORT) {
  // ??? shutdown 定义提到 try 外，ESM strict 模式下 block 内 function 声明不会被 hoist
  // 否则 catch 块调 shutdown() 时 ReferenceError: shutdown is not defined
  let sseClients;
  let server;
  let scInboxTimer = null;
  let scInboxPollRunning = false;
  const scInboxState = {
    enabled: false,
    autoNotify: false,
    notifyAck: true,
    chatInject: false,
    pollMs: null,
    lastPollAt: null,
    lastNotifyOkAt: null,
    lastChatInjectAttemptAt: null,
    lastChatInjectOkAt: null,
    lastAckAt: null,
    lastEventCount: 0,
    lastNonOk: null,
    lastError: null,
  };

  function getScInboxDeliveryMode() {
    const raw = String(process.env.SC_INBOX_DELIVERY_MODE || '').trim().toLowerCase();
    if (['notify-only', 'chat-inject', 'both', 'off'].includes(raw)) return raw;
    if (process.env.SC_INBOX_CHAT_INJECT === '0') return 'notify-only';
    if (process.env.SC_INBOX_AUTO_NOTIFY === '0' && process.env.SC_INBOX_CHAT_INJECT === '0') return 'off';
    return 'chat-inject';
  }

  function shouldInjectScInboxChat(mode) {
    return mode === 'chat-inject' || mode === 'both';
  }

  function parseBooleanEnv(value) {
    if (value === undefined || value === null || value === '') return null;
    const raw = String(value).trim().toLowerCase();
    if (!raw) return null;
    if (['0', 'false', 'no', 'off'].includes(raw)) return false;
    if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
    return true;
  }

  function shouldAckScInboxNotify(mode = getScInboxDeliveryMode()) {
    const explicit = parseBooleanEnv(process.env.SC_INBOX_NOTIFY_ACK);
    if (explicit !== null) return explicit;
    return mode === 'notify-only';
  }

  function shutdown() {
    if (scInboxTimer) {
      clearInterval(scInboxTimer);
      scInboxTimer = null;
    }
    if (sseClients) {
      for (const [, res] of sseClients) {
        try { res.end(); } catch {}
      }
      sseClients.clear();
    }
    if (server) { try { server.close(); } catch {} }
  }

  try {
    // SSE 客户端连接池 (sessionId -> response)
    sseClients = new Map();

    let sessionIdCounter = 0;
    function generateSessionId() {
      return `session_${Date.now()}_${++sessionIdCounter}`;
    }

    // ====== 从统一配置加载工具定义 ======
    // mcp-tools.config.json 集中管理所有 MCP 工具和访问规则
    const { readFileSync } = await import('fs');
    const configPath = join(PLUGIN_DIR, 'tools', 'mcp-tools.config.json');
    let config;
    try {
      config = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch (e) {
      console.error(`[bridge] 无法加载 MCP 工具配置: ${e.message}`);
      throw e;
    }

    const tools = config.tools;
    const ALLOWED_MCP_TOOLS = new Set(tools.map(t => t.name));
    const MAIN_DENY_TOOLS = new Set(config.main?.deny || []);
    const SUBAGENT_BLOCKED_TOOLS = new Set(config.subagent.blocked);
    const SUBAGENT_PARTIAL_ALLOWED = config.subagent.partialAllowed || {};

  // 心跳/轮询类工具 — cascade cancel时不追杀（当前无心跳工具，Set留空）
  const HEARTBEAT_TOOLS = new Set([]);

  // ① 全局限流（滑动窗口 — 每 session 每 10 秒最多 30 次）
  const RATE_WINDOW_MS = 10000;
  const RATE_MAX_CALLS = 60;
  const mcpRateBuckets = new Map(); // sessionId -> { timestamps: [] }
  const antiRecurMap = new Map(); // 防递归: toolName:sessionId -> timestamp
  const toolRateLimitMap = new Map(); // 工具级限流: toolName:sessionId -> { sec, count }

// 🚫 硬编码 spawn 递归深度限制 — 杉哥2026-06-03颁令
// 子agent调兵最多3层，谁调都不绕过，天王老子来了也最多3层
const HARD_SPAWN_LIMIT = 3;
const spawnDepthMap = new Map(); // parentSessionId -> depth (0=主agent)

  /**
   * 追加审计日志条目到 audit chain
   * 用于 superExec/superFile 等超级工具，自动记录操作到日志文件
   */
  async function appendAuditLog(entry) {
    try {
      const { readFile, writeFile, mkdir } = await import('fs/promises');
      const { join: jn } = await import('path');
      const auditBase = jn(PLUGIN_DIR, 'logs', 'audit');
      await mkdir(auditBase, { recursive: true }).catch(() => {});
      const auditFile = jn(auditBase, 'super-operations.chain');
      const hashFile = jn(auditBase, 'super-last-hash.txt');

      // 读取上一个hash
      let prevHash = '';
      try { prevHash = await readFile(hashFile, 'utf-8'); } catch {}

      const crypto = await import('crypto');
      entry.prevLogHash = prevHash.trim();
      const entryStr = JSON.stringify(entry);
      const hash = crypto.createHash('sha256').update(entryStr).digest('hex');
      entry.hash = 'sha256:' + hash;

      await writeFile(auditFile, JSON.stringify(entry) + '\n', { flag: 'a', encoding: 'utf-8' });
      await writeFile(hashFile, hash, 'utf-8');
    } catch (e) {
      console.warn('[sc 审计] ⚠️ appendAuditLog 写入失败:', e.message);
    }
  }

  // ====== MCP 请求并发信号量（防 >5 并发瓶颈）======
  // 限制同时处理的 /messages POST 请求数，防止 Worker 池过载 + 主线程 Event Loop 阻塞
  const MCP_MAX_CONCURRENT = 200; // 适配20路日常+100路爆发
  let mcpConcurrentCount = 0;
  const mcpConcurrentQueue = []; // {resolve, reject, ts} 排队等待的请求

  // 从 MCP 并发队列中取出等待的请求处理
  function drainMcpConcurrentQueue() {
    while (mcpConcurrentCount < MCP_MAX_CONCURRENT && mcpConcurrentQueue.length > 0) {
      const waiter = mcpConcurrentQueue.shift();
      mcpConcurrentCount++;
      waiter.resolve(); // 释放等待者
    }
  }

  /**
   * 尝试获取 MCP 并发槽位
   * 超出 MCP_MAX_CONCURRENT 则排队等待（最多等 30 秒超时）
   * @returns {Promise<boolean>} true=拿到槽位, false=排队超时
   */
  function acquireMcpSlot() {
    if (mcpConcurrentCount < MCP_MAX_CONCURRENT) {
      mcpConcurrentCount++;
      return Promise.resolve(true);
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const idx = mcpConcurrentQueue.indexOf(waiter);
        if (idx >= 0) mcpConcurrentQueue.splice(idx, 1);
        resolve(false); // 排队超时，返回 false
      }, 30000);
      const waiter = {
        resolve: () => { clearTimeout(timeout); resolve(true); },
        reject: () => { clearTimeout(timeout); reject(new Error('MCP 请求被取消')); },
        ts: Date.now(),
      };
      mcpConcurrentQueue.push(waiter);
    });
  }

  function releaseMcpSlot() {
    mcpConcurrentCount = Math.max(0, mcpConcurrentCount - 1);
    drainMcpConcurrentQueue();
  }

  // ====== SSE 写队列：防止同一 session 的并发 SSE write 交错 ======
  const sseWriteQueues = new Map(); // sessionId -> Promise chain

  /**
   * 安全地向 SSE session 写数据，同一 session 串行化写操作
   */
  function safeSseWrite(sessionId, msg) {
    if (!sseWriteQueues.has(sessionId)) {
      sseWriteQueues.set(sessionId, Promise.resolve());
    }
    const chain = sseWriteQueues.get(sessionId);
    const next = chain.then(() => {
      const res = sseClients.get(sessionId);
      if (res) {
        try { res.write(msg); } catch { sseClients.delete(sessionId); }
      }
    });
    sseWriteQueues.set(sessionId, next.catch(() => {}));
    return next;
  }

  // 工具级限流阈值（按 TOOL_TIERS 等级划分）
  const TOOL_RATE_LIMITS = {
    safe: Infinity,           // safe级：无限流（本来就是低频的）
    suggest_delegate: 10,     // suggest_delegate级：10次/秒
  };

  function checkMcpRateLimit(sessionId) {
    if (!sessionId) return true; // 无 sessionId 不限制
    const now = Date.now();
    let bucket = mcpRateBuckets.get(sessionId);
    if (!bucket) {
      bucket = { timestamps: [] };
      mcpRateBuckets.set(sessionId, bucket);
    }
    // 滑窗修剪
    bucket.timestamps = bucket.timestamps.filter(t => now - t < RATE_WINDOW_MS);
    // [H-03 FIX] 惰性清理：空桶旧session条目自动删除
    if (bucket.timestamps.length === 0) {
      mcpRateBuckets.delete(sessionId);
    }
    if (bucket.timestamps.length >= RATE_MAX_CALLS) {
      return false; // 超限
    }
    bucket.timestamps.push(now);
    return true;
  }

  // ③ MCP级连接口（保留供将来扩展）

  // ====== JSON-RPC 处理 ======
  async function handleJsonRpc(body, sessionId, eventCtx = {}) {
    const { jsonrpc, id, method, params } = body;
    if (jsonrpc !== '2.0' || !method) {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    }

    // ====== V4 完整安全链（前半段，仅 tools/call 生效）======
    // ⑧ 优先判断：子agent放行（跳过整条安全链直接执行）
    const isSubagent = eventCtx?.isSubagent === true;

    // [M-01 FIX] Prompt Injection检测对所有 tools/call 生效（含子agent）
    if (method === 'tools/call') {
      const _piToolName = params?.name;
      if (_piToolName) {
        try {
          const injectResult = detectToolInjection(_piToolName, params?.arguments || {});
          if (injectResult.block) {
            return { jsonrpc: '2.0', id: body?.id || null, error: { code: -32000, message: `[🛡️] ${injectResult.reason}` } };
          }
        } catch (e) {
          console.warn('[PiFilter]⛔ 检测异常:', e.message);
        }
      }
    }

    // [SUBAGENT-BLOCK] 子agent安全链 — v5.18.9 硬拦截（杉哥2026-06-03颁令）
    // 子agent一律禁调以下所有工具。返回统一消息。
    if (method === 'tools/call' && isSubagent) {
      const _subToolName = params?.name;

      // [SUBAGENT-BLOCK v5.30.0] 子agent工具拦截 — 规则从 mcp-tools.config.json 动态加载
      if (_subToolName) {
        const partialRule = SUBAGENT_PARTIAL_ALLOWED[_subToolName];
        if (partialRule) {
          // 部分放行：检查 action 是否在配置的白名单内
          const _action = params?.arguments?.action || '';
          if (partialRule.actions.includes(_action)) {
            // 放行 — 走的工具在部分放行白名单内
            // 额外规则：fileManager write 需 workspace 路径检查
            if (_subToolName === 'fileManager' && _action === 'write') {
              const _writePath = params?.arguments?.path || '';
              const WORKSPACE_PREFIX = join(homedir(), '.openclaw', 'workspace');
              const normalizedWritePath = normalize(_writePath || '');
              if (!normalizedWritePath.startsWith(WORKSPACE_PREFIX)) {
                return { jsonrpc: '2.0', id: body?.id || null, error: { code: -32000, message: '[🛡️] fileManager write仅允许workspace路径（杉哥限制）' } };
              }
            }
          } else {
            // 操作不在白名单内 — 拦截
            return { jsonrpc: '2.0', id: body?.id || null, error: { code: -32000, message: `[🛡️] ${_subToolName} 子agent仅允许操作: ${partialRule.actions.join(', ')}（杉哥限制）` } };
          }
        } else if (SUBAGENT_BLOCKED_TOOLS.has(_subToolName)) {
          // 全量拦截：此工具子agent禁调
          return { jsonrpc: '2.0', id: body?.id || null, error: { code: -32000, message: '[🛡️] 此工具子agent无法调用（杉哥限制）' } };
        }
      }

      // 通行证继承检查: 硬拦截之外的 force_delegate 级工具仍需通行证
      if (_subToolName) {
        try {
          const _stTiers = getToolTiers();
          if (_stTiers.force_delegate.includes(_subToolName)) {
            const coreMod = await getCore();
            const hasInheritedPass = typeof coreMod.checkSubagentPass === 'function' ? coreMod.checkSubagentPass(_subToolName) : false;
            if (!hasInheritedPass) {
              return { jsonrpc: '2.0', id: body?.id || null, error: { code: -32000, message: '[🛡️] 此工具子agent无法调用（杉哥限制）' } };
            }
          }
        } catch (e) {
          console.warn('[SubagentPass]⛔ 通行证检查异常:', e.message);
        }

        // ① 防递归：子agent同一个工具名+同一个sessionId，3秒内不能重复调
        const _subAntiRecurKey = `${_subToolName}:${sessionId}`;
        const _subNow = Date.now();
        if (antiRecurMap.has(_subAntiRecurKey)) {
          const _subLastCall = antiRecurMap.get(_subAntiRecurKey);
          if (_subNow - _subLastCall < 3000) {
            return { jsonrpc: '2.0', id: body?.id || null, error: { code: -32000, message: `工具 ${_subToolName} 3秒内重复调用被拦截 (距上次仅 ${_subNow - _subLastCall}ms)` } };
          }
        }
        antiRecurMap.set(_subAntiRecurKey, _subNow);
        if (antiRecurMap.size > 1000) {
          const _subCutoff = _subNow - 20000;
          for (const [k, v] of antiRecurMap) {
            if (v < _subCutoff) antiRecurMap.delete(k);
          }
        }
      }
    }

    if (method === 'tools/call' && !isSubagent) {
      const toolName = params?.name;
      if (!toolName) {
        return { jsonrpc: '2.0', id: body?.id || null, error: { code: -32602, message: '缺少工具名称' } };
      }

      // ① Prompt Injection 检测已前置（见上方[M-01 FIX]块，子agent也覆盖），此处跳过



      // ② 白名单判断
      if (!ALLOWED_MCP_TOOLS.has(toolName)) {
        return { jsonrpc: '2.0', id: body?.id || null, error: { code: -32601, message: `工具 ${toolName} 不允许通过 MCP 调用` } };
      }

      // ⚡ 脊髓反射白名单 — 高频safe工具直通Worker，绕开步骤③④⑤⑥（当前无，Set留空）
      const SPINAL_REFLEX_TOOLS = new Set([
      ]);
      const isSpinalReflex = SPINAL_REFLEX_TOOLS.has(toolName);

      if (!isSpinalReflex) {
        // ③ 通行证检查（仅 force_delegate 级工具需要通行证，safe/suggest_delegate/未分类defaultsafe的跳过）
        const _passBypass = [];
        const _passTiers = getToolTiers();
        if (_passTiers.force_delegate.includes(toolName) && !_passBypass.includes(toolName)) {
          try {
            const coreModule = await getCore();
            if (typeof coreModule.checkPass === 'function') {
              if (!coreModule.checkPass(toolName)) {
                return { jsonrpc: '2.0', id: body?.id || null, error: { code: -32000, message: `工具 ${toolName} 需要通行证或已被系统限制` } };
              }
            }
          } catch {}
        }

        // ④ StewardGuard tier check (using getToolTiers)
        // 杉哥2026-06-09: 修复步骤③④互斥——步骤③已放行的force_delegate(有通行证)不再被④拦截
        try {
          const _sTiers = getToolTiers();
          if (_sTiers.force_delegate.includes(toolName)) {
            let hasPass = false;
            try {
              const coreModule = await getCore();
              if (typeof coreModule.checkPass === 'function') {
                hasPass = coreModule.checkPass(toolName);
              }
            } catch {}
            if (!hasPass) {
              return { jsonrpc: '2.0', id: body?.id || null, error: { code: -32000, message: `[Steward] 🚫 ${toolName} 属于 force_delegate 级，必须由子 agent 执行` } };
            }
          }
        } catch (e) { console.warn('[Steward]⛔ 步骤4异常:', e.message); }

        
      }

      // ⑦ 全局限流（滑动窗口 — 每 session 每 10 秒最多 30 次）
      if (!checkMcpRateLimit(sessionId)) {
        return { jsonrpc: '2.0', id: body?.id || null, error: { code: -32000, message: 'MCP 调用频率过高（每10秒最多30次），请稍后再试' } };
      }

      // ② 工具级限流 — 每个工具独立计数器，按 TOOL_TIERS 等级划分阈值
      //    safe级：无限流 | suggest_delegate级：10次/秒 | force_delegate级：到不了MCP层
      const nowSec = Math.floor(Date.now() / 1000);
      const toolRateKey = `${toolName}:${sessionId || 'default'}`;
      let toolBucket = toolRateLimitMap.get(toolRateKey);
      if (!toolBucket || toolBucket.sec !== nowSec) {
        toolBucket = { sec: nowSec, count: 0 };
        toolRateLimitMap.set(toolRateKey, toolBucket);
        // [H-02 FIX] 惰性清理：toolRateLimitMap 过期条目（清理超过5秒的旧桶）
        if (toolRateLimitMap.size > 5000) {
          const cutoffSec = nowSec - 5;
          for (const [k, v] of toolRateLimitMap) {
            if (v.sec < cutoffSec) toolRateLimitMap.delete(k);
            if (toolRateLimitMap.size <= 3500) break;
          }
        }
      }
      toolBucket.count++;
      let toolLimit = TOOL_RATE_LIMITS.safe; // default不限流
      try {
        const tiers = getToolTiers();
        if (tiers.suggest_delegate.includes(toolName)) {
          toolLimit = TOOL_RATE_LIMITS.suggest_delegate;
        }
        // force_delegate 级的工具到不了这一步（步骤④已拦截，所以忽略）
      } catch {}
      if (toolBucket.count > toolLimit) {
        const limitMsg = toolLimit === Infinity ? '无限(安全级)' : `${toolLimit}次/秒`;
        return { jsonrpc: '2.0', id: body?.id || null, error: { code: -32000, message: `工具 ${toolName} 调用频率过高（阈值: ${limitMsg}）` } };
      }


    }

    // 内存保护（跨method通用）
    if (method === 'tools/call') {
      try {
        const coreModule = await getCore();
        if (typeof coreModule.getMemoryLevel === 'function') {
          const mem = coreModule.getMemoryLevel();
          if (mem.level === 'meltdown') {
            return { jsonrpc: '2.0', id: body?.id || null, error: { code: -32000, message: `系统内存严重不足(${mem.freeGB.toFixed(1)}GB)` } };
          }
          if (mem.level === 'red') {
            const writeTools = ['fileManager', 'codeEditor'];
            const toolName = params?.name;
            if (toolName && writeTools.includes(toolName)) {
              return { jsonrpc: '2.0', id: body?.id || null, error: { code: -32000, message: `空闲内存仅 ${mem.freeGB.toFixed(1)}GB（红灯），写操作被限制` } };
            }
          }
        }
      } catch {}
    }

    // cascade cancel追踪（v12心跳跳过）
    if (method === 'tools/call') {
      const toolName = params?.name;
      if (toolName && HEARTBEAT_TOOLS.has(toolName)) {
        // 跳过级联追踪
      }
    }

    switch (method) {
      case 'initialize': {
        return {
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: {},
              resources: {},
            },
            serverInfo: { name: 'sc', version: '5.37.0', description: 'sc v5.37.0 — 28核并行决策引擎 | Worker 池 + MCP 工具 + 语义搜索 + 子agent执行中心' },
          },
        };
      }

      case 'tools/list': {
        // SSE连接(Gateway)传sessionId → 返回全部工具
        // 直接POST(子agent)无sessionId → 只返回子agent能用的工具
        // 注意：不要用 url.xxx！handleJsonRpc 不在HTTP闭包里，url不存在！
        // 必须用函数参数 sessionId
        const subagentOnly = params?.role === 'subagent';
        if (subagentOnly) {
          const safe = tools.filter(t => !SUBAGENT_BLOCKED_TOOLS.has(t.name));
          return { jsonrpc: '2.0', id, result: { tools: safe } };
        }
        // 主会话过滤 main.deny 工具
        const mainSafe = tools.filter(t => !MAIN_DENY_TOOLS.has(t.name));
        return { jsonrpc: '2.0', id, result: { tools: mainSafe } };
      }

      case 'tools/call': {
        let toolName = params?.name;
        const args = params?.arguments || {};
        
        const core = await getCore();

        // ⑨ 熔断器：按session隔离检查（一个兵死了不影响其他兵）
        if (toolName && !HEARTBEAT_TOOLS.has(toolName) && isToolMelted(toolName, sessionId)) {
          return {
            jsonrpc: '2.0', id,
            error: { code: -32000, message: `工具 ${toolName} 在你的会话中暂时熔断（连续失败≥3次，30秒后自动恢复，不影响其他会话）` },
          };
        }

        let _execStartTime;
        try {
          let result;
          _execStartTime = Date.now();
          switch (toolName) {


            case 'spawnWorker': {
              // 走Worker池(CPU)/USearch/本地CPU — 不走Sidecar，零Token
              // 杉哥2026-06-09: spawnWorker=Worker池，spawnAgent=Sidecar
              try {
                const action = args.action || 'search';
                const core = await getCore();
                const pool = core.pool;
                const priority = args.priority || 'normal';
                const maxResults = Math.min(Number(args.maxResults) || 20, 100);
                let result;

                switch (action) {
                  case 'search': {
                    const keyword = args.keyword || '';
                    const files = args.files || [];
                    const searchPath = args.path || '';
                    if (!keyword) throw new Error('search action \u7f3a\u5c11 keyword');
                    // 如果传了 path 且没传 files，自动枚举该目录
                    let searchFiles = files;
                    if (files.length === 0 && searchPath) {
                      const { readdirSync, statSync } = await import('fs');
                      const { extname } = await import('path');
                      const textExts = new Set(['.md','.js','.cjs','.json','.txt','.yml','.yaml','.conf','.cfg','.toml','.ini','.env','.css','.html','.htm','.xml','.svg','.py','.sh','.bat','.ps1']);
                      function walkDir(dir) {
                        try {
                          const entries = readdirSync(dir, { withFileTypes: true });
                          for (const e of entries) {
                            if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'logs' || e.name === 'hippocampus') continue;
                            const full = dir + '/' + e.name;
                            if (e.isDirectory()) walkDir(full);
                            else if (e.isFile() && textExts.has(extname(e.name).toLowerCase()) && statSync(full).size < 524288) searchFiles.push(full);
                          }
                        } catch {}
                      }
                      walkDir(searchPath);
                    }
                    // 走真正的 Worker 池并行搜索（28路 Worker 分块执行）
                    const core = await getCore();
                    const poolStats = core.getStats();
                    const chunks = splitFiles(searchFiles, poolStats.maxWorkers || 28);
                    const rawResults = await Promise.all(
                      chunks.map(fc => core.pool.exec({ type: 'search-text', keyword, files: fc, maxFiles: 999999, maxMinResults: 999999 }, priority))
                    );
                    result = mergeSearchResults(rawResults, poolStats);
                    result.action = 'search';
                    result.keyword = keyword;
                    result.originalFiles = searchFiles.length;
                    break;
                  }
                  case 'analyze': {
                    const anaFiles = args.files || [];
                    const analysis = [];
                    for (const fp of anaFiles.slice(0, 100)) {
                      try {
                        const content = readFileSync(fp, 'utf-8');
                        const lineArr = content.split('\n');
                        analysis.push({
                          file: fp,
                          size: Buffer.byteLength(content, 'utf8'),
                          lines: lineArr.length,
                          preview: lineArr.slice(0, 10).join('\n').substring(0, 500),
                          ext: fp.split('.').pop()
                        });
                      } catch (e) { analysis.push({ file: fp, error: e.message }); }
                    }
                    result = { action: 'analyze', total: anaFiles.length, analyzed: analysis.length, files: analysis };
                    break;
                  }
                  case 'semantic':
                    if (!args.query) throw new Error('semantic action 缺少 query');
                    result = await qdrantSearch(args.query, maxResults);
                    break;
                  case 'diff': {
                    const diffFiles = args.files || [];
                    if (diffFiles.length < 2) throw new Error('diff action \u9700\u8981\u81f3\u5c112\u4e2a\u6587\u4ef6');
                    const contentA = readFileSync(diffFiles[0], 'utf-8').split('\n');
                    const contentB = readFileSync(diffFiles[1], 'utf-8').split('\n');
                    const maxLen = Math.max(contentA.length, contentB.length);
                    const diffs = [];
                    for (let i = 0; i < maxLen; i++) {
                      const lineA = contentA[i] || '';
                      const lineB = contentB[i] || '';
                      if (lineA !== lineB) {
                        diffs.push({ line: i + 1, a: lineA.substring(0, 200), b: lineB.substring(0, 200) });
                        if (diffs.length >= 50) break;
                      }
                    }
                    result = { action: 'diff', fileA: diffFiles[0], fileB: diffFiles[1], totalLines: maxLen, diffCount: diffs.length, diffs };
                    break;
                  }
                  case 'stats': {
                    const { readFile } = await import('fs/promises');
                    const { statSync } = await import('fs');
                    let statsResults = [];
                    for (let fi=0; fi<Math.min((args.files||[]).length,200); fi++) {
                      try {
                        const fp=args.files[fi],s=statSync(fp);
                        statsResults.push({file:fp,size:s.size,lines:0,mtime:s.mtime.toISOString()});
                      }catch(e){statsResults.push({file:args.files[fi],error:e.message});}
                    }
                    result = {action:'stats',files:statsResults};
                    break;
                  }
                  default: throw new Error('unknown action: '+action);
                }
                return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] } };
              } catch (e) {
                return { jsonrpc: '2.0', id, error: { code: -32603, message: e.message } };
              }
            }

            case 'spawnAgent': {
              const guard = validateScSpawnTask(args, 'spawnAgent', { mode: SC_TASKCARD_GUARD_MODE });
              if (!guard.ok) return scGuardJsonRpcError(id, guard);
              args.__scGuard = guard;
              const result = await spawnAgent(args);
              if (result) {
                // C方案兜底: 120秒后检查子agent是否完成
                const cTaskId = result.taskId || result.id;
                if (cTaskId) {
                  setTimeout(() => {
                    try {
                      const watchDir = join(homedir(), '.openclaw', 'workspace', 'memory', 'dialog', 'subagent');
                      const doneSuccess = join(watchDir, `DONE_${cTaskId}_success`);
                      const doneFailed = join(watchDir, `DONE_${cTaskId}_failed`);
                      const doneStalled = join(watchDir, `DONE_${cTaskId}_stalled`);
                      const doneOrphaned = join(watchDir, `DONE_${cTaskId}_orphaned`);
                      if (!existsSync(doneSuccess) && !existsSync(doneFailed) && !existsSync(doneStalled) && !existsSync(doneOrphaned)) {
                        if (!existsSync(watchDir)) mkdirSync(watchDir, { recursive: true });
                        writeFileSync(join(watchDir, `WATCH_${cTaskId}.json`), JSON.stringify({ taskId: cTaskId, status: 'overdue', checkedAt: new Date().toISOString(), message: '子agent可能超时, 请检查' }));
                      }
                    } catch (e) { /* 静默 */ }
                  }, 120000);
                }
                return { jsonrpc: '2.0', id, result: result };
              }
              return { jsonrpc: '2.0', id, error: { code: -32603, message: 'spawnAgent failed' } };
            }

            case 'taskPipeline': {
              const guard = validateScPipelineTask(args, { mode: SC_TASKCARD_GUARD_MODE });
              if (!guard.ok) return scGuardJsonRpcError(id, guard);
              args.__scGuard = guard;
              const result = await spawnTaskPipeline(args);
              if (result) return { jsonrpc: '2.0', id, result: result };
              return { jsonrpc: '2.0', id, error: { code: -32603, message: 'taskPipeline failed' } };
            }

            case 'scInbox': {
              const result = await scInbox(args);
              return { jsonrpc: '2.0', id, result };
            }

             

            case 'webSearch': {
              // 多后端搜索+直连抓取，0Token不走LLM
              const searchAction = args?.action || 'web_search';
              if (searchAction === 'web_search') {
                result = await runWebSearch(args, config);
              } else if (searchAction === 'web_fetch') {
                result = await runWebFetch(args, config);
              } else {
                result = { status: 'error', message: `Unknown操作: ${searchAction}` };
              }
              break;
            }

            case 'glob': {
              // 文件 glob 匹配 — 主会话+子Agent 通用
              const { glob } = await import('fs/promises');
              const pattern = args?.pattern;
              if (!pattern) throw Object.assign(new Error('缺少 pattern'), { code: -32602 });
              const basePath = args?.path || join(homedir(), '.openclaw', 'workspace');
              const fullPattern = join(basePath, pattern).replace(/\\/g, '/');
              const raw = await Array.fromAsync(glob(fullPattern, { exclude: (filePath) => filePath.includes('node_modules') || filePath.includes('.git/') || filePath.includes('logs/') }));
              // 按修改时间降序
              const { stat } = await import('fs/promises');
              const withStats = await Promise.all(raw.map(async (f) => {
                try { const s = await stat(f); return { path: f, mtimeMs: s.mtimeMs }; }
                catch { return { path: f, mtimeMs: 0 }; }
              }));
              withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
              const files = withStats.map(s => s.path);
              result = { files, total: files.length };
              break;
            }

            case 'grep': {
              // ripgrep 高速代码搜索 — 主会话+子Agent 通用
              const { execFileSync } = await import('child_process');
              const { existsSync } = await import('fs');
              const bundledRg = join(PLUGIN_DIR, 'tools', 'rg', 'ripgrep-14.1.1-x86_64-pc-windows-msvc', 'rg.exe');
              const rgExe = process.env.SC_RG_PATH || (existsSync(bundledRg) ? bundledRg : 'rg');
              const pattern = args?.pattern;
              if (!pattern) throw Object.assign(new Error('缺少 pattern'), { code: -32602 });
              const searchPath = args?.path || join(homedir(), '.openclaw', 'workspace');
              const outputMode = args?.outputMode || 'content';
              const rgArgs = ['--no-heading', '--color', 'never'];
              if (args?.ignoreCase) rgArgs.push('-i');
              if (args?.multiline) rgArgs.push('--multiline');
              if (args?.glob) { rgArgs.push('-g', args.glob); }
              if (args?.context) { rgArgs.push('-C', String(args.context)); }
              if (outputMode === 'files_with_matches') rgArgs.push('-l');
              else if (outputMode === 'count') rgArgs.push('--count');
              else rgArgs.push('-n'); // content mode: show line numbers
              rgArgs.push('--', pattern, searchPath);
              let raw = '';
              try {
                raw = execFileSync(rgExe, rgArgs, { timeout: 60000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf-8' }).trim();
              } catch (err) {
                if (err?.status === 1 && !err?.stdout) raw = '';
                else throw Object.assign(new Error('ripgrep 不可用；请安装 rg 或设置 SC_RG_PATH 指向 rg 可执行文件'), { code: -32000, cause: err });
              }
              if (!raw) { result = { matches: [], summary: '无匹配' }; }
              else {
                const lines = raw.split('\n').filter(Boolean);
                const headLimit = args?.headLimit || 250;
                const offset = args?.offset || 0;
                const sliced = offset ? lines.slice(offset) : lines;
                const limited = headLimit ? sliced.slice(0, headLimit) : sliced;
                result = { matches: limited, total: lines.length, mode: outputMode };
              }
              break;
            }

            case 'stats': {
              try {
                result = await handleCoreStats({}, core.pool);
              } catch (e) {
                return { jsonrpc: '2.0', id, error: { code: -32603, message: e.message } };
              }
              break;
            }

            case 'batchVision': {
              const { files, prompt, model, priority } = args;
              try {
                result = await handleCoreImageBatch({ files, prompt, model, priority }, core.pool);
              } catch (e) {
                return { jsonrpc: '2.0', id, error: { code: -32603, message: e.message } };
              }
              break;
            }

            case 'fileManager': {
              const { action, path, content } = args;
              if (!action) throw Object.assign(new Error('缺少 action'), { code: -32602 });
              if (!path) throw Object.assign(new Error('缺少 path'), { code: -32602 });
              const fs = await import('fs/promises');
              const { join: jn, dirname: dn } = await import('path');
              switch (action) {
                case 'read': {
                  const safePath = await validatePath(path);
                  const text = await fs.readFile(safePath, 'utf-8');
                  result = { status: 'success', action: 'read', path, size: text.length, content: text };
                  break;
                }
                case 'write': {
                  if (content === undefined || content === null) throw Object.assign(new Error('write 操作需要 content 参数'), { code: -32602 });
                  const safePath = await validatePath(path);
                  await fs.mkdir(dn(safePath), { recursive: true });
                  await fs.writeFile(safePath, String(content), 'utf-8');
                  result = { status: 'success', action: 'write', path, size: String(content).length };
                  break;
                }
                case 'copy': {
                  const dest = args.dest || args.target;
                  if (!dest) throw Object.assign(new Error('copy 操作需要 dest/target 参数'), { code: -32602 });
                  const safeSrc = await validatePath(path);
                  const safeDest = await validatePath(dest);
                  await fs.mkdir(dn(safeDest), { recursive: true });
                  await fs.cp(safeSrc, safeDest, { recursive: true });
                  result = { status: 'success', action: 'copy', source: path, dest };
                  break;
                }
                case 'move': {
                  const dest = args.dest || args.target;
                  if (!dest) throw Object.assign(new Error('move 操作需要 dest/target 参数'), { code: -32602 });
                  const safeSrc = await validatePath(path);
                  const safeDest = await validatePath(dest);
                  await fs.mkdir(dn(safeDest), { recursive: true });
                  await fs.rename(safeSrc, safeDest);
                  result = { status: 'success', action: 'move', source: path, dest };
                  break;
                }
                case 'list': {
                  const safePath = await validatePath(path);
                  const entries = await fs.readdir(safePath, { withFileTypes: true });
                  const listing = entries.map(e => ({
                    name: e.name,
                    type: e.isDirectory() ? 'directory' : 'file',
                  }));
                  result = { status: 'success', action: 'list', path, entries: listing, total: listing.length };
                  break;
                }
                default:
                  throw Object.assign(new Error(`Unknown操作: ${action}`), { code: -32602 });
              }
              break;
            }

            case 'validate': {
              const { action, path: vPath } = args;
              if (!action || !vPath) throw Object.assign(new Error('缺少 action 或 path'), { code: -32602 });
              
              const safePath = await validatePath(vPath);
              const { execSync: es, spawnSync } = await import('child_process');
              
              switch (action) {
                case 'check': {
                  try {
                    es(`node --check "${safePath}"`, { encoding: 'utf8', timeout: 15000, stdio: ['pipe','pipe','pipe'] });
                    result = { valid: true, exitCode: 0, path: vPath, message: '✅ 语法检查通过' };
                  } catch (e) {
                    const errMsg = e.stderr || e.stdout || e.message || '';
                    result = { valid: false, exitCode: e.status || 1, path: vPath, errors: errMsg.substring(0, 2000) };
                  }
                  break;
                }
                case 'load': {
                  // 隔离子进程 require 验证模块能否加载
                  const script = `try { require(${JSON.stringify(safePath)}); console.log('OK'); } catch(e) { console.error(e.message); process.exit(1); }`;
                  const r = spawnSync('node', ['-e', script], { encoding: 'utf8', timeout: 15000, stdio: ['pipe','pipe','pipe'] });
                  if (r.status === 0) {
                    result = { valid: true, exitCode: 0, path: vPath, message: '✅ 模块加载成功' };
                  } else {
                    const errMsg = r.stderr || r.stdout || r.error?.message || '';
                    result = { valid: false, exitCode: r.status || 1, path: vPath, errors: errMsg.substring(0, 2000) };
                  }
                  break;
                }
                case 'diff': {
                  // git diff 查看文件改动（只读，安全）
                  const { dirname: dn } = await import('path');
                  const dir = dn(safePath);
                  try {
                    const r = spawnSync('git', ['-C', dir, 'diff', safePath], { encoding: 'utf8', timeout: 10000, stdio: ['pipe','pipe','pipe'] });
                    if (r.status === 0 && r.stdout) {
                      result = { path: vPath, diff: r.stdout.substring(0, 3000), message: r.stdout.length > 3000 ? 'diff过长已截断' : '✅ git diff 成功' };
                    } else if (r.status === 0 && !r.stdout) {
                      result = { path: vPath, diff: '', message: '📄 文件无改动' };
                    } else if (r.stderr && r.stderr.includes('not a git repository')) {
                      result = { path: vPath, diff: null, message: '⚠️ 文件不在 git 仓库中' };
                    } else {
                      result = { path: vPath, diff: null, message: '⚠️ git diff 不可用: ' + (r.stderr || '').substring(0, 200) };
                    }
                  } catch (e) {
                    result = { path: vPath, diff: null, message: '⚠️ git 不可用: ' + (e.message || '').substring(0, 200) };
                  }
                  break;
                }
                default:
                  throw Object.assign(new Error(`validate 不支持 action=${action}，仅支持 check|load|diff`), { code: -32602 });
              }
              break;
            }

            case 'emergencyStop': {
              try {
                const idxMod = await import(pathToFileURL(join(PLUGIN_DIR, 'index.js')).href);
                const abortFn = idxMod?.default?.cpuAbort || idxMod?.cpuAbort;
                if (typeof abortFn === 'function') {
                  await abortFn();
                  result = { status: 'success', message: '紧急停止已完成: 所有Worker已终止, 队列已清空' };
                } else {
                  result = { status: 'error', message: 'cpuAbort 未就绪，紧急停止不可用' };
                }
              } catch (e) {
                result = { status: 'error', message: e.message };
              }
              break;
            }
            case 'codeEditor': {
              const codeAction = args.action || 'review_code';
              const codePath = args.path || '';
              switch (codeAction) {
                case 'edit_code':
                  // 🔧 v5.37.0-v5.38.0: 仅保留 edits 模式精确替换（删 content 全量覆盖，防子 Agent 误写）
                  // 用法：先 review_code 读文件 → edit_code(edits=[{oldText,newText}]) 精确替换
                  try {
                    const { writeFile } = await import('fs/promises');
                    const safePath = await validatePath(codePath);
                    if (!args.edits || !Array.isArray(args.edits) || args.edits.length === 0) {
                      throw Object.assign(new Error('edit_code 只支持 edits=[{oldText,newText}] 精确替换模式（content 全量覆盖已删除）'), { code: -32602 });
                    }
                    let originalContent = '';
                    try { originalContent = await rf(safePath, 'utf-8'); } catch {}
                    let finalContent = originalContent;
                    for (const edit of args.edits) {
                      if (!edit.oldText) continue;
                      if (!finalContent.includes(edit.oldText)) {
                        throw Object.assign(new Error(`edit_code: 未找到匹配文本 "${edit.oldText.substring(0, 50)}..."`), { code: -32603 });
                      }
                      finalContent = finalContent.replace(edit.oldText, edit.newText || '');
                    }
                    await writeFile(safePath, finalContent, 'utf-8');
                    // 🔒 硬性语法校验：JS文件写后自动跑 node --check，不通过则回滚
                    if (/\.(js|cjs|mjs)$/i.test(safePath)) {
                      const { execFileSync } = await import('child_process');
                      try {
                        execFileSync(process.execPath, ['--check', safePath], { timeout: 10000, stdio: 'pipe' });
                      } catch (checkErr) {
                        // 语法错误：恢复原文件，拒绝提交
                        if (originalContent) {
                          await writeFile(safePath, originalContent, 'utf-8');
                        }
                        const errMsg = checkErr.stderr?.toString() || checkErr.message;
                        throw Object.assign(new Error(`❌ 语法校验失败，编辑已回滚: ${errMsg.split('\n')[0]}`), { code: -32603 });
                      }
                    }
                    result = { content: [{ type: "text", text: `✅ 已编辑: ${codePath} (${finalContent.length} chars, ${finalContent.split('\n').length} lines)` }] };
                  } catch (e) {
                    throw Object.assign(new Error(`edit_code 失败: ${e.message}`), { code: e.code || -32603 });
                  }
                  break;
                case 'review_code':
                  // 真实代码审查：读取文件返回给 LLM 分析
                  try {
                    const fileContent = await rf(codePath, 'utf-8');
                    const fileStats = statSync(codePath);
                    const ext = codePath.split('.').pop() || '';
                    result = {
                      content: [{
                        type: "text",
                        text: `## 📄 代码审查: ${codePath}\n` +
                              `- 大小: ${fileStats.size} bytes\n` +
                              `- 修改: ${fileStats.mtime}\n` +
                              `- 行数: ${fileContent.split('\n').length}\n` +
                              `- 扩展名: .${ext}\n\n` +
                              `\`\`\`${ext}\n${fileContent}\n\`\`\``
                      }]
                    };
                  } catch (e) {
                    throw Object.assign(new Error(`review_code 读取文件失败: ${e.message}`), { code: -32603 });
                  }
                  break;
                default:
                  result = { content: [{ type: "text", text: `Unknownaction: ${codeAction}` }] };
                  break;
              }
              break;
            }
            case 'memorySearch': {
              let reasonAction = args.action || 'smart';
              // smart 自动判断：含时间关键词 → search_dialog, 否则 → semantic_search
              if (reasonAction === 'smart') {
                const q = (args.query || '').toLowerCase();
                const timePattern = /\b(今天|昨天|前天|上周|本周|最近|\d{4}[-/]\d{1,2}|\d{1,2}月\d{1,2}日|刚刚|刚才|早上|下午|晚上)\b/i;
                reasonAction = timePattern.test(q) ? 'search_dialog' : 'semantic_search';
              }
              switch (reasonAction) {
                case 'semantic_search': {
                  // 🧠 Qdrant 语义搜索
                  const { query, maxResults } = args;
                  if (!query) throw Object.assign(new Error('缺少 query'), { code: -32602 });
                  
                  try {
                    const maxRes = Math.min(maxResults || 10, 50);
                    const faissResult = await qdrantSearch(query, maxRes);
                    const topResults = (faissResult.results || []).slice(0, maxRes);
                    // 确保 total_in_index 是数字（防御 HTTP 序列化问题）
                    const totalCount = Number(faissResult.total_in_index) || topResults.length || 0;
                    
                    const summaryText = topResults.length > 0
                      ? `🧠 USearch 语义搜索: "${query}" — ${totalCount} 条索引, ${faissResult.elapsed_ms}ms\n` +
                        topResults.slice(0, 10).map((r, i) => `  ${i+1}. [${r.score}] ${r.source}: ${r.text.substring(0, 100)}...`).join('\n')
                      : `🧠 USearch 语义搜索: "${query}" — 未找到匹配 (${totalCount} 条索引, ${faissResult.elapsed_ms}ms)`;
                    
                    result = {
                      content: [{ type: "text", text: summaryText.substring(0, 2000) }],
                      status: 'success',
                      action: 'semantic_search',
                      query,
                      mode: 'usearch',
                      total_in_index: totalCount,
                      elapsed_ms: faissResult.elapsed_ms,
                      results: topResults,
                      note: `USearch 语义搜索完成: ${topResults.length} 条, ${faissResult.elapsed_ms}ms`,
                    };
                  } catch (e) {
                    // USearch 失败 → 回退到旧 Worker pool 方式
                    console.warn(`[bridge] USearch 语义搜索失败, 回退到旧模式: ${e.message}`);
                    const { files, rootDir, priority } = args;
                    let fileList = files;
                    if (!fileList || fileList.length === 0) {
                      const { readdir: rd } = await import('fs/promises');
                      const scanRoot = rootDir ? await validatePath(rootDir) : join(homedir(), '.openclaw');
                      const foundFiles = [];
                      async function scanDir(dir, depth = 0) {
                        if (depth > 10 || foundFiles.length >= 200) return;
                        try {
                          const entries = await rd(dir, { withFileTypes: true });
                          for (const e of entries) {
                            if (foundFiles.length >= 200) break;
                            const full = join(dir, e.name);
                            if (e.isDirectory() && !e.name.startsWith('.')) await scanDir(full, depth + 1);
                            else if (e.isFile() && !e.name.startsWith('.')) foundFiles.push(full);
                          }
                        } catch {}
                      }
                      await scanDir(scanRoot);
                      fileList = foundFiles;
                    }
                    if (!fileList || fileList.length === 0) {
                      throw Object.assign(new Error('没有找到可搜索的文件'), { code: -32602 });
                    }
                    const maxRes = Math.min(maxResults || 10, 50);
                    const chunkSize = 50;
                    const chunks = [];
                    for (let i = 0; i < fileList.length; i += chunkSize) {
                      chunks.push(fileList.slice(i, i + chunkSize));
                    }
                    const SEMANTIC_TIMEOUT = 30000;
                    const workerResults = await Promise.race([
                      Promise.allSettled(
                        chunks.map(fc => core.pool.exec({
                          type: 'semantic-search',
                          query,
                          files: fc,
                          maxResults: Math.ceil(maxRes / Math.max(1, chunks.length)) + 10,
                        }, priority || 'high'))
                      ),
                      new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('语义搜索超时（30秒） —  Worker池可能繁忙或Ollama无响应')), SEMANTIC_TIMEOUT)
                      ),
                    ]);
                    const allResults = [];
                    for (const r of workerResults) {
                      if (r.status === 'fulfilled' && r.value && r.value.results) {
                        allResults.push(...r.value.results);
                      }
                    }
                    allResults.sort((a, b) => b.score - a.score);
                    const topResults = allResults.slice(0, maxRes);
                    const summaryText = topResults.length > 0
                      ? `语义搜索: "${query}" — 在 ${fileList.length} 个文件中找到 ${allResults.length} 处匹配 [回退模式]\n` +
                        topResults.slice(0, 5).map(r => `📄 ${r.file} (相似度${r.score})`).join('\n')
                      : `语义搜索: "${query}" — 未找到语义匹配 [回退模式]`;
                    result = {
                      content: [{ type: "text", text: summaryText.substring(0, 500) }],
                      status: 'success',
                      action: 'semantic_search',
                      query,
                      mode: 'fallback_worker',
                      totalFiles: fileList.length,
                      totalScored: topResults.filter(r => r.score > 0).length,
                      results: topResults,
                    };
                  }
                  break;
                }
                case 'search_dialog': {
                  // 调 handleDialogRecall — 对接海马体对话日记检索 (Worker pool + 语义重排序)
                  const { query, timeRange, context, mode } = args;
                  if (!query) throw Object.assign(new Error('缺少 query'), { code: -32602 });
                  try {
                    const recallResult = await handleDialogRecall({ query, timeRange, context, mode }, core.pool);
                    const topResults = (recallResult.results || []).slice(0, 10);
                    result = {
                      content: [{ type: "text", text:
                        `搜索对话: "${query}" — ${recallResult.totalMatches} 条匹配, ${recallResult.totalFiles} 个文件\n` +
                        (topResults.length > 0
                          ? topResults.map(r => `📄 ${r.file} (${r.matchCount}处, 评分${r.score})`).join('\n')
                          : '无匹配结果')
                      }],
                      status: 'success',
                      action: 'search_dialog',
                      query,
                      mode: recallResult.mode || mode || 'keyword',
                      totalMatches: recallResult.totalMatches,
                      totalFiles: recallResult.totalFiles,
                      searchedFiles: recallResult.searchedFiles,
                      semantic: recallResult.semantic || null,
                      results: topResults,
                      note: `对话日记检索完成: ${recallResult.totalMatches} 条匹配`,
                    };
                  } catch (e) {
                    return { jsonrpc: '2.0', id, error: { code: -32603, message: e.message } };
                  }
                  break;
                }
                case 'memory_query': {
                  // 🧠 USearch 语义查询
                  const memQuery = args.query || '';
                  const maxResults = args.maxResults || 10;
                  
                  try {
                    const faissResult = await qdrantSearch(memQuery, Math.min(maxResults, 50));
                    const topResults = (faissResult.results || []).slice(0, maxResults);
                    const totalCount = Number(faissResult.total_in_index) || topResults.length || 0;
                    
                    let text;
                    if (topResults.length > 0) {
                      text = `🧠 USearch 海马体查询: "${memQuery}" — ${totalCount} 条索引, ${faissResult.elapsed_ms}ms\n` +
                        topResults.map((r, i) => `  ${i+1}. [${r.score}] ${r.source}: ${r.text.substring(0, 120)}...`).join('\n');
                    } else {
                      text = `🧠 USearch 海马体查询: "${memQuery}" — 无匹配 (共 ${totalCount} 条索引)`;
                    }
                    
                    result = {
                      content: [{ type: "text", text: text.substring(0, 2000) }],
                      status: 'success',
                      action: 'memory_query',
                      query: memQuery,
                      mode: 'usearch',
                      total_in_index: totalCount,
                      elapsed_ms: faissResult.elapsed_ms,
                      timing: faissResult.timing,
                      results: topResults,
                      note: `USearch 海马体查询完成: ${topResults.length} 条, ${faissResult.elapsed_ms}ms`,
                    };
                  } catch (e) {
                    // USearch 查询失败 → 回退到旧的关键词 JSON 搜索
                    console.warn(`[bridge] USearch 查询失败, 回退到旧模式: ${e.message}`);
                    const hipDir = join(homedir(), '.openclaw', 'workspace', 'memory', 'hippocampus');
                    const hipFiles = ['index.json', 'entities.json', 'timeline.json', 'decisions.json'];
                    const results = [];
                    let totalEntries = 0;
                    for (const fName of hipFiles) {
                      const fPath = join(hipDir, fName);
                      try {
                        const raw = await rf(fPath, 'utf-8');
                        const data = JSON.parse(raw);
                        totalEntries++;
                        const matches = [];
                        const inspect = (obj, path_ = '') => {
                          if (typeof obj === 'string') {
                            if (!memQuery || obj.toLowerCase().includes(memQuery.toLowerCase())) {
                              matches.push({ value: obj, path: path_ });
                            }
                          } else if (Array.isArray(obj)) {
                            obj.forEach((item, i) => inspect(item, `${path_}[${i}]`));
                          } else if (obj && typeof obj === 'object') {
                            for (const [k, v] of Object.entries(obj)) {
                              const subPath = path_ ? `${path_}.${k}` : k;
                              if (!memQuery || k.toLowerCase().includes(memQuery.toLowerCase())) {
                                if (typeof v === 'string') matches.push({ value: v, key: k, path: subPath });
                              }
                              inspect(v, subPath);
                            }
                          }
                        };
                        inspect(data);
                        if (matches.length > 0) {
                          results.push({ file: fName, matches: matches.slice(0, maxResults) });
                        }
                      } catch (e2) {
                        results.push({ file: fName, error: e2.message });
                      }
                    }
                    result = {
                      content: [{ type: "text", text: `海马体记忆索引查询: "${memQuery}" (${results.length}/${hipFiles.length} files with matches) [回退模式]` }],
                      status: 'success',
                      action: 'memory_query',
                      query: memQuery,
                      mode: 'fallback_keyword',
                      hippocampus: { files: hipFiles.length, searched: totalEntries, matchedFiles: results.length, details: results },
                      note: `回退到关键词搜索: ${results.filter(r => r.matches).reduce((a, r) => a + r.matches.length, 0)} 条匹配。`,
                    };
                  }
                  break;
                }
                case 'lcm_recall': {
                  // LCM上下文回忆 — lcm_grep/lcm_expand 是 OpenClaw 原生插件工具，不在 Worker pool 中
                  // 返回指引提示，让调用方知道需使用原生工具而非 MCP
                  result = {
                    content: [{ type: "text", text: `LCM回忆需要 OpenClaw 原生插件工具支持，请使用 OpenClaw 原生 lcm_grep/lcm_expand 工具。` }],
                    status: 'info',
                    action: 'lcm_recall',
                    query: args.query,
                    note: '提示: LCM 是 OpenClaw 插件系统能力，无法通过 MCP Worker pool 调用。请使用 OpenClaw 原生工具的 lcm_grep/lcm_expand。',
                  };
                  break;
                }
                case 'multi_search': {
                  // 🧠 五路并行记忆搜索
                  const { query, timeRange, limit, enablePathB, enablePathC, enablePathD, enablePathE } = args;
                  if (!query) throw Object.assign(new Error('缺少 query'), { code: -32602 });
                  try {
                    const mResult = await multiPathSearch({
                      query,
                      timeRange: timeRange || 'all',
                      limit: limit || 10,
                      enablePathB: enablePathB !== false,
                      enablePathC: enablePathC !== false,
                      enablePathD: enablePathD !== false,
                      enablePathE: enablePathE !== false,
                    }, core.pool);

                    // 构建文本摘要
                    const topResults = (mResult.results || []).slice(0, 10);
                    const pathStats = mResult.pathStats || {};
                    const statLines = Object.entries(pathStats)
                      .filter(([, s]) => s && s.count > 0)
                      .map(([k, s]) => `${k}: ${s.count}条(${s.elapsed}ms)`)
                      .join(', ');

                    const summaryText = [
                      `🧠 多路径搜索: "${query}"`,
                      `  五路统计: ${statLines || '无有效路径'}`,
                      `  总耗时: ${mResult.totalElapsed || mResult.totalElapsed}ms`,
                      topResults.length > 0
                        ? topResults.map((r, i) => {
                            const tag = r._tag || '📄';
                            const name = r.file || r.summary || r.id || `结果${i + 1}`;
                            const extra = r.matchCount ? ` (${r.matchCount}处)` : '';
                            return `  ${tag} ${name.substring(0, 100)}${extra}`;
                          }).join('\n')
                        : '  无匹配结果',
                    ].join('\n');

                    result = {
                      content: [{ type: 'text', text: summaryText.substring(0, 1000) }],
                      status: 'success',
                      action: 'multi_search',
                      query,
                      pathStats: mResult.pathStats,
                      totalElapsed: mResult.totalElapsed,
                      results: topResults,
                      note: `五路搜索完成: ${topResults.length} 条结果, 总时长 ${mResult.totalElapsed}ms`,
                    };
                  } catch (e) {
                    return { jsonrpc: '2.0', id, error: { code: -32603, message: `多路径搜索失败: ${e.message}` } };
                  }
                  break;
                }
                default:
                  throw Object.assign(new Error(`Unknown action: ${reasonAction} (optional: search_dialog/semantic_search/memory_query/lcm_recall/multi_search)`), { code: -32602 });
              }
              break;
            }
            // old webSearch skeleton removed, v2 Tavily handler used instead
            
            
            
            // ====== Subagent dispatch ======
            
            // v5.37.0: worker池版已清理


            
            default:
              throw Object.assign(new Error(`Unknown工具: ${toolName}`), { code: -32601 });
          }


          // ====== ⑨⑩⑪ 执行后回调链（失败不打断工具执行结果）======
          if (toolName && !HEARTBEAT_TOOLS.has(toolName)) {
            const _duration = Date.now() - (_execStartTime || Date.now());

            // ⑨ 熔断器：记录成功（按session隔离）
            try { recordToolSuccess(toolName, sessionId); } catch (e) {
              console.warn('[sc MCP] ⚠️ circuit breaker record failed:', e.message);
            }



            // ⑫ 海马体工具调用记录（全量记录，含心跳类）
            try {
              hippoRecordEvent({
                toolName,
                params: args,
                result,
                duration: _duration,
                status: 'success',
                sessionId: sessionId || '',
              }).catch(err => console.warn('[海马体] ⚠️ 异步记录失败:', err?.message || err));
            } catch (e) {
              console.warn('[sc MCP] ⚠️ hippocampus record failed:', e.message);
            }
          }

          return {
            jsonrpc: '2.0', id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            },
          };
        } catch (err) {

          // ====== ⑨⑩ 执行失败后回调链（失败不打断错误返回）======
          if (toolName && !HEARTBEAT_TOOLS.has(toolName)) {
            const _duration = Date.now() - (_execStartTime || Date.now());

            // ⑨ 熔断器：记录失败（按session隔离）
            try { recordToolFailure(toolName, err?.message || '', sessionId); } catch (e) {
              console.warn('[sc MCP] ⚠️ circuit breaker record failed:', e.message);
            }



            // ⑪ 海马体工具调用记录（失败路径）
            try {
              hippoRecordEvent({
                toolName,
                params: args,
                result: { error: err?.message || '' },
                duration: _duration,
                status: 'error',
                sessionId: sessionId || '',
              }).catch(e => console.warn('[海马体] ⚠️ 异步记录失败:', e?.message || e));
            } catch (e) {
              console.warn('[sc MCP] ⚠️ hippocampus record failed:', e.message);
            }
          }

          return {
            jsonrpc: '2.0', id,
            error: { code: err.code || -32603, message: err.message || 'Internal error' },
          };
        }
      }

      case 'notifications/initialized': {
        return null;
      }

      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
  }

  // ====== 向指定 SSE session 发送消息（串行化写操作，防并发交错）======
  function sendToSession(sessionId, data) {
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    if (sessionId && sseClients.has(sessionId)) {
      safeSseWrite(sessionId, msg);
    } else {
      for (const [id] of sseClients) {
        safeSseWrite(id, msg);
      }
    }
  }

  async function pollScInboxForNotifications() {
    if (!sseClients || sseClients.size === 0) return;
    try {
      const deliveryMode = getScInboxDeliveryMode();
      scInboxState.deliveryMode = deliveryMode;
      scInboxState.notifyAck = shouldAckScInboxNotify(deliveryMode);
      const limit = Number(process.env.SC_INBOX_NOTIFY_LIMIT || 20);
      const pending = await sidecarJson(`/inbox/pending?limit=${encodeURIComponent(limit)}&undeliveredOnly=true`);
      const events = pending.events || [];
      if (!events.length) return;
      const eventIds = events.map(e => e.id);
      scInboxState.lastEventCount = events.length;
      const report = compactScInboxReport(events);
      sendToSession(null, {
        jsonrpc: '2.0',
        method: 'notifications/message',
        params: {
          level: 'info',
          logger: 'sc.inbox',
          data: {
            type: 'sc.completion.batch',
            text: report.text,
            eventIds,
            events,
            stats: pending.stats,
          },
        },
      });
      await sidecarJson('/inbox/delivered', {
        method: 'POST',
        body: JSON.stringify({ eventIds, deliveredBy: 'bridge-sse-notification' }),
      });
      scInboxState.lastNotifyOkAt = new Date().toISOString();
      if (shouldAckScInboxNotify(deliveryMode)) {
        await sidecarJson('/inbox/ack', {
          method: 'POST',
          body: JSON.stringify({ eventIds, ackedBy: 'bridge-sse-notification' }),
        });
        scInboxState.lastAckAt = scInboxState.lastNotifyOkAt;
      }
      scInboxState.lastNonOk = null;
      scInboxState.lastError = null;
    } catch (e) {
      scInboxState.lastError = String(e?.stack || e?.message || e).slice(0, 2000);
      // Keep polling best-effort; scInbox tool can still drain pending events.
    }
  }

  async function pollScInboxForChatInject() {
    const deliveryMode = getScInboxDeliveryMode();
    scInboxState.deliveryMode = deliveryMode;
    if (!shouldInjectScInboxChat(deliveryMode)) return;
    try {
      const limit = Math.min(Math.max(Number(process.env.SC_INBOX_CHAT_INJECT_LIMIT || 10), 1), 20);
      const pending = await sidecarJson(`/inbox/pending?limit=${encodeURIComponent(limit)}`);
      const events = pending.events || [];
      if (!events.length) return;
      scInboxState.lastChatInjectAttemptAt = new Date().toISOString();
      scInboxState.lastEventCount = events.length;
      const report = compactScInboxReport(events);
      const injected = await injectOpenClawChatMessage({
        sessionKey: process.env.SC_INBOX_CHAT_INJECT_SESSION || 'agent:main:main',
        label: process.env.SC_INBOX_CHAT_INJECT_LABEL || 'SC子Agent完成',
        message: clampText(report.text, Number(process.env.SC_INBOX_CHAT_INJECT_MAX_CHARS || 2500)),
      });
      if (!injected?.ok) {
        scInboxState.lastNonOk = JSON.stringify(injected).slice(0, 1000);
        console.warn('[sc inbox] chat.inject returned non-ok:', JSON.stringify(injected).slice(0, 1000));
        return;
      }
      await sidecarJson('/inbox/ack', {
        method: 'POST',
        body: JSON.stringify({ eventIds: events.map(e => e.id), ackedBy: 'bridge-chat-inject' }),
      });
      scInboxState.lastChatInjectOkAt = new Date().toISOString();
      scInboxState.lastAckAt = scInboxState.lastChatInjectOkAt;
      scInboxState.lastNonOk = null;
      scInboxState.lastError = null;
    } catch (e) {
      scInboxState.lastError = String(e?.stack || e?.message || e).slice(0, 2000);
      console.warn('[sc inbox] chat.inject consumer failed:', e?.stack || e?.message || e);
      // Keep polling best-effort; unacked events remain in the sidecar inbox.
    }
  }

  async function pollScInbox() {
    if (scInboxPollRunning) return;
    scInboxPollRunning = true;
    try {
      scInboxState.lastPollAt = new Date().toISOString();
      if (process.env.SC_INBOX_AUTO_NOTIFY !== '0') {
        await pollScInboxForNotifications();
      }
      await pollScInboxForChatInject();
    } finally {
      scInboxPollRunning = false;
    }
  }

  const scInboxDeliveryMode = getScInboxDeliveryMode();
  const scInboxAutoNotify = process.env.SC_INBOX_AUTO_NOTIFY !== '0' && scInboxDeliveryMode !== 'off';
  const scInboxChatInject = shouldInjectScInboxChat(scInboxDeliveryMode);
  if (scInboxAutoNotify || scInboxChatInject) {
    const pollMs = Math.max(Number(process.env.SC_INBOX_POLL_MS || 5000), 1000);
    scInboxState.enabled = true;
    scInboxState.autoNotify = scInboxAutoNotify;
    scInboxState.notifyAck = shouldAckScInboxNotify(scInboxDeliveryMode);
    scInboxState.chatInject = scInboxChatInject;
    scInboxState.deliveryMode = scInboxDeliveryMode;
    scInboxState.pollMs = pollMs;
    scInboxTimer = setInterval(pollScInbox, pollMs);
    if (typeof scInboxTimer.unref === 'function') scInboxTimer.unref();
    console.log('[sc inbox] consumer enabled:', JSON.stringify({
      pollMs,
      autoNotify: scInboxState.autoNotify,
      notifyAck: scInboxState.notifyAck,
      chatInject: scInboxState.chatInject,
      deliveryMode: scInboxState.deliveryMode,
      chatInjectSession: process.env.SC_INBOX_CHAT_INJECT_SESSION || 'agent:main:main',
    }));
  }
// ====== HTTP Server ======
  server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // ====== 未匹配路由返回404，避免Gateway bundle-mcp超时报错 ======
    const knownMethods = ['GET', 'POST'];
    const knownPaths = ['/sse', '/messages', '/health', '/notify-done'];
    if (!knownMethods.includes(req.method) || !knownPaths.includes(url.pathname)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unknown path. known: GET /sse, POST /messages, GET /health, POST /notify-done' }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/sse') {
      const sessionId = generateSessionId();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);
      sseClients.set(sessionId, res);
      req.on('close', () => sseClients.delete(sessionId));
      const hbTimer = setInterval(() => {
        try { res.write(':ping\n\n'); } catch { clearInterval(hbTimer); }
      }, 30000);
      req.on('close', () => clearInterval(hbTimer));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/messages') {
      const sessionId = url.searchParams.get('sessionId');
      let body = '';
      let bodySize = 0;
      const MAX_BODY_SIZE = 1024 * 1024;
      req.on('data', chunk => {
        bodySize += chunk.length;
        if (bodySize > MAX_BODY_SIZE) {
          req.destroy();
          if (!res.headersSent) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Request body too large (max 1MB)' }));
          }
        }
        body += chunk;
      });
      req.on('end', async () => {
        // ====== MCP 并发槽位获取（防 >5 并发撑爆 Worker 池）======
        const hasSlot = await acquireMcpSlot();
        if (!hasSlot) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'MCP 请求队列满（超过 ' + MCP_MAX_CONCURRENT + ' 个并发），请稍后重试' }));
          return;
        }
        try {
          const parsed = JSON.parse(body);
          
          // ====== Worker 池背压检测：队列太深时阻止新任务入池 ======
          try {
            const core = await getCore();
            const stats = typeof cpu.getStats === 'function' ? core.getStats() : {};
            const queueDepth = stats.queueDepth || 0;
            const busyWorkers = stats.busy || 0;
            const totalWorkers = stats.total || 1;
            const utilRate = totalWorkers > 0 ? busyWorkers / totalWorkers : 0;
            
            // 背压策略：队列深>10 且 利用率>80% → 返回 429 让客户端重试
            if (queueDepth > 10 && utilRate > 0.8) {
              releaseMcpSlot();
              const errRpc = { jsonrpc: '2.0', id: body?.id || null, error: { code: -32000, message: 'Worker 池过载（队列' + queueDepth + '个/利用率' + Math.round(utilRate*100) + '%），请稍后重试' } };
              sendToSession(sessionId, errRpc);
              res.writeHead(429, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'too many requests', retryAfter: 5 }));
              return;
            }
          } catch {}
          
          const response = await handleJsonRpc(parsed, sessionId);
          if (response) {
            sendToSession(sessionId, response);
          }
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ accepted: true }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        } finally {
          releaseMcpSlot();
        }
      });

          return;
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health' || url.pathname === '/api/stats')) {
      const core = await getCore();
      // 🐛 FIX: 直接调 pool.getStats() 绕过缓存，确保仪表盘每次刷新都拿到最新数据
      const stats = (core.pool && typeof core.pool.getStats === 'function')
        ? core.pool.getStats()
        : core.getStats();

      // 内存数据
      const freeGB = freemem() / 1024 / 1024 / 1024;
      const totalGB = totalmem() / 1024 / 1024 / 1024;
      const usedPct = totalGB > 0 ? Math.round((1 - freeGB / totalGB) * 100) : 0;
      let level = 'green';
      let label = '充足';
      if (freeGB < 2) { level = 'meltdown'; label = '熔断'; }
      else if (freeGB < 4) { level = 'red'; label = '告警'; }
      else if (freeGB < 8) { level = 'yellow'; label = '紧张'; }

      // 用户活跃度：检查对话日记最后修改时间
      const homedirPath = homedir();
      const dialogDir = join(homedirPath, '.openclaw', 'workspace', 'memory', 'dialog');
      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const dd = String(today.getDate()).padStart(2, '0');
      const dialogPath = join(dialogDir, `${yyyy}-${mm}-${dd}.md`);
      let userActive = true;
      try {
        if (existsSync(dialogPath)) {
          const mtime = statSync(dialogPath).mtimeMs;
          const elapsed = Date.now() - mtime;
          userActive = elapsed < 20 * 60 * 1000; // 20分钟
        } else {
          userActive = false;
        }
      } catch { /* 保守返回活跃 */ }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        version: '5.37.0',
        pool: stats,
        memory: {
          freeGB: Math.round(freeGB * 100) / 100,
          usedPct,
          totalGB: Math.round(totalGB * 100) / 100,
          level,
          label,
        },
        userActive,
        inboxConsumer: scInboxState,
      }));
      return;
    }

    // ====== B方案: 子agent完成回调通知端点 ======
    if (req.method === 'POST' && url.pathname === '/notify-done') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { taskId, status } = JSON.parse(body);
          const notifyDir = join(homedir(), '.openclaw', 'workspace', 'memory', 'dialog', 'subagent');
          const notifyFile = join(notifyDir, `NOTIFY_${taskId}_${status}.json`);
          if (!existsSync(notifyDir)) mkdirSync(notifyDir, { recursive: true });
          writeFileSync(notifyFile, JSON.stringify({ taskId, status, receivedAt: new Date().toISOString() }));
        } catch (e) { /* 静默 */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }

    // ====== 主脑暂停/恢复 REST 端点（供仪表盘调用）======
    if (req.method === 'GET' && url.pathname === '/pause') {
      try {
        const coreMod = await getCore();
        if (typeof coreMod.setMainBrainPaused === 'function') coreMod.setMainBrainPaused(true);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', paused: true, message: '主脑已暂停' }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: e.message }));
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/resume') {
      try {
        const coreMod = await getCore();
        if (typeof coreMod.setMainBrainPaused === 'function') coreMod.setMainBrainPaused(false);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', paused: false, message: '主脑已恢复' }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: e.message }));
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/pause-status') {
      try {
        const coreMod = await getCore();
        const paused = typeof coreMod.isMainBrainPaused === 'function' ? coreMod.isMainBrainPaused() : false;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', paused, message: paused ? '主脑暂停中' : '主脑正常运行' }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: e.message }));
      }
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[sc MCP] 端口 ${port} 已被占用，跳过 MCP Server 启动`);
      // 触发 listenReject，让调用方知道启动失败
      if (listenReject) listenReject(err);
      return;
    }
    console.error(`[sc MCP] Server 错误:`, err.message);
    if (listenReject) listenReject(err);
  });

  // 将 server.listen 包装为 Promise，确保调用方能捕获 EADDRINUSE
  let listenResolve, listenReject;
  const listenPromise = new Promise((resolve, reject) => {
    listenResolve = resolve;
    listenReject = reject;
  });

  server.listen(port, '127.0.0.1', () => {
    // TODO: 移除调试日志 console.log(`[sc MCP] ✅ Server 启动: http://127.0.0.1:${port}/sse`);
    // TODO: 移除调试日志 console.log(`[sc MCP]     Health: http://127.0.0.1:${port}/health`);
    // TODO: 移除调试日志 console.log(`[sc MCP]     Tools:  ${tools.map(t => t.name).join(', ')}`);
    listenResolve();
  });

  // 等待 listen 确认，若 EADDRINUSE 则 reject
  await listenPromise;

  return { server, shutdown, port };
  } catch (err) {
    // EADDRINUSE 已在 server.on('error') 打过消息，这里不重复
    if (err?.code !== 'EADDRINUSE') {
      console.error(`[sc MCP] Server 启动失败:`, err.message);
    }
    shutdown();
    throw err;
  }
}

// ====== 导出供插件 import ======
export {
  startMcpServer,
  normalizeScTaskEnvelope,
  scGuardJsonRpcError,
  validateScPipelineTask,
  validateScSpawnTask,
};

export async function search(keyword, files, priority) {
  // 🚀 L0 快车路径（共享模块）
  const fastResult = await fastPathSearch(keyword, files, validatePath);
  if (fastResult) return fastResult;
  const core = await getCore();
  const poolStats = core.getStats();
  const tasks = splitFiles(files, poolStats.maxWorkers || 4);
  const results = await Promise.all(
    tasks.map(fc => core.pool.exec({ type: 'search-text', keyword, files: fc }, priority))
  );
  return mergeSearchResults(results, poolStats);
}

export async function processLog(files, priority) {
  const core = await getCore();
  const poolStats = core.getStats();
  const tasks = splitFiles(files, poolStats.maxWorkers || 4);
  const results = await Promise.all(
    tasks.map(fc => core.pool.exec({ type: 'process-log', files: fc }, priority))
  );
  return mergeLogResults(results, poolStats);
}

export const getStats = async () => (await getCore()).getStats();
export const resolveModel = async (provider, modelId) => (await getCore()).pool.exec({ type: 'resolve-model', provider, modelId });

function handleJsonTool({ action, input, indent }) {
  const _indent = indent !== undefined ? indent : 2;
  const validActions = ['format', 'validate', 'convert', 'csv2json', 'json2csv'];
  if (!validActions.includes(action)) {
    throw new Error(`不支持的 action: ${action}，支持: ${validActions.join(', ')}`);
  }
  if (input === undefined || input === null) {
    throw new Error('Missing input');
  }
  switch (action) {
    case 'format': {
      const parsed = JSON.parse(input);
      return {
        status: 'success',
        action: 'format',
        output: JSON.stringify(parsed, null, _indent),
        size: { chars: JSON.stringify(parsed, null, _indent).length },
      };
    }
    case 'validate': {
      try {
        const parsed = JSON.parse(input);
        return {
          status: 'success',
          action: 'validate',
          valid: true,
          type: Array.isArray(parsed) ? 'array' : typeof parsed,
          keys: typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? Object.keys(parsed) : undefined,
          size: { chars: input.length, items: Array.isArray(parsed) ? parsed.length : undefined },
        };
      } catch (e) {
        return {
          status: 'success',
          action: 'validate',
          valid: false,
          error: e.message,
        };
      }
    }
    case 'convert': {
      const parsed = JSON.parse(input);
      return {
        status: 'success',
        action: 'convert',
        output: JSON.stringify(parsed, null, _indent),
        note: 'JSON 已重新序列化（压缩/规范化）',
      };
    }
    case 'csv2json': {
      const lines = input.split(/\r?\n/).filter(l => l.trim());
      if (lines.length < 2) {
        throw new Error('CSV 至少需要表头行+1行数据');
      }
      const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
      const jsonArray = [];
      for (let i = 1; i < lines.length; i++) {
        const values = [];
        let current = '';
        let inQuotes = false;
        for (const ch of lines[i]) {
          if (ch === '"') { inQuotes = !inQuotes; continue; }
          if (ch === ',' && !inQuotes) { values.push(current.trim()); current = ''; continue; }
          current += ch;
        }
        values.push(current.trim());
        const row = {};
        for (let j = 0; j < headers.length; j++) {
          const val = values[j] || '';
          const num = Number(val);
          row[headers[j]] = (!isNaN(num) && val.trim() !== '') ? num : val;
        }
        jsonArray.push(row);
      }
      return {
        status: 'success',
        action: 'csv2json',
        rows: jsonArray.length,
        columns: headers,
        output: JSON.stringify(jsonArray, null, _indent),
      };
    }
    case 'json2csv': {
      const parsed = JSON.parse(input);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error('input 应为非空 JSON 数组');
      }
      const headers = [...new Set(parsed.flatMap(obj => Object.keys(obj || {})))];
      let csv = headers.join(',') + '\n';
      for (const row of parsed) {
        const values = headers.map(h => {
          const val = row[h];
          if (val === null || val === undefined) return '';
          const str = String(val);
          return str.includes(',') || str.includes('"') || str.includes('\n')
            ? '"' + str.replace(/"/g, '""') + '"'
            : str;
        });
        csv += values.join(',') + '\n';
      }
      return {
        status: 'success',
        action: 'json2csv',
        rows: parsed.length,
        columns: headers,
        output: csv,
      };
    }
  }
}

export default { startMcpServer, search, processLog, getStats, resolveModel, validateScSpawnTask, validateScPipelineTask };

// ====== CLI entry（直接运行时）=====
const isMain = process.argv[1] && (
  fileURLToPath(import.meta.url) === process.argv[1] ||
  fileURLToPath(import.meta.url).replace(/\\/g, '/') === process.argv[1].replace(/\\/g, '/')
);

if (isMain) {
  main().catch(err => {
    console.error('[sc Bridge] 致命错误:', err.message);
    process.exit(1);
  });
}













async function sidecarJson(pathname, options = {}) {
  const resp = await fetch(`http://127.0.0.1:18792${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await resp.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!resp.ok) {
    throw new Error(data.error || `sidecar HTTP ${resp.status}`);
  }
  return data;
}

function clampText(value, maxChars = 2500) {
  const text = String(value || '');
  const max = Math.max(Number(maxChars) || 2500, 200);
  if (text.length <= max) return text;
  return `${text.slice(0, max - 32)}\n\n[truncated by SC bridge]`;
}

function cleanScInboxSummary(event = {}) {
  const raw = String(event.summary || event.error || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const breaker = raw.match(/工具调用失败次数过多\([^)]*\),?熔断终止。?([^]*?)(?:\s+node:internal|\s+DOMException|\s+Node\.js\b|$)/);
  if (breaker) return clampText(`工具调用失败次数过多，已熔断终止。${breaker[1].trim()}`, 500);
  if (/The operation was aborted due to timeout/i.test(raw)) {
    const toolMatch = raw.match(/工具=([^,\s]+).*?action=([^,\s]+).*?最后错误=The operation was aborted due to timeout/);
    if (toolMatch) return `工具调用超时，已失败。工具=${toolMatch[1]}，action=${toolMatch[2]}，最后错误=timeout。`;
    return '工具调用超时，子 Agent 已失败；可缩小任务范围或更换检索方式重试。';
  }
  const withoutStack = raw
    .replace(/\[subagent\]\s*(?:创建新MCP session|session复用|调工具)[^[]*/g, '')
    .replace(/\[HB\][^[]*/g, '')
    .replace(/\s*node:internal\/process\/promises:[\s\S]*$/i, '')
    .replace(/\s*DOMException \[TimeoutError\]:[\s\S]*$/i, '')
    .replace(/\s*Node\.js v[\d.]+.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clampText(withoutStack || raw, 500);
}

let openClawGatewayRuntimePromise = null;

function openClawGatewayRuntimeCandidates() {
  const candidates = [];
  if (process.env.OPENCLAW_GATEWAY_RUNTIME_MODULE) {
    candidates.push(process.env.OPENCLAW_GATEWAY_RUNTIME_MODULE);
  }
  if (process.env.APPDATA) {
    candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', 'openclaw', 'dist', 'plugin-sdk', 'gateway-runtime.js'));
  }
  candidates.push(join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', 'openclaw', 'dist', 'plugin-sdk', 'gateway-runtime.js'));
  candidates.push('openclaw/dist/plugin-sdk/gateway-runtime.js');
  return [...new Set(candidates.filter(Boolean))];
}

function toImportSpecifier(candidate) {
  if (/^[a-z]+:\/\//i.test(candidate)) return candidate;
  if (/^[a-zA-Z]:[\\/]/.test(candidate) || candidate.startsWith('/') || candidate.startsWith('\\\\')) {
    return pathToFileURL(candidate).href;
  }
  return candidate;
}

async function loadOpenClawGatewayRuntime() {
  if (openClawGatewayRuntimePromise) return openClawGatewayRuntimePromise;
  openClawGatewayRuntimePromise = (async () => {
    const errors = [];
    for (const candidate of openClawGatewayRuntimeCandidates()) {
      try {
        if ((/^[a-zA-Z]:[\\/]/.test(candidate) || candidate.startsWith('/') || candidate.startsWith('\\\\')) && !existsSync(candidate)) {
          continue;
        }
        const mod = await import(toImportSpecifier(candidate));
        if (typeof mod.callGatewayFromCli === 'function') return mod;
      } catch (e) {
        errors.push(`${candidate}: ${e.message}`);
      }
    }
    throw new Error(`OpenClaw gateway runtime unavailable: ${errors.join('; ')}`);
  })();
  return openClawGatewayRuntimePromise;
}

async function injectOpenClawChatMessage({ sessionKey, label, message }) {
  const runtime = await loadOpenClawGatewayRuntime();
  return await runtime.callGatewayFromCli('chat.inject', {
    timeout: String(process.env.SC_INBOX_CHAT_INJECT_TIMEOUT_MS || 20000),
    json: true,
  }, {
    sessionKey,
    message,
    label,
  }, { expectFinal: false });
}

function compactScInboxReport(events = []) {
  if (!events.length) {
    return {
      text: 'SC inbox 暂无未确认完成事件。',
      total: 0,
      byStatus: {},
      events: [],
    };
  }
  const byStatus = {};
  for (const event of events) {
    byStatus[event.status] = (byStatus[event.status] || 0) + 1;
  }
  const lines = [
    `SC 子Agent完成事件 ${events.length} 条：` +
      Object.entries(byStatus).map(([status, count]) => `${status}=${count}`).join(', '),
  ];
  for (const event of events.slice(0, 20)) {
    const label = event.taskName || event.groupName || event.taskId;
    const artifact = event.artifactPath ? ` artifact=${event.artifactPath}` : '';
    const summary = cleanScInboxSummary(event);
    lines.push(`- ${event.status} ${label} (${event.taskId}) ${summary}${artifact}`.slice(0, 700));
  }
  return {
    text: lines.join('\n'),
    total: events.length,
    byStatus,
    events,
  };
}

async function scInbox(args = {}) {
  const action = args.action || 'pending';
  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 200);
  const includeAcked = args.includeAcked === true || action === 'recent';

  if (action === 'stats') {
    return await sidecarJson('/inbox/stats');
  }

  if (action === 'pending') {
    const pending = await sidecarJson(`/inbox/pending?limit=${encodeURIComponent(limit)}${includeAcked ? '&includeAcked=true' : ''}`);
    if (!includeAcked && !pending.events?.length && pending.stats?.acked > 0) {
      const recent = await sidecarJson(`/inbox/pending?limit=${encodeURIComponent(Math.min(limit, 5))}&includeAcked=true`);
      return {
        ...pending,
        note: 'pending 只返回未 ack 事件；chat-inject 成功后事件会被 ack。recentAcked 仅用于判断最近是否已送达 inbox。',
        recentAcked: (recent.events || []).map(event => ({ ...event, summary: cleanScInboxSummary(event) })),
      };
    }
    return pending;
  }

  if (action === 'report' || action === 'recent') {
    const pending = await sidecarJson(`/inbox/pending?limit=${encodeURIComponent(limit)}${includeAcked ? '&includeAcked=true' : ''}`);
    const report = compactScInboxReport(pending.events || []);
    if (args.ack === true && pending.events?.length) {
      const acked = await sidecarJson('/inbox/ack', {
        method: 'POST',
        body: JSON.stringify({ eventIds: pending.events.map(e => e.id), ackedBy: 'scInbox.report' }),
      });
      return { ...report, acked };
    }
    return { ...report, stats: pending.stats };
  }

  if (action === 'ack') {
    return await sidecarJson('/inbox/ack', {
      method: 'POST',
      body: JSON.stringify({
        eventIds: args.eventIds || [],
        taskIds: args.taskIds || [],
        all: args.all === true,
        ackedBy: 'scInbox.ack',
      }),
    });
  }

  throw new Error(`unknown scInbox action: ${action}`);
}

function normalizeScGuardMode(mode) {
  return mode === 'strict' ? 'strict' : 'warn';
}

function scGuardError(status, missingFields = [], details = {}) {
  return {
    ok: false,
    status,
    code: -32602,
    message: 'Invalid params: ClarificationNeeded',
    missingFields,
    budgetExceeded: status === 'budget_exceeded',
    rawOutputPolicy: details.rawOutputPolicy || details.raw_output_policy || 'no_full_dump',
    details,
  };
}

function scGuardJsonRpcError(id, guard) {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: guard.code || -32602,
      message: guard.message || 'Invalid params: ClarificationNeeded',
      data: {
        status: guard.status,
        missingFields: guard.missingFields || [],
        budgetExceeded: guard.budgetExceeded === true,
        rawOutputPolicy: guard.rawOutputPolicy || 'no_full_dump',
        details: guard.details || {},
      },
    },
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function scTaskCardRequiredMissing(args = {}) {
  const missing = [];
  if (!isPlainObject(args.budgets) && !isPlainObject(args.taskCard?.budgets)) missing.push('budgets');
  const rawPolicy = args.raw_output_policy || args.rawOutputPolicy || args.budgets?.raw_output_policy || args.taskCard?.raw_output_policy || args.taskCard?.budgets?.raw_output_policy;
  if (rawPolicy !== 'no_full_dump') missing.push('raw_output_policy');
  if (!isPlainObject(args.evidence) && !isPlainObject(args.taskCard?.evidence)) missing.push('evidence');
  return missing;
}

function normalizeScTaskEnvelope(args = {}, prompt = '') {
  const budgets = isPlainObject(args.budgets) ? args.budgets : (isPlainObject(args.taskCard?.budgets) ? args.taskCard.budgets : {});
  const rawOutputPolicy = args.raw_output_policy || args.rawOutputPolicy || budgets.raw_output_policy || args.taskCard?.raw_output_policy || 'no_full_dump';
  const toolPolicy = args.toolPolicy || args.tool_policy || args.taskCard?.toolPolicy || args.taskCard?.tool_policy || null;
  return {
    taskCard: isPlainObject(args.taskCard) ? args.taskCard : null,
    runId: args.runId || args.taskCard?.runId || args.batchName || '',
    runDir: args.runDir || args.taskCard?.runDir || '',
    collector: isPlainObject(args.collector) ? args.collector : (isPlainObject(args.taskCard?.collector) ? args.taskCard.collector : null),
    budgets: {
      max_tool_output_chars: Number(budgets.max_tool_output_chars || budgets.maxToolOutputChars || 8000),
      max_total_tool_output_chars: Number(budgets.max_total_tool_output_chars || budgets.maxTotalToolOutputChars || 30000),
      raw_output_policy: rawOutputPolicy,
    },
    acceptance: isPlainObject(args.acceptance) ? args.acceptance : (isPlainObject(args.taskCard?.acceptance) ? args.taskCard.acceptance : null),
    evidence: isPlainObject(args.evidence) ? args.evidence : (isPlainObject(args.taskCard?.evidence) ? args.taskCard.evidence : null),
    toolPolicy,
    notifyPolicy: args.notifyPolicy || args.taskCard?.notifyPolicy || 'notify-only',
    promptChars: String(prompt || '').length,
  };
}

function validateScSpawnTask(args = {}, modeOrName = 'spawnAgent', maybeOptions = {}) {
  const options = typeof modeOrName === 'object' ? modeOrName : maybeOptions;
  const mode = normalizeScGuardMode(options.mode || SC_TASKCARD_GUARD_MODE);
  const prompt = args.prompt;
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    return scGuardError('ClarificationNeeded', ['prompt'], { mode, tool: 'spawnAgent' });
  }
  if (prompt.length > SC_PROMPT_MAX_CHARS) {
    return scGuardError('budget_exceeded', ['prompt'], { mode, tool: 'spawnAgent', promptChars: prompt.length, maxPromptChars: SC_PROMPT_MAX_CHARS });
  }
  const missing = scTaskCardRequiredMissing(args);
  const envelope = normalizeScTaskEnvelope(args, prompt);
  if (mode === 'strict' && missing.length > 0) {
    return scGuardError('ClarificationNeeded', missing, { mode, tool: 'spawnAgent', envelope });
  }
  return {
    ok: true,
    mode,
    guardWarnings: missing.map(field => `missing_${field}`),
    envelope,
  };
}

function validateScPipelineTask(args = {}, options = {}) {
  const mode = normalizeScGuardMode(options.mode || SC_TASKCARD_GUARD_MODE);
  const groups = args.groups;
  if (!Array.isArray(groups) || groups.length === 0) {
    return scGuardError('ClarificationNeeded', ['groups'], { mode, tool: 'taskPipeline' });
  }
  if (groups.length > SC_PIPELINE_MAX_GROUPS) {
    return scGuardError('budget_exceeded', ['groups'], { mode, tool: 'taskPipeline', groupCount: groups.length, maxGroups: SC_PIPELINE_MAX_GROUPS });
  }
  const invalidIdx = groups.findIndex(g => !g || typeof g.prompt !== 'string' || g.prompt.trim() === '');
  if (invalidIdx >= 0) {
    return scGuardError('ClarificationNeeded', [`groups[${invalidIdx}].prompt`], { mode, tool: 'taskPipeline' });
  }
  const overIdx = groups.findIndex(g => String(g.prompt || '').length > SC_PROMPT_MAX_CHARS);
  if (overIdx >= 0) {
    return scGuardError('budget_exceeded', [`groups[${overIdx}].prompt`], { mode, tool: 'taskPipeline', promptChars: String(groups[overIdx].prompt || '').length, maxPromptChars: SC_PROMPT_MAX_CHARS });
  }
  const missing = scTaskCardRequiredMissing(args);
  const envelope = normalizeScTaskEnvelope(args, groups.map(g => g.prompt).join('\n'));
  const fireAndReturn = Number(args.staggerMs || 0) > 0 || (args.maxWait != null && Number(args.maxWait) <= 500);
  const needsStrictFields = groups.length > 1 || fireAndReturn || mode === 'strict';
  if (mode === 'strict' && needsStrictFields && missing.length > 0) {
    return scGuardError('ClarificationNeeded', missing, { mode, tool: 'taskPipeline', groupCount: groups.length, fireAndReturn, envelope });
  }
  return {
    ok: true,
    mode,
    guardWarnings: missing.map(field => `missing_${field}`),
    envelope,
    groupCount: groups.length,
    fireAndReturn,
  };
}

function attachScGuardFields(payload, args = {}, guard) {
  const envelope = guard?.envelope || normalizeScTaskEnvelope(args, args.prompt || '');
  return {
    ...payload,
    taskCard: envelope.taskCard,
    runId: envelope.runId,
    runDir: envelope.runDir,
    collector: envelope.collector,
    budgets: envelope.budgets,
    acceptance: envelope.acceptance,
    evidence: envelope.evidence,
    toolPolicy: envelope.toolPolicy,
    notifyPolicy: envelope.notifyPolicy,
    raw_output_policy: envelope.budgets?.raw_output_policy || 'no_full_dump',
    guardMode: guard?.mode || normalizeScGuardMode(),
    guardWarnings: guard?.guardWarnings || [],
  };
}

async function spawnAgent(args) {
  const guard = args.__scGuard || validateScSpawnTask(args, 'spawnAgent', { mode: SC_TASKCARD_GUARD_MODE });
  if (!guard.ok) throw Object.assign(new Error(guard.message || 'Invalid params: ClarificationNeeded'), { scGuard: guard });
  const resp = await fetch('http://127.0.0.1:18792/spawn_subagent', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify(attachScGuardFields({
      prompt: args.prompt || '',
      model: args.model || 'deepseek/deepseek-v4-flash',
      timeout: args.timeout || 600,
      maxRounds: args.maxRounds || 100,
      taskName: args.taskName || args.name || 'spawnAgent',
      batchName: args.batchName || '',
      groupName: args.groupName || ''
    }, args, guard))
  });
  return await resp.json();
}

async function spawnTaskPipeline(args) {
  const guard = args.__scGuard || validateScPipelineTask(args, { mode: SC_TASKCARD_GUARD_MODE });
  if (!guard.ok) throw Object.assign(new Error(guard.message || 'Invalid params: ClarificationNeeded'), { scGuard: guard });
  const groups = args.groups || [];
  const maxWait = args.maxWait != null ? args.maxWait : 0;
  // 🔒 防呆：groups > 10 时自动 stagger，不传参数也安全
  const isLargeBatch = groups.length > 10;
  const staggerMs = args.staggerMs != null ? args.staggerMs : (isLargeBatch ? 20 : 0);
  const staggerBatchSize = args.staggerBatchSize || (isLargeBatch ? 10 : groups.length);
  const checkInterval = 3000;
  const doneFlagDir = join(homedir(), '.openclaw', 'workspace', 'memory', 'dialog', 'subagent');

  // 1. 派兵（支持 stagger）
  const tasks = [];
  const dispatchNext = (idx) => {
    if (idx >= groups.length) return Promise.resolve();
    const batch = [];
    for (let j = 0; j < staggerBatchSize && idx + j < groups.length; j++) {
      batch.push(groups[idx + j]);
    }
    const nextIdx = idx + batch.length;

    return Promise.all(batch.map((g, batchOffset) => {
      const groupArgs = { ...args, ...g, prompt: g.prompt };
      const groupGuard = {
        ...guard,
        envelope: normalizeScTaskEnvelope(groupArgs, g.prompt || ''),
      };
      return fetch('http://127.0.0.1:18792/spawn_subagent', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify(attachScGuardFields({
          prompt: g.prompt || '',
          model: g.model || 'deepseek/deepseek-v4-flash',
          timeout: g.timeout || 600,
          maxRounds: g.maxRounds || 100,
          taskName: g.taskName || g.name || `group-${idx + batchOffset + 1}`,
          batchName: args.batchName || '',
          groupName: g.name || ''
        }, groupArgs, groupGuard))
      }).then(r => r.json()).then(data => {
        tasks.push({ id: data.id, name: g.name, status: 'running' });
      }).catch(() => {
        tasks.push({ id: 'failed-' + g.name, name: g.name, status: 'failed' });
      });
    })).then(() => {
      if (nextIdx < groups.length) {
        return new Promise(r => setTimeout(r, staggerMs)).then(() => dispatchNext(nextIdx));
      }
    });
  };

  await dispatchNext(0);

  // 2. 如果设了stagger或极短maxWait，跳过轮询直接返回
  if (staggerMs > 0 || (maxWait > 0 && maxWait <= 500)) {
    return { batch: args.batchName, total: tasks.length, completed: 0, running: tasks.length, tasks, note: '派兵完成，兵在后台跑。用ai_collector收尾' };
  }

  // 3. 轮询等待完成（传统模式）
  const startTime = Date.now();
  while (true) {
    let allDone = true;
    for (const t of tasks) {
      if (t.status === 'running') {
        if (existsSync(join(doneFlagDir, `DONE_${t.id}_success`))) { t.status = 'success';
        } else if (existsSync(join(doneFlagDir, `DONE_${t.id}_failed`))) { t.status = 'failed';
        } else if (existsSync(join(doneFlagDir, `DONE_${t.id}_stalled`))) { t.status = 'stalled';
        } else if (existsSync(join(doneFlagDir, `DONE_${t.id}_orphaned`))) { t.status = 'orphaned';
        } else { allDone = false; }
      }
    }
    if (allDone) break;
    if (maxWait > 0 && Date.now() - startTime > maxWait) break;
    await new Promise(resolve => setTimeout(resolve, checkInterval));
  }

  const completed = tasks.filter(t => t.status !== 'running').length;
  return { batch: args.batchName, total: tasks.length, completed, running: tasks.length - completed, tasks };
}
