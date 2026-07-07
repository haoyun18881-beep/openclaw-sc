
/**
 * 🧠 hippocampus-multi-search.js — 多路径跨区域搜索引擎
 *
 * sc 五路并行记忆搜索：
 *   A: 主关键词搜索   — 现有 FTS5/keyword 搜索 + 同义词展开
 *   B: 同义词展开搜索  — SYNONYM_MAP 自动展开查询词
 *   C: 失败经验搜索   — error/crash/timeout/报错 等模式
 *   D: 跨区域关联     — 实体→决策→时间线 JOIN 遍历
 *   E: 时间线回溯     — 按时间窗口前后聚类
 *
 * 用法：
 *   import { multiPathSearch } from './hippocampus-multi-search.js';
 *   const result = await multiPathSearch({ query: "数据库配置", pool }, { timeRange: "1w" });
 *
 * v1.0.0 — 2026-06-03
 */

import { readFile, readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';

// ====== 路径常量 ======
const WORKSPACE_DIR = join(homedir(), '.openclaw', 'workspace');
const DIALOG_DIR = join(WORKSPACE_DIR, 'memory', 'dialog');
const HIPPOCAMPUS_DIR = join(WORKSPACE_DIR, 'memory', 'hippocampus');
const TASK_STATES_DIR = join(WORKSPACE_DIR, 'memory', 'task-states');
const REVIEWS_DIR = join(WORKSPACE_DIR, 'memory', 'reviews');

// ====== ─── SYNONYM_MAP（同义词映射表，覆盖日常 90% 场景）─── ======
const SYNONYM_MAP = {
  'config': 'config configure configuration setting setup 配置 设置 参数 settings',
  'database': 'database db 数据库 数据源 datasource postgres mysql sqlite mongo',
  'error': 'error failure crash timeout 错误 失败 异常 exception 报错 卡死 fatal bug',
  'search': 'search query find 搜索 查找 查询 find recall grep lookup',
  'install': 'install setup 安装 部署 setup installation 配置环境',
  'network': 'network 网络 连接 proxy vpn 代理 connection 端口 port',
  'build': 'build compile 构建 编译 打包 npm node pod install bundle',
  'test': 'test 测试 单元测试 unittest jest mocha spec 验证 verify',
  'docker': 'docker container 容器 镜像 image compose yml',
  'deploy': 'deploy deployment 部署 发布 release rollback 上线',
  'memory': 'memory 记忆 知识 知识库 remember cache 缓存 回忆 recall',
  'tool': 'tool 工具 skill plugin 插件 函数 function 功能',
  'security': 'security 安全 权限 auth authz ssl 防火墙 firewall',
  'code': 'code 代码 file 文件 修改 edit 编辑 重构 refactor 调试 debug',
  'performance': 'performance 性能 优化 速度 内存 延迟 latency speed',
  'backup': 'backup 备份 恢复 restore 同步 迁移 migrate',
  'monitor': 'monitor 监控 日志 log 警报 alert dashboard 观察 watch',
  'project': 'project 项目 workspace 工作空间 workspace 工程 repo',
  'update': 'update 更新 升级 upgrade version 版本 新版本 release',
  'remove': 'remove delete 删除 卸载 uninstall clean 清理 清除 rm purge',
  'create': 'create 创建 新建 new 生成 generate 构建 build 初始化 init',
  'fix': 'fix 修复 解决 修复解决 bugfix repair patch 补丁 hotfix',
  'path': 'path 路径 directory 目录 folder 文件夹 目录结构 filepath',
  'window': 'window 窗口 panel 面板 界面 ui 界面 view 视图',
  'deploy': 'deploy deployment 部署 发布 release rollback 上线 cicd',
  'git': 'git github 版本控制 vcs 仓库 repo branch commit merge push pull',
  'python': 'python pip 虚拟环境 virtualenv conda 脚本 script',
  'node': 'node nodejs npm 包 package 模块 module 依赖 dependency',
  'ai': 'ai 人工智能 llm 模型 model 大模型 agent agent 智能体',
  // 中文专用同义词
  '配置': 'config configure configuration setting setup 配置 设置 参数 settings',
  '错误': 'error failure crash timeout 错误 失败 异常 exception 报错 卡死 fatal',
  '搜索': 'search query find 搜索 查找 查询 find recall grep',
  '安装': 'install setup 安装 部署 setup installation',
  '网络': 'network 网络 连接 proxy vpn 代理 端口 port',
  '测试': 'test 测试 单元测试 验证 verify spec',
  '部署': 'deploy deployment 部署 发布 release 上线 rollback',
  '记忆': 'memory 记忆 知识 知识库 remember cache 回忆 recall',
  '工具': 'tool 工具 skill plugin 插件 函数 function',
  '安全': 'security 安全 权限 auth 防火墙 firewall',
  '代码': 'code 代码 file 文件 修改 edit 重构 refactor',
  '性能': 'performance 性能 优化 速度 内存 延迟 latency',
  '备份': 'backup 备份 恢复 restore 同步 sync',
  '监控': 'monitor 监控 日志 log 警报 alert 观察',
  '项目': 'project 项目 workspace workspace repo',
  '更新': 'update 更新 升级 upgrade version version',
  '删除': 'remove delete 删除 卸载 uninstall clean 清除 清理 rm',
  '创建': 'create 创建 新建 new 生成 generate 初始化 init build',
  '修复': 'fix 修复 解决 bugfix repair patch 补丁 hotfix 修正',
  '路径': 'path 路径 directory 目录 folder 目录结构',
};

// ====== ─── 失败关键词集合（路径 C 专用）─── ======
const FAILURE_TERMS = [
  'error', 'failure', 'crash', 'timeout', '报错', '错误', '失败',
  '异常', 'exception', 'fatal', 'bug', '死锁', '卡死', '崩溃',
  'ECONNREFUSED', 'ENOENT', 'EACCES', 'EPERM', 'ETIMEDOUT',
  'reject', 'unhandled', 'rejection', '报错', '不行', '搞不定',
  '死循环', '内存泄漏', 'leak', '堆积', 'queue',
  'cancel', 'abort', '熔断', '降级', '降级',
  '修复', 'fixed', 'bugfix', 'hotfix', '补丁', 'workaround',
  '踩坑', '坑', '教训', 'warning',
];

// ====== 工具函数 ======

/**
 * 展开查询词为同义词集合
 * @param {string} query - 原始查询
 * @returns {string[]} 展开后的搜索词数组
 */
function expandQueryTerms(query) {
  const terms = query.split(/[\s,，、]+/).filter(Boolean);
  const expandedSet = new Set();

  for (const term of terms) {
    const lower = term.toLowerCase();
    expandedSet.add(term);
    expandedSet.add(lower);

    // 查同义词映射
    const synonyms = SYNONYM_MAP[term] || SYNONYM_MAP[lower];
    if (synonyms) {
      const synTerms = synonyms.split(/\s+/);
      for (const st of synTerms) {
        if (st.length > 1) expandedSet.add(st);
      }
    }

    // 也查反向映射（同义词→原词）
    for (const [key, val] of Object.entries(SYNONYM_MAP)) {
      const valTerms = val.split(/\s+/);
      if (valTerms.includes(lower) || valTerms.includes(term)) {
        expandedSet.add(key);
        expandedSet.add(key.toLowerCase());
      }
    }
  }

  return [...expandedSet].filter(Boolean);
}

/**
 * 构建搜索关键词的 OR 查询串
 * @param {string} query - 原始查询
 * @returns {string} 展开后的 OR 查询串
 */
function buildSynonymQuery(query) {
  const terms = expandQueryTerms(query);
  return terms.join(' ');
}

/**
 * 构建失败模式搜索串
 * @param {string} query - 原始查询
 * @returns {string} 失败模式组合搜索串
 */
function buildFailureQuery(query) {
  const originalTerms = query.split(/[\s,，、]+/).filter(Boolean);
  const failTerms = FAILURE_TERMS.slice(0, 15).join(' ');
  // 组合：原始词 + 失败词 → 同时匹配
  return `${originalTerms.join(' ')} ${failTerms}`;
}

/**
 * 扫描目录获取 .md 文件列表（含子目录）
 */
async function scanMarkdownFiles(dir, maxFiles = 500, depth = 0) {
  if (depth > 8 || !existsSync(dir)) return [];
  const results = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (results.length >= maxFiles) break;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      const sub = await scanMarkdownFiles(fullPath, maxFiles - results.length, depth + 1);
      results.push(...sub);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }
  return results;
}

