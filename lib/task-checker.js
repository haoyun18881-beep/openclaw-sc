/**
 * 🔍 提示词质量检查 — Task Specificity Checker
 *
 * 检测子agent任务描述是否过于具体（过度约束），
 * 导致子agent不会变通、机械执行。
 *
 * 三级检测：
 *   L1 — 步骤关键词（"步骤1""首先""然后" 等）
 *   L2 — 具体命令（"exec""git clone""npm install" 等）
 *   L3 — 结构分析（步骤段落字数 vs 目标段落字数）
 *
 * checkTaskOverSpecificity(taskDescription):
 *   返回 { level: "safe"|"warn", reasons: [string], suggestion: string }
 */

// ====== L1 检测：步骤关键词 ======

/** 步骤指示词正则 */
const L1_STEP_PATTERNS = [
  // 中文步骤
  /\b步骤\s*[0-9一二三四五六七八九十零]+\b/u,
  /\b第[一二三四五六七八九十零]+步\b/u,
  // 中文顺序词
  /\b首先\b/u,
  /\b然后\b/u,
  /\b接着\b/u,
  /\b最后\b/u,
  /\b先\b[\s\S]{0,20}再\b/u,
  // 中文明确编号步骤
  /^\s*[0-9一二三四五六七八九十零]+[.、．、\s]/mu,
  /^(第一步|第二步|第三步|第四步|第五步|第六步|第七步|第八步|第九步)/mu,
  // 英文步骤
  /\b(?:first(?:ly)?|second(?:ly)?|third(?:ly)?|fourth(?:ly)?|fifth(?:ly)?)\b/i,
  /\bstep\s+[0-9]+\b/i,
  /\b(?:then|next|finally|afterwards|subsequently)\b/i,
  // 短句步骤标记
  /^\s*[0-9]+[\.\)]\s+/mu,
];

/** 过度步骤关键词计数阈值 */
const L1_THRESHOLD = 3;

/**
 * L1检测：步骤关键词
 * @param {string} text
 * @returns {string[]} 匹配到的原因列表
 */
function detectL1(text) {
  const reasons = [];
  let matchCount = 0;
  const seen = new Set();

  for (const re of L1_STEP_PATTERNS) {
    let match;
    re.lastIndex = 0;
    while ((match = re.exec(text)) !== null) {
      const kw = match[0].trim();
      if (!seen.has(kw)) {
        seen.add(kw);
        matchCount++;
      }
      // 防止无限循环
      if (match.index === re.lastIndex) re.lastIndex++;
    }
  }

  if (matchCount >= L1_THRESHOLD) {
    reasons.push(`检测到 ${matchCount} 个步骤指示词（阈值: ${L1_THRESHOLD}），可能过度指定执行步骤`);
  } else if (matchCount > 0) {
    // 少量步骤词不报 warn，但记录观察
    return reasons;
  }

  return reasons;
}

// ====== L2 检测：具体命令 ======

