/**
 * sc 核心配置常量
 *
 * 所有硬编码配置统一管理，避免散落在各模块中。
 * 供 index.js(CpuWorkerPool) 及其他模块引用。
 */

import { cpus, homedir } from "os";
import { join } from "path";

// ====== 核心配置 ======
// 🧠 设计决策：PHYSICAL_CORES 全开（管理员2026-06-02确认28核全开，不留余量）。
// 之前上限20，管理员说不用留，全开。Ollama和系统吃剩下的，CPU自己调度。
export const PHYSICAL_CORES = cpus().length; // 28核全开（管理员确认，不设上限）
// ⚠️ 废弃：由 RESERVED_CORES=2 替代。CORE_RESERVED_IDLE=8 是旧版概念（保留空闲核心数），
// CORE_RESERVED_MIN=4 是旧版最小保留值。两者均与新 RESERVED_CORES=2 逻辑冲突且值不一致（8 vs 2 vs 4）。
// 保留仅用于下游引用兼容（如 getDynamicMaxWorkers 的 catch fallback），新代码一律用 RESERVED_CORES。
export const CORE_RESERVED_IDLE = 8;
export const CORE_RESERVED_MIN = 4;
export const MIN_WORKERS = Math.max(2, Math.min(PHYSICAL_CORES - 1, 16));

// ====== MCP Server 端口 ======
export const MCP_PORT = 18790;

// 最大Worker数 = 物理核心 - 保留给系统主脑+Ollama的核心数（至少比MIN大）
// 2026-06-02 管理员28核全开，保留2核给系统/Ollama即可
export const RESERVED_CORES = 2;
export const MAX_WORKERS = Math.max(MIN_WORKERS + 2, PHYSICAL_CORES - RESERVED_CORES);

// 🧠 设计决策：SCALE_UP_THRESHOLD=0.7 不是80%也不是60%。70%是S形曲线上的预警触发点——
// 先于饱和（100%）给扩容留出缓冲时间。高于70%防过早扩容（抖动），低于80%防饱和后才反应。
// 刚好覆盖_autoScale(5s)的扩容延迟，爬坡到满配时队列不至于打满。
export const SCALE_UP_THRESHOLD = 0.7; // 队列深度达70%时扩容

// 🧠 CPU饱和度阈值：CPU利用率达85%时抑制扩容，防止正反馈振荡（Worker越多→CPU越满→任务越慢→队列越深→继续扩容→死循环）
// 取自load prediction经验值，与 os.cpus() 的 CPU 忙闲比配合使用。
// 配合 _autoScale() 中的饱和度检测一起生效。
export const CPU_SATURATION_THRESHOLD = 0.85;
// 🧠 设计决策：HEARTBEAT_MS=15000(15s)。刚好覆盖_autoScale(5s)3个完整周期，
// 能捕捉到突发负载变化又不浪费。比30s短能更快发现Worker失联，比5s长不刷屏。
export const HEARTBEAT_MS = 15000;
// 🧠 ⚠️ 已废弃：TASK_TIMEOUT_MS 已被 calcTimeout（基于 TASK_TIMEOUT_MAP 的动态计算）替代。
// 保留仅防外部引用意外断裂。只读不改，不需要更新。
export const TASK_TIMEOUT_MS = 60000;
// 🧠 设计决策：IDLE_TERMINATE_MS=60000(60s空闲终止)。scale down判据——用户要求删除睡眠学习后改用此值直接判断。
// 60s足够扛过短暂空闲低谷（不频繁启停），又不至于占着资源不肯放。
export const IDLE_TERMINATE_MS = 60000;

// ====== 缓存配置 ======
export const STATS_CACHE_TTL = 10000;
export const MEM_CACHE_TTL = 5000;

// ====== 缓存禁用常量 ======
// 🧠 设计决策：CACHE_DISABLED=0。TTL设为0=禁用缓存。这是个哨兵常量——读到它的地方
// 调用方就知道缓存是有意关闭的，不是配置忘填了。修改前先确认是否有意禁缓存。
export const CACHE_DISABLED = 0;