// ====== ─── 路径 A：主关键词搜索 ─── ======

/**
 * A 路径 — 主关键词搜索
 * 使用 Worker pool 的 search-text 类型在 dialog + reviews 中搜索
 *
 * @param {string} query - 原始查询词
 * @param {object} pool - CpuWorkerPool 实例
 * @param {object} options - { timeRange, mode, limit }
 * @returns {Promise<{ results: Array, elapsed: number, count: number }>}
 */
async function pathA_MainSearch(query, pool, options = {}) {
  const startTime = Date.now();
  const expandedQuery = buildSynonymQuery(query);
  const limit = options.limit || 10;

  // 收集搜索路径
  const searchPaths = [];

  // 1. 对话日记目录
  if (existsSync(DIALOG_DIR)) {
    searchPaths.push(DIALOG_DIR);
  }

  // 2. reviews 目录（设计文档/方案）
  if (existsSync(REVIEWS_DIR)) {
    searchPaths.push(REVIEWS_DIR);
  }

  // 3. 核心文档目录
  const memoryDir = join(WORKSPACE_DIR, 'memory');
  if (existsSync(memoryDir)) {
    searchPaths.push(memoryDir);
  }

  // 扫描所有 .md 文件
  const allFiles = [];
  for (const sp of searchPaths) {
    const files = await scanMarkdownFiles(sp, 200);
    allFiles.push(...files);
  }

  if (allFiles.length === 0) {
    return { results: [], elapsed: Date.now() - startTime, count: 0, expandedQuery, note: '未找到搜索文件' };
  }

  // 分块并发搜索
  const CHUNK_SIZE = 50;
  const chunks = [];
  for (let i = 0; i < allFiles.length; i += CHUNK_SIZE) {
    chunks.push(allFiles.slice(i, i + CHUNK_SIZE));
  }

  const workerTasks = chunks.map(fileList =>
    pool.exec({
      type: 'search-text',
      keyword: expandedQuery,
      files: fileList,
    }, 'high')
  );

  // 也搜索原始词（保底，避免扩展得太散）
  const originalChunks = [];
  if (expandedQuery !== query) {
    for (let i = 0; i < allFiles.length; i += CHUNK_SIZE) {
      originalChunks.push(allFiles.slice(i, i + CHUNK_SIZE));
    }
    workerTasks.push(...originalChunks.map(fileList =>
      pool.exec({
        type: 'search-text',
        keyword: query,
        files: fileList,
      }, 'high')
    ));
  }

  const rawResults = await Promise.allSettled(workerTasks);

  // 合并去重
  const seen = new Set();
  const merged = [];
  for (const r of rawResults) {
    if (r.status === 'fulfilled' && r.value && r.value.results) {
      for (const item of r.value.results) {
        if (!seen.has(item.file)) {
          seen.add(item.file);
          merged.push(item);
        } else {
          // 合并匹配计数
          const existing = merged.find(m => m.file === item.file);
          if (existing && item.matchCount) {
            existing.matchCount = (existing.matchCount || 0) + item.matchCount;
            if (item.matches) {
              (existing.matches = existing.matches || []).push(...item.matches);
            }
          }
        }
      }
    }
  }

  // 按匹配数排序
  merged.sort((a, b) => (b.matchCount || 0) - (a.matchCount || 0));

  const elapsed = Date.now() - startTime;
  return {
    results: merged.slice(0, limit),
    elapsed,
    count: merged.length,
    expandedQuery,
    totalFilesSearched: allFiles.length,
  };
}