const L2_COMMAND_PATTERNS = [
  // Shell 命令
  /\bexec\b/,
  /\bgit\s+clone\b/,
  /\bgit\s+checkout\b/,
  /\bgit\s+pull\b/,
  /\bgit\s+push\b/,
  /\bnpm\s+install\b/,
  /\bnpm\s+run\b/,
  /\bnpx\b/,
  /\byarn\s+(add|install|run)\b/,
  /\bpip\s+install\b/,
  /\bcd\s+/,
  /\bmkdir\s+[\-p]?\s*-p\b/,
  /\btouch\s+/,
  /\brm\s+[\-rf]?\s*-rf\b/,
  /\bcp\s+[\-rf]?\s*-r\b/,
  /\bmv\s+/,
  /\bchmod\s+/,
  /\bsed\s+/,
  /\bgrep\s+/,
  /\bawk\s+/,
  /\bcat\s+/,
  /\becho\s+/,
  /\bcurl\s+/,
  /\bwget\s+/,
  // 编程操作
  /\bimport\s+\{/,
  /\brequire\s*\(/,
  /\bfs\.readFileSync\b/,
  /\bwriteFile\s*\(/,
  /\bPromise\.all\b/,
  // 路径指定
  /[A-Za-z]:\\[\\\w\-\.]+/,
  /\.\.\/|\.\//,
  // 工具调用
  /\bcpu_/,
  /\bsessions_spawn\b/,
  /\bmemory_get\b/,
  /\btavily_search\b/,
  /\bweb_fetch\b/,
  // 系统操作
  /\bStop-Process\b/,
  /\bStart-Process\b/,
  /\bGet-ChildItem\b/,
  /\bSet-Content\b/,
  /\bAdd-Content\b/,
  /\bschtasks\b/,
];

/** L2 命令检测阈值 */
const L2_THRESHOLD = 2;

/**
 * L2检测：具体命令
 * @param {string} text
 * @returns {string[]} 匹配到的原因列表
 */
function detectL2(text) {
  const reasons = [];
  let matchCount = 0;
  const seenCmds = new Set();

  for (const re of L2_COMMAND_PATTERNS) {
    let match;
    re.lastIndex = 0;
    while ((match = re.exec(text)) !== null) {
      const cmd = match[0].trim().substring(0, 30);
      if (!seenCmds.has(cmd)) {
        seenCmds.add(cmd);
        matchCount++;
      }
      if (match.index === re.lastIndex) re.lastIndex++;
    }
  }

  if (matchCount >= L2_THRESHOLD) {
    reasons.push(`检测到 ${matchCount} 个具体命令（阈值: ${L2_THRESHOLD}），可能过度指定实现方式`);
  }

  return reasons;
}

// ====== L3 结构分析 ======

/**
 * 估算段落是"步骤说明"还是"目标说明"
 * 步骤说明：含具体操作动词、编号、命令
 * 目标说明：含目标、目的、背景、需求描述
 */
function estimateParagraphType(paragraph) {
  const stepIndicators = [
    /\b步骤/u, /\b第.*步/u, /\b首先\b/u, /\b然后\b/u, /\b(?:exec|install|clone|mkdir|write|create)\b/i,
    /^\s*[0-9][\.\)]/m, /\bgit\b/, /\bnpm\b/, /\bcd \b/, /\brun\b/i, /\b执行\b/u, /\b调用\b/u,
  ];
  const goalIndicators = [
    /\b目标\b/u, /\b目的\b/u, /\b背景\b/u, /\b需求\b/u, /\b实现\b/u, /\b任务[：:]\b/u,
    /\bgoal\b/i, /\bpurpose\b/i, /\bobjective\b/i, /\boverview\b/i, /\bsummary\b/i,
    /\b的作用\b/u, /\b用于\b/u, /\b需求是\b/u, /\b需要实现\b/u,
  ];

  let stepScore = 0;
  let goalScore = 0;
  const lines = paragraph.split('\n').filter(l => l.trim());

  for (const line of lines) {
    for (const re of stepIndicators) {
      if (re.test(line)) stepScore++;
    }
    for (const re of goalIndicators) {
      if (re.test(line)) goalScore++;
    }
  }

  return { stepScore, goalScore, type: stepScore > goalScore ? 'step' : 'goal' };
}

/**
 * L3检测：步骤段落 vs 目标段落比例
 * @param {string} text
 * @returns {string[]} 原因列表
 */
function detectL3(text) {
  const reasons = [];
  const paragraphs = text.split('\n\n').filter(p => p.trim().length > 20);

  if (paragraphs.length < 2) {
    return reasons; // 单段落无法做结构比较
  }

  let stepWordCount = 0;
  let goalWordCount = 0;
  let stepParaCount = 0;
  let goalParaCount = 0;
  let totalWords = 0;

  for (const para of paragraphs) {
    const { type } = estimateParagraphType(para);
    const paraWords = para.replace(/[\s]/g, '').length; // 去空白算中文字符或有效字符

    if (type === 'step') {
      stepWordCount += paraWords;
      stepParaCount++;
    } else {
      goalWordCount += paraWords;
      goalParaCount++;
    }
    totalWords += paraWords;
  }

  if (totalWords === 0) return reasons;

  const stepRatio = stepWordCount / Math.max(totalWords, 1);
  const goalRatio = goalWordCount / Math.max(totalWords, 1);

  // 步骤段落占比超过 60% → 警告
  if (stepRatio > 0.6 && stepParaCount >= 2) {
    reasons.push(
      `步骤说明占比 ${(stepRatio * 100).toFixed(0)}%（目标说明仅 ${(goalRatio * 100).toFixed(0)}%），` +
      `任务描述偏向"怎么做"而非"做什么"`
    );
  }

  // 步骤段落数远超目标段落数
  if (stepParaCount >= 3 && (stepParaCount / Math.max(goalParaCount, 1)) > 2) {
    reasons.push(
      `步骤段落 ${stepParaCount} 段是目标段落 ${goalParaCount} 段的 ${(stepParaCount / Math.max(goalParaCount, 1)).toFixed(1)} 倍` +
      `，过度关注执行细节`
    );
  }

  return reasons;
}

// ====== 建议生成 ======

/**
 * 根据检测原因生成建议
 * @param {string[]} reasons
 * @returns {string} 建议内容
 */
function generateSuggestion(reasons) {
  if (reasons.length === 0) return '';

  const suggestions = [];

  if (reasons.some(r => r.includes('步骤指示词'))) {
    suggestions.push('减少步骤关键词（"首先""然后""步骤X"），改为描述目标而非过程');
  }
  if (reasons.some(r => r.includes('具体命令'))) {
    suggestions.push('用"使用XX工具"替代具体命令，让子agent自行选择实现方式');
  }
  if (reasons.some(r => r.includes('步骤说明占比'))) {
    suggestions.push('增加"目标/目的/背景"说明，压缩"怎么做"部分的篇幅');
  }

  if (suggestions.length > 0) {
    return '🔧 建议：' + suggestions.join('；');
  }

  return '建议减少过程指定，增加目标说明，给子agent更多自主空间';
}

// ====== 主入口 ======

/**
 * 检查任务描述是否过度具体化
 *
 * @param {string} taskDescription - 任务描述文本
 * @returns {{ level: "safe"|"warn", reasons: string[], suggestion: string }}
 *
 * level:
 *   "safe" — 不过度具体，适合子agent灵活执行
 *   "warn" — 过度具体，建议放宽约束
 *
 * reasons: 检测到的具体问题列表
 * suggestion: 改善建议（level="warn" 时有值）
 */
export function checkTaskOverSpecificity(taskDescription) {
  if (!taskDescription || typeof taskDescription !== 'string' || taskDescription.trim().length === 0) {
    return { level: 'safe', reasons: [], suggestion: '' };
  }

  const allReasons = [
    ...detectL1(taskDescription),
    ...detectL2(taskDescription),
    ...detectL3(taskDescription),
  ];

  if (allReasons.length === 0) {
    return { level: 'safe', reasons: [], suggestion: '' };
  }

  return {
    level: 'warn',
    reasons: allReasons,
    suggestion: generateSuggestion(allReasons),
  };
}