// ====== 路由缓存 ======
export const ROUTE_CACHE_TTL_MS = 300000;
export const ROUTE_CACHE_MAX = 200;

// ====== 文件编辑器 ======
export const FILE_EDIT_LOCK_TIMEOUT = 300000;

// ====== 紧急模式 ======
// 🧠 设计决策：RECOVERY_COOLDOWN_MS=60000(60s紧急模式防抖)。防止频繁进出紧急模式导致震荡——
// 灵感来自主板电源管理防抖（debounce）概念。1min内不再次触发紧急模式，确保恢复稳定。
export const RECOVERY_COOLDOWN_MS = 60000;
// 🧠 设计决策：EMERGENCY_MODE_SUPPRESSION_MS=30000(30s紧急模式抑制时间)。
// 这不是bug，也不是忘记配。30s刚好足够一次_autoScale(5s)完成 6 个周期
// 的扩容评估，同时防止频繁进出紧急模式导致抖动。
// 配合 RECOVERY_COOLDOWN_MS=60000（整体防抖60s），两层防抖：
//   第一层30 s：抑制期间不重复触发紧急模式
//   第二层60 s：退出紧急模式后 60 s内不再次进入
// 灵感来自电源管理电路中的 debounce 概念——短时波动被滤掉，持续压力才触发保护。
export const EMERGENCY_MODE_SUPPRESSION_MS = 30000;

// ====== 速率限制 ======
// 🧠 设计决策：RATE_LIMIT_PER_SEC=150 匹配26Worker全速处理。28核全开+26Worker，
// 150/s接近每s每Worker处理6个工具调用，足够覆盖批量并发。超限走10s封禁。
export const RATE_LIMIT_PER_SEC = 150;         // 每s最多处理150次工具调用（28核全开26Worker）
export const RATE_BLOCK_DURATION_MS = 10000;  // 速率超限封禁时长10s，管理员从30s调到10s，配合150/s用

// ====== Spawn 限制 ======
// 🧠 设计决策：MAX_ACTIVE_SPAWNS=50。28核全开26Worker，50是安全带=Worker数近2倍。
// 给子agent足够并行空间。MAX_SPAWN_PER_WINDOW=10 是速率限制，60s窗口内最多10 spawn。
// 管理员从5调到10以支持10路并行。
export const MAX_ACTIVE_SPAWNS = 16;             // 子agent最大同时活跃数16=26Worker+余量，管理员从20调到16
export const SPAWN_HISTORY_WINDOW_MS = 60000;    // spawn速率统计窗口(60s)
export const MAX_SPAWN_PER_WINDOW = 28;          // 子agent 60s窗口内最多28个（管理员从5调到10，10路并行不受限）

// ====== 路由守卫 ======
export const ROUTE_GUARD_VIOLATION_DECAY_MS = 60000;