// ====== ─── 路径 B：同义词/关联词展开搜索 ─── ======

/**
 * B 路径 — 同义词/关联词展开搜索
 * 将 query 中每个词拆开，分别走语义搜索或各同义词分支搜索
 *
 * @param {string} query - 原始查询词
 * @param {object} pool - CpuWorkerPool 实例
 * @param {object} options
 * @returns {Promise<{ results: Array, branches: Array, elapsed: number }>}
 */
async function pathB_SynonymSearch(query, pool, options = {}) {
  const startTime = Date.now();
  const terms = query.split(/[\s,，、]+/).filter(Boolean);
  const limit = options.limit || 8;

  // 对每个 term 分别展开同义词（如果该词有同义词映射）
  const branchQueries = [];
  for (const term of terms) {
    const lower = term.toLowerCase();
    const synonyms = SYNONYM_MAP[lower] || SYNONYM_MAP[term];
    if (synonyms) {
      const synTerms = synonyms.split(/\s+/).filter(s => s.length > 1);
      // 取前 3 个最有代表性的同义词
      const topSyns = synTerms.slice(0, 3);
      for (const syn of topSyns) {
        if (syn !== lower && syn !== term) {
          branchQueries.push(syn);
        }
      }
    }
  }

  // 去重
  const uniqueQueries = [...new Set(branchQueries)].slice(0, 10);
  if (uniqueQueries.length === 0) {
    return { results: [], branches: [], elapsed: Date.now() - startTime, note: '无需同义词展开' };
  }

  // 并行搜索所有分支（走语义搜索，也可以走 search-text）
  const searchTasks = uniqueQueries.map(bq =>
    pool.exec({
      type: 'semantic-search',
      query: bq,
      rootDir: WORKSPACE_DIR,
      maxResults: 5,
    }, 'high').catch(() => null)
  );

  // 也为原始 query 做一个语义搜索
  searchTasks.push(
    pool.exec({
      type: 'semantic-search',
      query,
      rootDir: WORKSPACE_DIR,
      maxResults: limit,
    }, 'high').catch(() => null)
  );

  const rawResults = await Promise.allSettled(searchTasks);

  // 合并结果
  const seen = new Set();
  const fused = [];
  const branches = [];

  for (let i = 0; i < uniqueQueries.length; i++) {
    const r = rawResults[i];
    const bq = uniqueQueries[i];
    if (r.status === 'fulfilled' && r.value && r.value.results) {
      const branchResults = r.value.results.slice(0, 3);
      branches.push({ term: bq, count: branchResults.length });
      for (const item of branchResults) {
        const key = item.file || `${item.path}_${item.line}`;
        if (!seen.has(key)) {
          seen.add(key);
          fused.push({ ...item, _synonymBranch: bq });
        }
      }
    }
  }

  // 也要原始语义结果中的额外结果
  const origResult = rawResults[uniqueQueries.length];
  if (origResult?.status === 'fulfilled' && origResult.value?.results) {
    for (const item of origResult.value.results) {
      const key = item.file || `${item.path}_${item.line}`;
      if (!seen.has(key)) {
        seen.add(key);
        fused.push({ ...item, _synonymBranch: 'original' });
      }
    }
  }

  fused.sort((a, b) => (b.score || 0) - (a.score || 0));

  return {
    results: fused.slice(0, limit),
    branches: branches.filter(b => b.count > 0),
    elapsed: Date.now() - startTime,
    totalSynonymBranches: uniqueQueries.length,
  };
}