// ====== 任务超时配置 ======
export const TASK_TIMEOUT_MAP = {
  core_search:    { warn: 120, kill: 300, label: '搜索' },
  cpu_semanticSearch: { warn: 120, kill: 300, label: '语义搜索' },
  cpu_scan:      { warn: 120, kill: 300, label: '扫描' },
  cpu_systemRun: { warn: 200, kill: 500, label: '系统运维' },
  core_processLog:{ warn:  60, kill: 120, label: '日志分析' },
  cpu_batch:     { warn:  60, kill: 120, label: '批量' },
  cpu_diff:      { warn:  60, kill: 120, label: '差异分析' },
  cpu_diagnose:  { warn:  60, kill: 120, label: '诊断' },
  cpu_codeEdit:  { warn:  60, kill: 120, label: '代码编辑' },
  cpu_codeReview:{ warn:  60, kill: 120, label: '代码审查' },
  cpu_bugFix:    { warn:  60, kill: 120, label: 'Bug修复' },
  cpu_orchestrate:{warn: 200, kill: 500, label: '编排' },
  cpu_research:  { warn: 200, kill: 500, label: '调研' },
  core_backup: { warn: 60, kill: 300, label: '工作空间同步' },
  core_resolveModel:{warn: 60,  kill: 120,  label: '模型解析' },
  core_routeTask: { warn:  60, kill: 120, label: '路由决策' },
  core_directRun: { warn:  30, kill:  60, label: '快速执行' },
  cpu_monitorSubagents: { warn: 30, kill: 60, label: '子agent监控' },
  cpu_routeEvidence: { warn: 30, kill: 60, label: '路由证据' },
  core_emergencyStop:     { warn:  10, kill:  30, label: '紧急停止' },
  core_stagePipeline: { warn: 200, kill: 500, label: '多阶段流水线' },
  cpu_resumeTask: { warn: 10, kill: 30, label: 'Checkpoint恢复' },
  core_createTask: { warn: 30, kill: 60, label: '创建任务' },
  core_reportResult: { warn: 30, kill: 60, label: '报告结果' },
  core_collectResults: { warn: 60, kill: 120, label: '收集结果' },
  core_codeEditor: { warn: 60, kill: 180, label: '领域代码' },
  core_memorySearch: { warn: 60, kill: 180, label: '领域推理' },
  core_webSearch: { warn: 60, kill: 180, label: '领域搜索' },
  core_toolRouter: { warn: 30, kill: 60, label: '领域工具' },
  core_localScheduler: { warn: 200, kill: 500, label: '领域编排' },
  cpu_evolution: { warn: 30, kill: 60, label: '演化' },
  cpu_cerebellumStatus: { warn: 10, kill: 30, label: '小脑状态' },
  cpu_chainDetect: { warn: 30, kill: 60, label: '链路检测' },
  cpu_associativeCache: { warn: 30, kill: 60, label: 'associative cache' },
  cpu_internalization: { warn: 60, kill: 180, label: '内化学习' },
  core_searchEx: { warn: 60, kill: 120, label: '统一搜索' },
  core_batchVision: { warn: 120, kill: 300, label: '图片批量' },
default:       { warn: 120, kill: 300, label: '通用' },
};

export const GRACE_PER_EXTRA_60S = 30000; // 任务超时后每多等1min，额外增加30s宽限期
export const MAX_GRACE_MULTIPLIER = 2; // 宽限时间最多为基础超时的2倍

// ====== Session 清理 ======
export const SESSION_KEEP_RECENT = 20;
export const SESSION_DIR = join(homedir(), '.openclaw', 'agents', 'main', 'sessions');

// ====== task-states 清理（孤儿任务元数据） ======
export const TASK_STATES_DIR = join(homedir(), '.openclaw', 'workspace', 'memory', 'task-states');

// ====== 共享文件 ======
export const SHARED_DIR = join(homedir(), '.openclaw', 'workspace', 'memory', 'shared');

// ====== 任务执行中心（子agent task-center） ======
export const TASK_CENTER_DIR = join(homedir(), '.openclaw', 'workspace', 'memory', 'shared', 'tasks');
export const DEFAULT_BATCH_SIZE = 12;
export const COLLECT_POLL_INTERVAL = 2000;

// ====== 路由审计 ======
export const ROUTE_AUDIT_DIR = join(homedir(), '.openclaw', 'workspace', 'memory', 'shared', 'route-audit');

// ====== Worker 模型warmup ======
export const WARMED_MODELS_MAX = 50;

// ====== steward rules engine ======
export const STEWARD_MODE = 'strict';
export const DEFAULT_CONFIG_PATH = join(homedir(), '.openclaw', 'steward-config.json');

// ====== 任务分类常量（可判定终止保证） ======
export const TASK_CATEGORY = {
  FINITE: 'finite',           // 有限型：输入确定后必然终止（cpu_search/cpu_diff/cpu_batch 等）
  CONDITIONAL: 'conditional', // 条件型：满足条件即终止（cpu_resolveModel/cpu_codeEdit/cpu_bugFix）
  EXPLORATORY: 'exploratory', // 探索型：无确定终止条件，可能持续探索新路径（cpu_research/cpu_orchestrate）
  INTERACTIVE: 'interactive', // 交互型：需要用户交互才能终止
};

// 每个sc工具对应的任务分类
// 用于：探索型任务自动写partialResult checkpoint，超时不丢中间结果
// 以下工具故意不在 TASK_CATEGORY_MAP 中：
//   core_stats、cpu_monitorSubagents、core_backup、cpu_systemRun、
//   core_toolDiscover、cpu_enrichSubagentTask、cpu_resolveModel、
//   cpu_compressTask、cpu_resumeTask、cpu_routeEvidence、core_routeTask、
//   cpu_internalization、cpu_evolution、cpu_cerebellumStatus
// 故意不加原因：这些工具都不是探索型(EXPLORATORY)任务，不需要写 checkpoint。
// 非探索型任务分不分类效果都一样——都不写 checkpoint。
// 不加可以减少新开发者加工具时改常量的工作量。
export const TASK_CATEGORY_MAP = {
  // ====== 有限型（FINITE） ======
  cpu_search: TASK_CATEGORY.FINITE,
  cpu_diff: TASK_CATEGORY.FINITE,
  cpu_batch: TASK_CATEGORY.FINITE,
  cpu_scan: TASK_CATEGORY.FINITE,
  cpu_diagnose: TASK_CATEGORY.FINITE,
  core_processLog: TASK_CATEGORY.FINITE,
  cpu_codeReview: TASK_CATEGORY.FINITE,
  cpu_semanticSearch: TASK_CATEGORY.FINITE,
  core_batchVision: TASK_CATEGORY.FINITE,
  cpu_dialogRecall: TASK_CATEGORY.FINITE,
  cpu_monitorSubagents: TASK_CATEGORY.FINITE,
  core_emergencyStop: TASK_CATEGORY.FINITE,
  core_backup: TASK_CATEGORY.FINITE,
  core_directRun: TASK_CATEGORY.FINITE,
  cpu_compressTask: TASK_CATEGORY.FINITE,
  cpu_routeEvidence: TASK_CATEGORY.FINITE,

  // ====== 条件型（CONDITIONAL） ======
  cpu_resolveModel: TASK_CATEGORY.CONDITIONAL,
  cpu_codeEdit: TASK_CATEGORY.CONDITIONAL,
  cpu_bugFix: TASK_CATEGORY.CONDITIONAL,
  core_routeTask: TASK_CATEGORY.CONDITIONAL,
  core_stagePipeline: TASK_CATEGORY.CONDITIONAL,

  // ====== 探索型（EXPLORATORY） ======
  cpu_research: TASK_CATEGORY.EXPLORATORY,
  cpu_orchestrate: TASK_CATEGORY.EXPLORATORY,

  // ====== 交互型（INTERACTIVE） ======
  core_mainBrainPause: TASK_CATEGORY.INTERACTIVE,
};

// ====== 探索型 checkpoint 写入间隔（毫秒） ======
export const EXPLORATORY_CHECKPOINT_INTERVAL_MS = 30000;

// ====== 受限工具列表 ======
export const RESTRICTED_TOOLS = new Set([
  'exec',
  'web_search',
  'tavily_search',
  'tavily_extract',
  'web_fetch',
  'browser',
  'read',
  'write',
  'edit',
]);

export const TOOL_ROUTE_MAP = {
  exec:           { reason: 'exec 应由子agent执行',       suggest: 'sessions_spawn 派子agent 执行 exec' },
  web_search:     { reason: '搜索应由子agent执行',        suggest: 'sessions_spawn 派子agent 执行 web_search' },
  tavily_search:  { reason: '搜索应由子agent执行',        suggest: 'sessions_spawn 派子agent 执行 tavily_search' },
  tavily_extract: { reason: '提取应由子agent执行',        suggest: 'sessions_spawn 派子agent 执行 tavily_extract' },
  web_fetch:      { reason: '抓取应由子agent执行',        suggest: 'sessions_spawn 派子agent 执行 web_fetch' },
  browser:        { reason: '浏览器操作应由子agent执行',   suggest: 'sessions_spawn 派子agent 执行 browser' },
  read:           { reason: 'read 应由子agent执行',       suggest: 'sessions_spawn 派子agent 执行 read' },
  write:          { reason: 'write 应由子agent执行',      suggest: 'sessions_spawn 派子agent 执行 write' },
  edit:           { reason: 'edit 应由子agent执行',      suggest: 'sessions_spawn 派子agent 执行 edit' },
};