// ====== ─── 路径 C：失败经验搜索 ─── ======

/**
 * C 路径 — 失败经验搜索
 * 搜索所有包含失败/报错/踩坑模式的记录
 *
 * @param {string} query - 原始查询词
 * @param {object} pool - CpuWorkerPool 实例
 * @param {object} options
 * @returns {Promise<{ results: Array, elapsed: number, count: number }>}
 */
async function pathC_FailureSearch(query, pool, options = {}) {
  const startTime = Date.now();
  const failureQuery = buildFailureQuery(query);
  const limit = options.limit || 8;

  // 搜索路径：dialog + reviews + memory
  const searchPaths = [];
  if (existsSync(DIALOG_DIR)) searchPaths.push(DIALOG_DIR);
  if (existsSync(REVIEWS_DIR)) searchPaths.push(REVIEWS_DIR);
  const memoryDir = join(WORKSPACE_DIR, 'memory');
  if (existsSync(memoryDir)) searchPaths.push(memoryDir);

  const allFiles = [];
  for (const sp of searchPaths) {
    const files = await scanMarkdownFiles(sp, 300);
    allFiles.push(...files);
  }

  if (allFiles.length === 0) {
    return { results: [], elapsed: Date.now() - startTime, count: 0 };
  }

  // 1. Worker pool 搜索失败模式
  const CHUNK_SIZE = 50;
  const chunks = [];
  for (let i = 0; i < allFiles.length; i += CHUNK_SIZE) {
    chunks.push(allFiles.slice(i, i + CHUNK_SIZE));
  }

  const workerTasks = chunks.map(fileList =>
    pool.exec({
      type: 'search-text',
      keyword: failureQuery,
      files: fileList,
    }, 'high')
  );

  const workerResults = await Promise.allSettled(workerTasks);

  // 合并
  const seen = new Set();
  const merged = [];
  for (const r of workerResults) {
    if (r.status === 'fulfilled' && r.value?.results) {
      for (const item of r.value.results) {
        if (!seen.has(item.file)) {
          seen.add(item.file);
          merged.push(item);
        }
      }
    }
  }

  // 2. 搜索 task-states 文件（失败状态的任务）
  let taskFailures = [];
  if (existsSync(TASK_STATES_DIR)) {
    try {
      const taskFiles = await readdir(TASK_STATES_DIR);
      for (const tf of taskFiles) {
        if (!tf.endsWith('.json')) continue;
        try {
          const content = await readFile(join(TASK_STATES_DIR, tf), 'utf-8');
          const data = JSON.parse(content);
          if (data.status === 'error' || data.error || data.errors) {
            taskFailures.push({
              file: join(TASK_STATES_DIR, tf),
              taskId: tf.replace('.json', ''),
              status: 'error',
              errorDetail: data.error || data.errors?.slice(0, 2).join(', ') || data.errorDetail || '未知错误',
              matchCount: 1,
            });
          }
        } catch {}
      }
    } catch {}
  }

  // 3. 搜索 hippocampus events 中的失败事件
  let eventFailures = [];
  const eventsJsonl = join(HIPPOCAMPUS_DIR, 'events.jsonl');
  if (existsSync(eventsJsonl)) {
    try {
      const content = await readFile(eventsJsonl, 'utf-8');
      const lines = content.trim().split('\n').slice(-50); // 只看最近 50 
      for (const line of lines) {
        try {
          const evt = JSON.parse(line);
          if (evt.status === 'error' || evt.status === 'failure') {
            const queryTerms = query.split(/[\s,，、]+/).filter(Boolean);
            const evtText = JSON.stringify(evt).toLowerCase();
            const matchesQuery = queryTerms.some(t => evtText.includes(t.toLowerCase()));
            if (matchesQuery) {
              eventFailures.push({
                file: eventsJsonl,
                eventId: evt.eventId || evt.id || 'unknown',
                type: evt.type || 'unknown',
                status: evt.status,
                errorMessage: evt.result || evt.error || evt.params || '无详细',
                matchCount: 1,
                timestamp: evt.timestamp,
              });
            }
          }
        } catch {}
      }
    } catch {}
  }

  // 排序：worker结果按匹配数，task-states和events按时间
  merged.sort((a, b) => (b.matchCount || 0) - (a.matchCount || 0));

  const failures = [
    ...merged.slice(0, limit),
    ...taskFailures.slice(0, 3),
    ...eventFailures.slice(0, 2),
  ];

  return {
    results: failures.slice(0, limit),
    elapsed: Date.now() - startTime,
    count: failures.length,
    totalFilesSearched: allFiles.length,
    taskFailureCount: taskFailures.length,
    eventFailureCount: eventFailures.length,
  };
}