// ====== Worker 寿命上限（Worker寿命管理） ======
// 🧠 设计决策：MAX_WORKER_AGE=6h(6小时)，匹配一个工作会话的典型时长。
// 小于6小时会频繁滚动重启（浪费创建开销），大于6小时则内存泄漏风险累积增大。
export const MAX_WORKER_AGE = 6 * 3600 * 1000;   // 6小时
// ====== Worker 最大任务数（完成指定任务后自动下线置换） ======
// 🧠 设计决策：MAX_WORKER_TASKS=2000。配合6小时寿命使用，大约每小时处理330个任务。
// 防单个Worker累积过多样本导致worker.js中内存增长。2000任务≈小型批处理全天密集调度。
export const MAX_WORKER_TASKS = 2000;

// ====== Rolling Restart ======
export const ROLLING_RESTART_BATCH_RATIO = 1 / 3;  // 每次最多置换1/3 Worker
export const ROLLING_RESTART_CHECK_INTERVAL_MS = 60000; // 每min检查一次

// ====== 替换日志路径 ======
export const WORKER_REPLACEMENT_LOG = join(homedir(), '.openclaw', 'workspace', 'memory', 'logs', 'worker-replacement.log');

export const CORE_TOOLS = [
  'core_memorySearch',
  'core_webSearch',
  'core_codeEditor',
  'core_batchVision',
  'core_fileManager',
  'core_spawnWorker',
];
// 🧠 设计决策：cpu_flowRoute 是内部路由函数，不注册为公开工具。不在白名单，不注册，是专门的设计决定。

// ====== 高优任务抢占 ======
// 🧠 设计决策：PREEMPT_QUEUE_THRESHOLD=26。队列>26才触发preempt评估——
// 匹配28核全开Worker总数，当所有Worker忙碌且队列积压时触发。
// 过小（如5）会频繁preempt导致任务抖动，过大会让高优任务等待太久。
export const PREEMPT_QUEUE_THRESHOLD = 26;     // 队列 > 26 才触发preempt评估（匹配28核全开Worker总数）
// 🧠 设计决策：PREEMPT_TASK_TIMEOUT_MS=300000(5min)。被抢占任务5min不恢复则超时失效。
// 管理员从10min调到5min（见行内注释）。匹配Worker最长任务配置：60s任务超时x5倍缓冲，够Worker完成清理再重新调度。
export const PREEMPT_TASK_TIMEOUT_MS = 300000; // 被抢任务5min不恢复则超时失效（管理员从10min调到5min）
export const PREEMPT_MAX_AGE_MS = 600000;      // 抢占状态文件最大存活时间(10min)
export const PREEMPT_CHECK_INTERVAL_MS = 3000; // 3s检查一次是否需要抢占

// ====== 🔧 Worker 分化 ======
// 🧠 设计决策：ROLE_CONFIG各角色min/max 中 stemcell idleTerminateMs最大90000，因它是兜底角色，
// 任一角色(scanner/compute/router)全崩时需stemcell立即填补，不能过早终止。
// compute角色min=6占多数核心，因计算密集型任务是主负载类型。
export const ROLE_CONFIG = {
  scanner:  { min: 2, max: 4, idleTerminateMs: 60000 },
  compute:  { min: 6, max: 14, idleTerminateMs: 60000 },
  router:   { min: 2, max: 4, idleTerminateMs: 45000 },
  stemcell: { min: 2, max: 4, idleTerminateMs: 90000 },
  // 🆕 2026-06-05 新增角色：转岗制，所有空闲Worker都能互相借调
  planner:  { min: 1, max: 3, idleTerminateMs: 60000 },   // 🧩 任务分解师：复杂任务拆DAG子任务
  inspector:{ min: 1, max: 3, idleTerminateMs: 60000 },   // 🔍 质量巡检员：代码审查/安全检查/输出质量
  research: { min: 1, max: 3, idleTerminateMs: 60000 },   // 🕵️ 调研专员：多源信息检索与交叉验证
};

// 任务类型 -> 角色映射
export const TASK_TYPE_ROLE_MAP = {
  // scanner
  'search': 'scanner',
  'scan': 'scanner',
  'dialog-search': 'scanner',
  'route-quick': 'scanner',
  // compute
  'process-log': 'compute',
  'embedding': 'compute',
  'image-process': 'compute',
  'semantic-search': 'compute',
  // router
  'route-system': 'router',
  'route-intent': 'router',
  'route-capability': 'router',
  'route-strategy': 'router',
  // 🆕 planner - 任务分解师
  'decompose': 'planner',
  'route-decompose': 'planner',
  // 🆕 inspector - 质量巡检员
  'code-review': 'inspector',
  'quality-check': 'inspector',
  // 🆕 research - 调研专员
  'deep-research': 'research',
  'cross-reference': 'research',
  // misc → stemcell 兜底
  'resolve-model': 'stemcell',
  'ping': 'stemcell',
};

// 启动时的角色数量分配
export function getInitialRoleDistribution() {
  const roleDist = { scanner: 0, compute: 0, router: 0, stemcell: 0 };
  // 按 min 值分配
  for (const [role, cfg] of Object.entries(ROLE_CONFIG)) {
    roleDist[role] = cfg.min;
  }
  return roleDist;
}

/**
 * 根据当前队列情况自适应调整角色数量
 * @param {object} stats - pool.getStats()
 * @param {object} roleCounts - 当前各角色Worker数
 * @returns {object} 目标角色分配 { scanner, compute, router, stemcell }
 */
export function getAdaptiveRoleDistribution(stats, roleCounts) {
  const queueDepth = stats?.queueDepth || 0;
  const distribution = Object.fromEntries(
    Object.entries(ROLE_CONFIG).map(([role, cfg]) => [role, cfg.min])
  );

  if (queueDepth > 20) {
    // 深度排队 -> 优先扩 scanner 和 compute
    distribution.scanner = Math.min(ROLE_CONFIG.scanner.max, (roleCounts.scanner || 0) + 2);
    distribution.compute = Math.min(ROLE_CONFIG.compute.max, (roleCounts.compute || 0) + 2);
  }

  if (queueDepth > 50) {
    // 极高压力 -> 拉满 scanner 到上限
    distribution.scanner = ROLE_CONFIG.scanner.max;
    distribution.compute = Math.min(ROLE_CONFIG.compute.max, ROLE_CONFIG.compute.min + 10);
  }

  // stemcell 始终保留至少 2 个做兜底
  distribution.stemcell = Math.max(ROLE_CONFIG.stemcell.min, distribution.stemcell || 0);

  return distribution;
}

// ====== 🌊 本能式分流策略（flow-router.js）配置常量 ======
// 🧠 设计决策：FLOW_ROUTER_CONFIG 各项参数——sigmoidSteepness=2.0(统一折中值，详见fix-comment-bugs-2026-06-02),
// feedforwardBaseMs=2000(2s前馈基准匹配avg工具调用耗时),habituationMaxEntries=200(防记忆膨胀)。
// 整套配置是本能式分流策略的超参数，调优来自用户实测。
export const FLOW_ROUTER_CONFIG = {
  sigmoidSteepness: 2.0,   // 🧠 2.0 折中值——与 flow-router.js DEFAULT_CONFIG 对齐（原 constants.js=1.5, flow-router.js=2.5）。
                         // 1.5 偏软化（快慢路径区分模糊），2.5 偏果断（二值化）。
                         // 2.0 刚好是metabolic rate系统设计值，既保留S 形曲线的渐进过渡，又能清晰区分快/慢路径。
                         // 统一配置源见 fix-comment-bugs-2026-06-02。
  sigmoidMidpoint: 0.45,
  sigmoidDecayRate: 0.92,
  feedforwardBaseMs: 2000,
  adaptThreshold: 1.5,
  adaptMinIntervalMs: 5000,
  habituationMaxEntries: 200,
  habituationWeightDecay: 0.95,
  habituationMinWeight: 0.1,
  raceTimeoutMs: 15000,
  raceMinComplexity: 3,
  flowWorkerIdleBoost: 2.0,
  flowWorkerBusyPenalty: 0.3,
};