// ====== ─── 路径 D：跨区域关联搜索 ─── ======

/**
 * D 路径 — 跨区域关联搜索
 * 遍历 hippocampus 的 entities.json → decisions.json → timeline.json
 * 建立跨区域关联
 *
 * @param {string} query - 原始查询词
 * @param {object} pool - CpuWorkerPool 实例（保留用于扩展）
 * @param {object} options
 * @returns {Promise<{ results: Array, elapsed: number }>}
 */
async function pathD_CrossRegionSearch(query, options = {}) {
  const startTime = Date.now();
  const limit = options.limit || 10;
  const queryLower = query.toLowerCase();
  const queryTerms = queryLower.split(/[\s,，、]+/).filter(Boolean);

  const hippocampusFiles = [
    { name: 'entities.json', type: 'entity', path: join(HIPPOCAMPUS_DIR, 'entities.json') },
    { name: 'decisions.json', type: 'decision', path: join(HIPPOCAMPUS_DIR, 'decisions.json') },
    { name: 'timeline.json', type: 'timeline', path: join(HIPPOCAMPUS_DIR, 'timeline.json') },
  ];

  const seen = new Set();
  const results = [];

  for (const { name, type, path: fPath } of hippocampusFiles) {
    if (!existsSync(fPath)) continue;
    try {
      const raw = await readFile(fPath, 'utf-8');
      const data = JSON.parse(raw);

      // 统一遍历逻辑
      const entries = Array.isArray(data) ? data : (data.records || data.items || data.entries || [data]);

      for (const entry of entries) {
        const entryStr = JSON.stringify(entry).toLowerCase();
        const matches = queryTerms.some(t => entryStr.includes(t));
        if (!matches) continue;

        let id = entry.id || entry.entity_id || entry.decision_id || entry.event_id || '';
        let summary = entry.summary || entry.name || entry.description || entry.title || '';
        let recordTime = entry.time || entry.timestamp || entry.date || '';

        // 去重
        const dedupKey = `${type}:${id || summary}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);

        const resultItem = {
          _region: type,
          id: id,
          summary: typeof summary === 'string' ? summary.substring(0, 300) : JSON.stringify(summary).substring(0, 300),
          time: recordTime,
          sourceFile: name,
        };

        // 实体特定的额外字段
        if (type === 'entity') {
          resultItem.entityName = entry.name || entry.label || '';
          resultItem.entityType = entry.type || entry.entity_type || '';
          // 提取关联的决策/事件
          const relatedDecisions = entry.decisions || entry.related_decisions || [];
          if (Array.isArray(relatedDecisions) && relatedDecisions.length > 0) {
            resultItem.relatedDecisions = relatedDecisions.slice(0, 5);
          }
          const relatedEvents = entry.events || entry.related_events || [];
          if (Array.isArray(relatedEvents) && relatedEvents.length > 0) {
            resultItem.relatedEvents = relatedEvents.slice(0, 5);
          }
        }

        // 决策特定的额外字段
        if (type === 'decision') {
          resultItem.context = entry.context || entry.reason || '';
          resultItem.decision = entry.decision || entry.outcome || entry.conclusion || '';
        }

        // 时间线特定的额外字段
        if (type === 'timeline') {
          resultItem.eventType = entry.type || entry.event_type || '';
          resultItem.detail = entry.detail || entry.content || '';
        }

        results.push(resultItem);
      }
    } catch (err) {
      results.push({ _region: type, error: `读取 ${name} 失败: ${err.message}` });
    }
  }

  // 按时间排序（如有）
  results.sort((a, b) => {
    // 有时间戳的先排，没有的沉底
    if (a.time && b.time) return String(b.time).localeCompare(String(a.time));
    if (a.time) return -1;
    if (b.time) return 1;
    return 0;
  });

  return {
    results: results.slice(0, limit),
    elapsed: Date.now() - startTime,
    count: results.length,
    regions: {
      entities: results.filter(r => r._region === 'entity').length,
      decisions: results.filter(r => r._region === 'decision').length,
      timeline: results.filter(r => r._region === 'timeline').length,
    },
  };
}

// ====== ─── 路径 E：时间线回溯搜索 ─── ======

/**
 * E 路径 — 时间线回溯搜索
 * 基于时间窗口的搜索：搜索 query 相关事件后，扩展时间窗口
 *
 * @param {string} query - 原始查询词
 * @param {object} pool - CpuWorkerPool 实例
 * @param {object} options - { timeRange, hoursBefore, hoursAfter }
 * @returns {Promise<{ results: Array, elapsed: number }>}
 */
async function pathE_TimelineBacktrack(query, pool, options = {}) {
  const startTime = Date.now();
  const limit = options.limit || 8;
  const queryLower = query.toLowerCase();
  const queryTerms = queryLower.split(/[\s,，、]+/).filter(Boolean);
  const hoursBefore = options.hoursBefore || 48;  // 默认往前48小时
  const hoursAfter = options.hoursAfter || 24;    // 默认往后24小时

  // 1. 先用搜索找相关事件的时间点
  const dialogDir = DIALOG_DIR;
  let referenceTimes = [];

  // 从对话日记文件名中提取时间（文件名 YYYY-MM-DD.md）
  if (existsSync(dialogDir)) {
    try {
      const entries = await readdir(dialogDir);
      for (const entry of entries) {
        if (!entry.endsWith('.md')) continue;
        // 尝试搜索匹配
        const filePath = join(dialogDir, entry);
        try {
          const content = await readFile(filePath, 'utf-8');
          const contentLower = content.toLowerCase();
          const matches = queryTerms.some(t => contentLower.includes(t));
          if (matches) {
            const dateMatch = entry.match(/(\d{4}-\d{2}-\d{2})/);
            if (dateMatch) {
              referenceTimes.push({
                file: entry,
                date: dateMatch[1],
                content: content.substring(0, 200),
              });
            }
          }
        } catch {}
      }
    } catch {}
  }

  // 2. 如果有参考时间点，扩展时间窗口搜索
  let expandedResults = [];
  if (referenceTimes.length > 0) {
    const CHUNK_SIZE = 50;

    // 收集所有 dialog 文件并按时间排序
    const allDialogFiles = [];
    if (existsSync(dialogDir)) {
      const entries = await readdir(dialogDir);
      for (const entry of entries) {
        if (!entry.endsWith('.md')) continue;
        const dateMatch = entry.match(/(\d{4}-\d{2}-\d{2})/);
        if (dateMatch) {
          allDialogFiles.push({ file: entry, date: dateMatch[1], fullPath: join(dialogDir, entry) });
        }
      }
    }

    // 对每个参考时间点，收集前后窗口内的文件
    const candidateFiles = new Map();
    for (const rt of referenceTimes) {
      const refDate = new Date(rt.date);
      for (const df of allDialogFiles) {
        const fileDate = new Date(df.date);
        const diffMs = fileDate.getTime() - refDate.getTime();
        const diffHours = diffMs / (1000 * 60 * 60);
        if (diffHours >= -hoursBefore && diffHours <= hoursAfter) {
          candidateFiles.set(df.fullPath, df.date);
        }
      }
    }

    expandedResults = [...candidateFiles.keys()].map(fp => ({
      file: fp,
      date: candidateFiles.get(fp),
      matchCount: 1,
    }));
  }

  // 3. 结合 timeline.json 中的时间事件
  const timelinePath = join(HIPPOCAMPUS_DIR, 'timeline.json');
  let timelineEvents = [];
  if (existsSync(timelinePath)) {
    try {
      const raw = await readFile(timelinePath, 'utf-8');
      const data = JSON.parse(raw);
      const entries = Array.isArray(data) ? data : (data.records || data.items || data.entries || [data]);
      for (const entry of entries) {
        const entryStr = JSON.stringify(entry).toLowerCase();
        const matches = queryTerms.some(t => entryStr.includes(t));
        if (matches) {
          timelineEvents.push({
            file: 'timeline.json',
            eventType: entry.type || entry.event_type || '',
            summary: entry.summary || entry.description || entry.detail || '',
            time: entry.time || entry.timestamp || entry.date || '',
            matchCount: 1,
          });
        }
      }
    } catch {}
  }

  // 4. 合并：时间窗口文件 + timeline事件
  const results = [
    ...expandedResults.slice(0, limit),
    ...timelineEvents.slice(0, Math.max(3, limit - expandedResults.length)),
  ];

  return {
    results: results.slice(0, limit),
    elapsed: Date.now() - startTime,
    count: results.length,
    referenceDates: referenceTimes.map(r => r.date),
    timelineEventCount: timelineEvents.length,
    timeWindowHours: { before: hoursBefore, after: hoursAfter },
  };
}

// ====== ─── 结果融合与重排序 ─── ======

/**
 * 五路搜索结果融合
 * 去重 → 交叉插入 → 权重排序
 *
 * @param {object} paths - { pathA, pathB, pathC, pathD, pathE }
 * @param {string} query - 原始查询
 * @returns {object} 融合后的结果
 */
function fuseResults(paths, query) {
  const seen = new Map(); // key → result item
  const ordered = [];     // 有序列表，保持 source 标签

  function addResults(items, tag) {
    if (!items || items.length === 0) return;
    for (const item of items) {
      const key = item.file || item.id || `${item.summary?.substring(0, 50)}`;
      if (!seen.has(key)) {
        seen.set(key, { ...item, _tag: tag, _order: ordered.length });
        ordered.push(key);
      }
    }
  }

  // 交叉插入（主结果优先）
  const pathA = paths.pathA?.results || [];
  const pathB = paths.pathB?.results || [];
  const pathC = paths.pathC?.results || [];
  const pathD = paths.pathD?.results || [];
  const pathE = paths.pathE?.results || [];

  const maxLen = Math.max(pathA.length, pathB.length, pathC.length, pathD.length, pathE.length);

  for (let i = 0; i < maxLen * 3; i++) {
    const idx = Math.floor(i / 3);
    const sub = i % 3;

    if (sub === 0 && pathA[idx]) addResults([pathA[idx]], '🎯 主结果');
    if (sub === 1 && pathB[idx]) addResults([pathB[idx]], '🔗 语义扩展');
    if (sub === 2 && pathC[idx]) addResults([pathC[idx]], '⚠️ 失败经验');

    if (sub === 0 && idx < 3) {
      if (pathD[idx]) addResults([pathD[idx]], '🌐 跨区域');
      if (pathE[idx]) addResults([pathE[idx]], '⏰ 时间线');
    }
  }

  // 再补上未添加的 D/E 路径结果
  if (pathD.length > 3) addResults(pathD.slice(3), '🌐 跨区域');
  if (pathE.length > 3) addResults(pathE.slice(3), '⏰ 时间线');

  const finalResults = ordered.map(k => seen.get(k));

  return {
    query,
    results: finalResults.slice(0, 30),
    totalResults: finalResults.length,
    pathStats: {
      pathA: { count: paths.pathA?.count || 0, elapsed: paths.pathA?.elapsed || 0 },
      pathB: { count: paths.pathB?.results?.length || 0, elapsed: paths.pathB?.elapsed || 0 },
      pathC: { count: paths.pathC?.count || 0, elapsed: paths.pathC?.elapsed || 0 },
      pathD: { count: paths.pathD?.count || 0, elapsed: paths.pathD?.elapsed || 0 },
      pathE: { count: paths.pathE?.count || 0, elapsed: paths.pathE?.elapsed || 0 },
    },
    totalElapsed: Object.values(paths).reduce((sum, p) => sum + (p?.elapsed || 0), 0),
  };
}

// ====== ─── 主入口：五路并行搜索 ─── ======

/**
 * 多路径并行搜索入口
 *
 * 同时执行 A/B/C/D/E 五路搜索，融合结果
 *
 * @param {object} params
 * @param {string} params.query - 搜索关键词（必填）
 * @param {string} [params.timeRange] - 时间范围: 3d|1w|1m|all
 * @param {number} [params.limit] - 每路径结果上限（默认10）
 * @param {boolean} [params.enablePathB] - 启用语义同义词展开（默认true）
 * @param {boolean} [params.enablePathC] - 启用失败经验搜索（默认true）
 * @param {boolean} [params.enablePathD] - 启用跨区域搜索（默认true）
 * @param {boolean} [params.enablePathE] - 启用时间线回溯（默认true）
 * @param {boolean} [params.fuseOnly] - 仅融合已传入的paths（不执行搜索）
 * @param {object} [params.paths] - 当 fuseOnly=true 时传入
 * @param {object} pool - CpuWorkerPool 实例
 * @returns {Promise<object>} 融合后的搜索结果
 */
export async function multiPathSearch(params, pool) {
  const query = params.query;
  if (!query) return { status: 'error', error: 'missing query 参数' };

  const timeRange = params.timeRange || 'all';
  const limit = Math.min(params.limit || 10, 30);
  const enablePathB = params.enablePathB !== false;
  const enablePathC = params.enablePathC !== false;
  const enablePathD = params.enablePathD !== false;
  const enablePathE = params.enablePathE !== false;

  // 快速路径：仅融合已有结果
  if (params.fuseOnly && params.paths) {
    return {
      status: 'success',
      ...fuseResults(params.paths, query),
      mode: 'fuse_only',
    };
  }

  const startTime = Date.now();

  // 并行执行五路搜索（不互相依赖，可全并行）
  const tasks = [
    pathA_MainSearch(query, pool, { limit: limit + 5, timeRange }).catch(err => ({
      results: [], elapsed: 0, count: 0, error: err.message,
    })),
  ];

  if (enablePathB) {
    tasks.push(
      pathB_SynonymSearch(query, pool, { limit: limit + 3 }).catch(err => ({
        results: [], branches: [], elapsed: 0, error: err.message,
      }))
    );
  }

  if (enablePathC) {
    tasks.push(
      pathC_FailureSearch(query, pool, { limit: limit + 3, timeRange }).catch(err => ({
        results: [], elapsed: 0, count: 0, error: err.message,
      }))
    );
  }

  if (enablePathD) {
    tasks.push(
      pathD_CrossRegionSearch(query, { limit: limit + 3 }).catch(err => ({
        results: [], elapsed: 0, count: 0, error: err.message,
      }))
    );
  }

  if (enablePathE) {
    tasks.push(
      pathE_TimelineBacktrack(query, pool, { limit: limit + 3, timeRange }).catch(err => ({
        results: [], elapsed: 0, count: 0, error: err.message,
      }))
    );
  }

  const settled = await Promise.allSettled(tasks);

  const paths = {};
  const pathResults = settled.map((s, i) => {
    const names = ['pathA', 'pathB', 'pathC', 'pathD', 'pathE'];
    return { name: names[i], result: s.status === 'fulfilled' ? s.value : { error: s.reason?.message, elapsed: 0 } };
  });

  for (const pr of pathResults) {
    paths[pr.name] = pr.result;
  }

  // 融合
  const fused = fuseResults(paths, query);
  fused.totalElapsed = Date.now() - startTime;

  return {
    status: 'success',
    query,
    timeRange,
    ...fused,
    mode: 'full_multi_path',
  };
}

// ====== ─── CLI 入口 ─── ======

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help') {
    // TODO: 移除调试日志 console.log(`
    // 🧠 hippocampus-multi-search.js — 多路径跨区域搜索引擎
    //     // 用法:
    // node hippocampus-multi-search.js <query> [options]
    //     // 选项:
    // --timeRange 3d|1w|1m|all    时间范围 (默认 all)
    // --limit <n>                 每路径结果上限 (默认 10)
    // --disableB                  禁用同义词展开
    // --disableC                  禁用失败经验搜索
    // --disableD                  禁用跨区域搜索
    // --disableE                  禁用时间线回溯
    // --dry-run                   只输出路径规划, 不执行搜索
    //     // 示例:
    // node hippocampus-multi-search.js "数据库配置"
    // node hippocampus-multi-search.js "error timeout" --timeRange 1w
    // node hippocampus-multi-search.js "sc" --limit 20
    // `);
    return;
  }

  const query = args[0];
  const options = {
    query,
    timeRange: 'all',
    limit: 10,
    enablePathB: !args.includes('--disableB'),
    enablePathC: !args.includes('--disableC'),
    enablePathD: !args.includes('--disableD'),
    enablePathE: !args.includes('--disableE'),
  };

  const trIdx = args.indexOf('--timeRange');
  if (trIdx >= 0 && args[trIdx + 1]) options.timeRange = args[trIdx + 1];

  const liIdx = args.indexOf('--limit');
  if (liIdx >= 0 && args[liIdx + 1]) options.limit = parseInt(args[liIdx + 1], 10);

  if (args.includes('--dry-run')) {
    // TODO: 移除调试日志 console.log(JSON.stringify({
    // status: 'dry_run',
    // query: options.query,
    // paths: {
    // pathA: '主关键词搜索',
    // pathB: options.enablePathB ? '同义词展开搜索' : '已禁用',
    // pathC: options.enablePathC ? '失败经验搜索' : '已禁用',
    // pathD: options.enablePathD ? '跨区域关联搜索' : '已禁用',
    // pathE: options.enablePathE ? '时间线回溯搜索' : '已禁用',
    // },
    // }, null, 2));
    return;
  }

  // CLI 模式需要 pool 参数，这里提示
  // TODO: 移除调试日志 console.log(JSON.stringify({
    // status: 'info',
    // message: 'CLI 模式需要 Worker pool 实例，请在sc环境下通过 MCP 调用 multi_search action',
    // usage: '通过 agent_memory_retriever(action: "multi_search", query: "...") 调用',
    // }, null, 2));
}

// 直接运行
if (process.argv[1] && (process.argv[1].endsWith('hippocampus-multi-search.js'))) {
  main().catch(err => {
    console.error(JSON.stringify({ status: 'error', error: err.message }, null, 2));
    process.exit(1);
  });
}

export default {
  multiPathSearch,
  pathA_MainSearch,
  pathB_SynonymSearch,
  pathC_FailureSearch,
  pathD_CrossRegionSearch,
  pathE_TimelineBacktrack,
  fuseResults,
  expandQueryTerms,
  SYNONYM_MAP,
};