// ====== 负载模式预测（traffic-patterns.js）配置常量 ======
// 🧠 设计决策：TRAFFIC_WINDOW_MIN=15(15min窗口)，平衡粒度与平滑度。
// 太细(5min)噪声大，太粗(60min)无法捕捉小时级变化。7天滚动刚好覆盖一个完整工作周。
// TRAFFIC_WEIGHT_DECAY_RATE=0.85确保旧模式每窗口衰减15%，TRAFFIC_WEIGHT_BOOST_RATE=1.15（管理员从1.05调到1.15，更快收敛）。
export const TRAFFIC_PATTERNS_DIR = join(homedir(), '.openclaw', 'workspace', 'memory', 'traffic-patterns');
export const TRAFFIC_WINDOW_MIN = 15;
export const TRAFFIC_ROLLING_DAYS = 7;
export const TRAFFIC_PREDICTION_LEAD_MIN = 5;
export const TRAFFIC_MAX_SNAPSHOTS_PER_DAY = 96; // 24h / 15min
export const TRAFFIC_WEIGHT_DECAY_RATE = 0.85;  // 旧模式权重衰减率：每个15min窗口衰减到0.85
export const TRAFFIC_WEIGHT_BOOST_RATE = 1.15; // 最新流量模式权重提升系数（管理员从1.05调到1.15，更快收敛）

// ====== 有限理性搜索阈值（cpu_search 早停） ======
// 搜索达到足够匹配数后不再继续搜剩余文件，节约I/O和CPU
export const SEARCH_MIN_RESULTS = 20;

// ====== 🧬 metabolic rate精细调节（连续插值0.2-1.0） ======
export const METABOLIC_RATE_MIN = 0.2;
export const METABOLIC_RATE_MAX = 1.0;
export const METABOLIC_RATE_DEFAULT = 0.5;
export const METABOLIC_RATE_ADJUST_STEP = 0.05;
export const METABOLIC_RATE_INTERVAL_MS = 15000;

// 🧠 设计决策：METABOLIC_WEIGHTS 包含4个参数（memory/queue/heartbeat/userActive）。用户活跃权重0.15从其他参数均摊。
// 用户活跃时降metabolic rate（让出CPU给聊天），不活跃时升metabolic rate（更激进后台处理）。
export const METABOLIC_WEIGHTS = {
  memory: 0.40,
  queue: 0.28,
  heartbeat: 0.17,
  userActive: 0.15,
};

// 🧠 设计决策：METABOLIC_SMOOTH_POINTS 定义插值锚点。
// 任意metabolic rate值取相邻两点线性插值，不再离散4档。
// 0.2=休息 0.5=均衡 0.8=专注 1.0=战斗
export const METABOLIC_SMOOTH_POINTS = [
  { rate: 0.2, minWorkers: 4,  maxWorkers: 6,  cacheMult: 3.0, rateMult: 0.5, cacheDisabled: false },
  { rate: 0.35, minWorkers: 4, maxWorkers: 8, cacheMult: 2.0, rateMult: 0.75, cacheDisabled: false },
  { rate: 0.5, minWorkers: 4,  maxWorkers: 28, cacheMult: 1.0, rateMult: 1.0, cacheDisabled: false },
  { rate: 0.8, minWorkers: 8,  maxWorkers: 26, cacheMult: 0.5, rateMult: 1.5, cacheDisabled: false },
  { rate: 1.0, minWorkers: 10, maxWorkers: 28, cacheMult: 0.3, rateMult: 2.0, cacheDisabled: true },
];

// 用户活跃检测超时（连续20min无消息判定为离线）
export const USER_ACTIVE_TIMEOUT_MS = 20 * 60 * 1000;

// 对话日记路径，用于判断用户是否在线
export const DIALOG_DIR = join(homedir(), '.openclaw', 'workspace', 'memory', 'dialog');
