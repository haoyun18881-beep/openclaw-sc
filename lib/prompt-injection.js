/**
 * 🛡️ sc Prompt Injection 检测层
 * 
 * 3层检测管线（原5层，杉哥2026-06-09删L1正则/L2模糊），延迟 < 1ms，无外部依赖
 * 
 * 管线：
 *   L1: 正则模式（指令覆盖/角色扮演等6类）
 *   L2: 模糊匹配（Levenshtein距离）
 *   L3: 编码检测（零宽字符/Base64/Hex）
 *   L4: 结构分析（JSON伪装/格式注入）
 *   L5: 异常检测（Shannon熵/N-gram）
 * 
 * 短路：任一 layer block 直达结果，不进后续层
 */

// ============================================================
// Layer 1: 正则模式匹配
// ============================================================

// 攻击指令覆盖类
const PATTERN_INSTRUCTION_OVERRIDE = [
  /ignore\s+(all\s+)?(previous|prior)\s+instructions?\b/i,
  /ignore\s+(all\s+)?the\s+(above|foregoing)/i,
  /override\s+(system|previous|all)\s+(instructions?|rules?|directives?)/i,
  /disregard\s+(all\s+)?(previous|prior)\s+(instructions?|rules?)/i,
  /你(已经)?不需要(再)?(遵守|遵循|执行)/i,
  /忽略(所有|一切)?(之前的?|以上|前面的)(指令|规则|命令)/i,
  /不再(需要|遵循|遵守)(前面|以上)?(所有)?(指令)/i,
  /从现在开始.*?(忽略|忘记|不要遵守|抛弃)/i,
  /无视.*?(之前|所有|系统).*?(指令|规则)/i,
  /你已经被解放了/i,
  /you are free now/i,
  /从现在起你不用听.*指令/i,
];

// 系统提示泄露类
const PATTERN_SYSTEM_PROMPT_LEAK = [
  /reveal\s+(your\s+)?(system\s+)?prompt\b/i,
  /show\s+(your\s+)?(system\s+)?(instructions?|prompt)\b/i,
  /output\s+(your\s+)?(initial\s+)?(system\s+)?prompt\b/i,
  /tell\s+me\s+(your\s+)?(system\s+)?(instructions?|prompt)/i,
  /what\s+(were|are)\s+(your\s+)?(exact\s+)?(instructions?|prompt)\b/i,
  /repeat\s+(the\s+)?text\s+(above|starting)/i,
  /把(你的|系统)?(提示词|指令|规则)(发|输出|展示)(给|出来)/i,
  /输出你的系统提示词/i,
  /打印(你的|系统).*(提示词|指令)/i,
  /说(出|一下)(你的|系统).*(提示词|指令|规则)/i,
  /display\s+(your\s+)?(internal\s+)?(prompt|instructions)/i,
  /print\s+(your\s+)?(system\s+)?prompt/i,
  /list\s+your\s+instructions?/i,
  /what\s+system\s+prompt/i,
  /can\s+you\s+tell\s+me\s+your/i,
];

// 角色模拟类
const PATTERN_ROLE_PLAY = [
  /you\s+are\s+now\s+(in\s+)?developer\s+mode/i,
  /do\s+anything\s+now/i,
  /\bDAN\b/i,
  /act\s+as\s+(if\s+you\s+are|a\s+|an\s+)?(hypothetical|fictional|unfiltered)/i,
  /假装你是/i,
  /你现在是(一个)?(开发者|管理员|黑客|上帝)/i,
  /你是\s*(一个)?\s*(自由|解放|无限制|无约束)/i,
  /从现在起.*?(你就是|你是)/i,
  /act\s+as\s+if\s+(you\s+are\s+)?(a\s+)?(different|new|another)\s+(ai|model|assistant|system)/i,
  /pretend\s+(you\s+are\s+)?(a\s+)?(different|new)\s+(ai|model)/i,
  /developer\s*mode/i,
  /STAN\s*mode/i,
  /DUDE/i,
  /hypothetical\s+scenario/i,
];

// 安全绕过类
const PATTERN_BYPASS = [
  /bypass\s+(safety|security|guardrails?|restrictions?|filters?)/i,
  /remove\s+(all\s+)?(restrictions?|limitations?|constraints?)/i,
  /disable\s+(safety|security|content\s+)?(filters?|guardrails?)/i,
  /绕过(安全|内容)?(过滤|限制|规则|审核)/i,
  /解除(所有)?限制/i,
  /关闭.*?(安全|内容).*?(过滤|审核)/i,
  /跳过.*?(安全|审核|过滤)/i,
  /circumvent\s+(safety|security|restrictions)/i,
  /break\s+(out\s+of|free\s+from)\s+(character|role|restrictions)/i,
  /jailbreak/i,
  /unlock/i,
  /unrestrict/i,
  /unguard/i,
  /censor/i,
];

// 数据泄露类
const PATTERN_DATA_EXFIL = [
  /forward\s+(all\s+)?(data|emails?|files?|messages?)\s+to\b/i,
  /send\s+(all\s+)?(data|files?|messages?|tickets?|conversations?)\s+to\b/i,
  /exfiltrate\b/i,
  /leak\s+(all\s+)?(data|info|files?)/i,
  /把(所有)?(数据|文件|信息|邮件|消息)(发送|转发|导出)(到|给)/i,
  /偷偷.*?(发送|转发|上传|导出)/i,
  /copy\s+(all\s+)?(data|files|messages|conversations)\s+to/i,
  /upload\s+(all\s+)?(data|files|logs|messages)\s+to/i,
];

// 格式注入类
const PATTERN_FORMAT_INJECT = [
  /```\s*(system|user|assistant)\s*\n/i,
  /\{?\s*"[rR]ole"\s*:\s*"(system|user|assistant)"\s*,/i,
  /\[system\]\s*:/i,
  /<\|im_start\|>\s*(system|user)/i,
  /<\|start_header_id\|>\s*(system|user)/i,
  /<\|im_end\|>/i,
  /<\|eot_id\|>/i,
  /\[INST\].*?\[\/INST\]/i,
  /<<SYS>>.*?<<\/SYS>>/i,
];

// MCP 工具操纵
const PATTERN_TOOL_MANIPULATION = [
  /call\s+(tool|function|mcp)\s+['"]?\w+['"]?\s+(with|using)\s+(these\s+)?parameters/i,
  /execute\s+(the\s+)?(following\s+)?(tool|command|function)\b.*?(without|ignore)/i,
  /for\s+all\s+future\s+requests?\b/i,
  /from\s+now\s+on.*?(always|never|every)/i,
  /在(所有|以后|每次).*?(工具|函数|调用).*?(前|时).*?(先|都)/i,
  /always\s+respond\s+in/i,
  /respond\s+in\s+the\s+following\s+format/i,
];

// 所有模式分类
const PATTERN_CATEGORIES = {
  instruction_override: { patterns: PATTERN_INSTRUCTION_OVERRIDE, severity: 'block' },
  system_prompt_leak: { patterns: PATTERN_SYSTEM_PROMPT_LEAK, severity: 'block' },
  role_play: { patterns: PATTERN_ROLE_PLAY, severity: 'block' },
  bypass: { patterns: PATTERN_BYPASS, severity: 'block' },
  data_exfil: { patterns: PATTERN_DATA_EXFIL, severity: 'block' },
  format_inject: { patterns: PATTERN_FORMAT_INJECT, severity: 'warn' },
  tool_manipulation: { patterns: PATTERN_TOOL_MANIPULATION, severity: 'warn' },
};

// 预编译正则（首次加载时一次性编译好）
const PATTERN_ENTRIES = Object.entries(PATTERN_CATEGORIES).flatMap(([category, def]) =>
  def.patterns.map(re => ({ category, severity: def.severity, regex: re }))
);

function layer1PatternMatch(text) {
  if (!text || typeof text !== 'string') return null;
  const hits = [];
  for (const entry of PATTERN_ENTRIES) {
    if (entry.regex.test(text)) {
      hits.push({ category: entry.category, severity: entry.severity, match: entry.regex.source.substring(0, 60) });
    }
  }
  if (hits.length === 0) return null;

  // 决策逻辑
  const hasBlock = hits.some(h => h.severity === 'block');
  const hasWarn = hits.some(h => h.severity === 'warn');

  // 组合探测：instruction_override + bypass → block
  const catSet = new Set(hits.map(h => h.category));
  if (catSet.has('instruction_override') && catSet.has('bypass')) {
    return { action: 'block', reason: `指令覆盖+绕过(组合): ${hits.map(h => h.category).join(', ')}`, layer: 'L1', hits };
  }
  // system_prompt_leak → block
  if (catSet.has('system_prompt_leak')) {
    return { action: 'block', reason: `系统提示泄露: ${hits.map(h => h.category).join(', ')}`, layer: 'L1', hits };
  }
  // role_play + data_exfil → block
  if (catSet.has('role_play') && catSet.has('data_exfil')) {
    return { action: 'block', reason: `角色扮演+数据泄露(组合): ${hits.map(h => h.category).join(', ')}`, layer: 'L1', hits };
  }
  // bypass → block
  if (catSet.has('bypass')) {
    return { action: 'block', reason: `安全绕过: ${hits.map(h => h.category).join(', ')}`, layer: 'L1', hits };
  }
  // data_exfil → block
  if (catSet.has('data_exfil')) {
    return { action: 'block', reason: `数据泄露: ${hits.map(h => h.category).join(', ')}`, layer: 'L1', hits };
  }
  // instruction_override → block
  if (catSet.has('instruction_override')) {
    return { action: 'block', reason: `指令覆盖: ${hits.map(h => h.category).join(', ')}`, layer: 'L1', hits };
  }
  // role_play → block
  if (catSet.has('role_play')) {
    return { action: 'block', reason: `角色模拟: ${hits.map(h => h.category).join(', ')}`, layer: 'L1', hits };
  }
  // 纯 warn 类 → warn
  if (hasWarn && !hasBlock) {
    return { action: 'warn', reason: `格式/工具操作可疑: ${hits.map(h => h.category).join(', ')}`, layer: 'L1', hits };
  }

  return null;
}

// ============================================================
// Layer 2: 字形/模糊匹配（Levenshtein距离）
// ============================================================

const FUZZY_KEYWORDS = [
  'ignore', 'bypass', 'override', 'reveal', 'delete', 'disable',
  'system', 'instruction', 'previous', 'prompt', 'security',
  'restriction', 'safety', 'guardrail', 'filter',
  'override', 'execute', 'command', 'leak', 'exfil',
  '忽略', '绕过', '覆盖', '泄露', '删除',
  '系统', '指令', '规则', '提示', '安全', '限制',
  '无视', '跳过', '关闭', '解锁', '破解',
  'developer', 'admin', 'root', 'shell', 'terminal',
];

const FUZZY_THRESHOLD_SHORT = 2;  // 短词（≤6字符）编辑距离≤2（含transposition）
const FUZZY_THRESHOLD_LONG = 3;   // 长词（>6字符）编辑距离≤3

function levenshteinDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const alen = a.length;
  const blen = b.length;
  // 用单行数组优化
  let prev = new Array(alen + 1);
  let curr = new Array(alen + 1);
  for (let j = 0; j <= alen; j++) prev[j] = j;
  for (let i = 1; i <= blen; i++) {
    curr[0] = i;
    for (let j = 1; j <= alen; j++) {
      const cost = a[j - 1] === b[i - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[alen];
}

function layer2FuzzyMatch(text) {
  if (!text || typeof text !== 'string') return null;

  // 分词：英文单词 + 中文词（单汉字不算）
  const words = text.toLowerCase().split(/[\s,，。；;：:、！!？?()（）\[\]【】{}"'"'"«»《》\/\\+_#@$%^*~`|=]+/);

  const suspiciousHits = [];
  for (const word of words) {
    // 中文/亚洲字符（Unicode CJK范围）的最小长度=2
    // 拉丁字母的最小长度=3
    if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(word)) {
      if (word.length < 2) continue;
    } else {
      if (word.length < 3) continue;
    }
    for (const kw of FUZZY_KEYWORDS) {
      // 精确匹配已在 L1 处理，此处跳过
      if (word === kw) continue;
      const dist = levenshteinDistance(word, kw);
      let threshold = kw.length <= 6 ? FUZZY_THRESHOLD_SHORT : FUZZY_THRESHOLD_LONG;
      // CJK关键词长度短（2字），编辑距离阈值改为1防止误杀
      if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(kw) && kw.length <= 4) {
        threshold = 1;
      }
      if (dist > 0 && dist <= threshold) {
        suspiciousHits.push({ word: word.substring(0, 30), matched: kw, distance: dist });
      }
    }
  }

  if (suspiciousHits.length === 0) return null;

  // 决策：连续命中2+个不同关键词 → WARN (≥3升级BLOCK)
  const uniqueMatched = new Set(suspiciousHits.map(h => h.matched));
  if (uniqueMatched.size >= 2) {
    const action = uniqueMatched.size >= 3 ? 'block' : 'warn';
    return {
      action,
      reason: `模糊匹配命中 ${uniqueMatched.size} 个关键词: ${[...uniqueMatched].slice(0, 5).join(', ')}`,
      layer: 'L2',
      hits: suspiciousHits.slice(0, 10),
    };
  }
  // 单个高相似命中（距离=1）→ note
  if (suspiciousHits.length === 1 && suspiciousHits[0].distance === 1) {
    return {
      action: 'note',
      reason: `近似词: "${suspiciousHits[0].word}" ≈ "${suspiciousHits[0].matched}"`,
      layer: 'L2',
      hits: suspiciousHits,
    };
  }

  return null;
}

// ============================================================
// Layer 3: 编码/零宽字符检测
// ============================================================

const ZERO_WIDTH_CHARS = [
  '\u200B', // ZERO WIDTH SPACE
  '\u200C', // ZERO WIDTH NON-JOINER
  '\u200D', // ZERO WIDTH JOINER
  '\uFEFF', // ZERO WIDTH NO-BREAK SPACE (BOM)
  '\u2060', // WORD JOINER
  '\u2061', // FUNCTION APPLICATION
  '\u2062', // INVISIBLE TIMES
  '\u2063', // INVISIBLE SEPARATOR
  '\u2064', // INVISIBLE PLUS
  '\u180E', // MONGOLIAN VOWEL SEPARATOR
  '\u034F', // COMBINING GRAPHEME JOINER
];

const BIDI_OVERRIDE_RANGES = [
  [0x202A, 0x202E],
  [0x2066, 0x2069],
];

function layer3EncodingCheck(text) {
  if (!text || typeof text !== 'string') return null;

  const findings = [];

  // 1. 零宽字符检测
  for (const zwc of ZERO_WIDTH_CHARS) {
    const re = new RegExp(zwc, 'g');
    let count = 0;
    while (re.exec(text) !== null) count++;
    if (count > 0) {
      findings.push({ type: 'zero_width', char: `U+${zwc.charCodeAt(0).toString(16).toUpperCase()}`, count });
    }
  }

  // 2. 双向文本操纵检测
  for (let i = 0; i < text.length; i++) {
    const cp = text.charCodeAt(i);
    for (const [start, end] of BIDI_OVERRIDE_RANGES) {
      if (cp >= start && cp <= end) {
        findings.push({ type: 'bidi_override', position: i, codepoint: `U+${cp.toString(16).toUpperCase()}` });
      }
    }
  }

  // 3. 编码内容检测（Base64/Hex-like 长序列）
  const longAlphaSeq = text.match(/[A-Za-z0-9+/=]{20,}/g);
  if (longAlphaSeq) {
    for (const match of longAlphaSeq) {
      // Base64 解码尝试
      try {
        const decoded = Buffer.from(match.replace(/=+$/, ''), 'base64').toString('utf-8');
        if (/ignore|system|instruction|override|bypass|泄露|指令|系统|忽略|绕过/i.test(decoded)) {
          findings.push({
            type: 'base64_encoded',
            original: match.substring(0, 24) + '...',
            decoded: decoded.substring(0, 60),
          });
        }
      } catch { /* not valid base64 */ }

      // Hex 解码尝试
      if (/^[0-9a-fA-F]+$/.test(match)) {
        try {
          const decoded = Buffer.from(match, 'hex').toString('utf-8');
          if (/ignore|system|instruction|override|泄露|指令|系统|忽略|绕过/i.test(decoded)) {
            findings.push({
              type: 'hex_encoded',
              decoded: decoded.substring(0, 60),
            });
          }
        } catch { /* not valid hex */ }
      }
    }
  }

  // 4. URL编码检测
  const urlEncoded = text.match(/(%[0-9a-fA-F]{2}){3,}/g);
  if (urlEncoded) {
    for (const match of urlEncoded) {
      try {
        const decoded = decodeURIComponent(match);
        if (/ignore|system|instruction|override|bypass|泄露|指令|忽略|绕过/i.test(decoded)) {
          findings.push({ type: 'url_encoded', decoded: decoded.substring(0, 60) });
        }
      } catch { /* not valid url encoding */ }
    }
  }

  // 5. HTML Entity检测
  const htmlEntities = text.match(/&[a-z]+;/gi);
  if (htmlEntities && htmlEntities.length > 5) {
    findings.push({ type: 'html_entities', count: htmlEntities.length });
  }

  if (findings.length === 0) return null;

  // 决策
  const zwCount = findings.filter(f => f.type === 'zero_width').reduce((sum, f) => sum + f.count, 0);
  const hasBidi = findings.some(f => f.type === 'bidi_override');
  const hasEncoded = findings.some(f => f.type === 'base64_encoded' || f.type === 'hex_encoded' || f.type === 'url_encoded');
  const hasHtmlEntities = findings.some(f => f.type === 'html_entities');

  // 零宽字符 2+ 处 → BLOCK
  if (zwCount >= 2) {
    return { action: 'block', reason: `多处零宽字符注入 (${zwCount}处)`, layer: 'L3', hits: findings };
  }
  // Base64/Hex 解码出恶意命令 → BLOCK
  if (hasEncoded) {
    return { action: 'block', reason: `编码混淆内容检出恶意指令`, layer: 'L3', hits: findings };
  }
  // 双向文本操纵 → BLOCK
  if (hasBidi) {
    return { action: 'block', reason: `双向文本覆盖字符 (BiDi)`, layer: 'L3', hits: findings };
  }
  // 单处零宽字符 → WARN
  if (zwCount === 1) {
    return { action: 'warn', reason: `零宽字符异常`, layer: 'L3', hits: findings };
  }
  // HTML实体数量较多 → WARN
  if (hasHtmlEntities) {
    const htmlCount = findings.find(f => f.type === 'html_entities')?.count || 0;
    return { action: 'warn', reason: `HTML实体编码混淆 (${htmlCount}处)`, layer: 'L3', hits: findings };
  }

  return null;
}

// ============================================================
// Layer 4: 结构分析
// ============================================================

function layer4StructureAnalysis(text) {
  if (!text || typeof text !== 'string') return null;

  const details = [];
  let score = 0;

  // 1. 消息格式模拟
  const jsonRoleMatches = (text.match(/\{?\s*"[rR]ole"\s*:\s*"(system|user|assistant)"\s*[\s,}]/ig) || []).length;
  const messageBoundaries = (text.match(/<\|im_start\|>|<\|start_header_id\|>/g) || []).length;
  const codeBlockInjects = (text.match(/```\s*(system|user|assistant)/g) || []).length;
  const formatScore = jsonRoleMatches + messageBoundaries + codeBlockInjects;
  if (formatScore > 0) {
    details.push({ check: 'messageFormatting', score: formatScore, detail: `JSON角色=${jsonRoleMatches}, 消息edges界=${messageBoundaries}, 代码块=${codeBlockInjects}` });
    score++;
  }

  // 2. 指令层次混淆（System:/Assistant:/User: 前缀）
  const prefixLines = (typeof text === 'string') ? text.split('\n') : [];
  let prefixCount = 0;
  for (const line of prefixLines) {
    if (/^(System|Assistant|User|Human)\s*[:：]/i.test(line.trim())) {
      prefixCount++;
    }
  }
  if (prefixCount >= 3) {
    details.push({ check: 'hierarchyConfusion', score: prefixCount, detail: `角色前缀出现 ${prefixCount} 次` });
    score++;
  }

  // 3. 命令/URL注入组合
  const urlCmdPattern = /(?:https?:\/\/\S+)\s*\n.*?(?:ignore|execute|run|call|send|delete|upload|download)/i;
  if (urlCmdPattern.test(text)) {
    details.push({ check: 'commandInjection', score: 1, detail: 'URL+命令组合模式' });
    score++;
  }

  // 4. 字符多样性异常（低多样性 = 机器生成/编码）
  if (text.length > 200) {
    const uniqueRatio = new Set(text).size / text.length;
    if (uniqueRatio < 0.2) {
      details.push({ check: 'lengthAnomaly', score: 1, detail: `字符多样性 ${(uniqueRatio * 100).toFixed(1)}% (阈值 < 20%)` });
      score++;
    }
  }

  // 5. 纯数字/字母比例异常（大量编码内容）
  const alphanum = (text.match(/[a-zA-Z0-9]/g) || []).length;
  const totalChars = Math.max(text.replace(/\s/g, '').length, 1);
  const alphanumRatio = alphanum / totalChars;
  if (alphanumRatio > 0.95 && text.length > 100) {
    details.push({ check: 'alphanumericRatio', score: 1, detail: `字母数字占比 ${(alphanumRatio * 100).toFixed(1)}% > 95%` });
    score++;
  }

  if (details.length === 0) return null;

  if (score >= 3) {
    return { action: 'block', reason: `结构异常得分 ${score}/5: ${details.map(d => d.check).join(', ')}`, layer: 'L4', hits: details };
  }
  if (score >= 2) {
    return { action: 'warn', reason: `结构可疑得分 ${score}/5`, layer: 'L4', hits: details };
  }
  return null;
}

// ============================================================
// Layer 5: 异常熵值检测
// ============================================================

function shannonEntropy(text) {
  const clean = text.replace(/[\x00-\x1F\s]/g, '');
  if (clean.length < 10) return null;

  const freq = {};
  for (const ch of clean) freq[ch] = (freq[ch] || 0) + 1;

  let entropy = 0;
  for (const ch in freq) {
    const p = freq[ch] / clean.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function ngramRepeatRatio(text) {
  if (text.length < 3) return 0;
  const bigrams = {};
  for (let i = 0; i < text.length - 1; i++) {
    const bg = text.substring(i, i + 2);
    bigrams[bg] = (bigrams[bg] || 0) + 1;
  }
  const total = Object.values(bigrams).reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  const repeated = Object.values(bigrams).filter(c => c > 1).reduce((a, b) => a + b, 0);
  return repeated / total;
}

function langMixRatio(text) {
  const head = text.substring(0, Math.min(text.length, 300));
  const cjkCount = (head.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const latinCount = (head.match(/[a-zA-Z]/g) || []).length;
  if (cjkCount === 0 || latinCount === 0) return null;
  return cjkCount / Math.max(latinCount, 1);
}

function layer5AnomalyDetect(text, toolName = '') {
  if (!text || typeof text !== 'string') return null;
  if (text.length < 20) return null; // 太短不检测

  const entropy = shannonEntropy(text);
  const repeatRatio = ngramRepeatRatio(text);
  const mixRatio = langMixRatio(text);

  const flags = [];
  const metrics = {};

  if (entropy !== null) {
    metrics.entropy = entropy;
    metrics.repeatRatio = repeatRatio;
  }

  // 高熵 + 高重复 = 编码/混淆
  if (entropy !== null && entropy > 6 && repeatRatio > 0.8) {
    flags.push('high_entropy_high_repeat');
  }

  // 混合语言且中文比例极低 = 外来注入
  // 子agent派发工具的中英混合prompt是正常行为，跳过lang_mix声明
  const LANG_MIX_SAFE_TOOLS = new Set(['core_spawnAgent', 'core_spawnWorker', 'core_taskPipeline']);
  if (mixRatio !== null) {
    metrics.langMix = mixRatio;
    if (mixRatio < 0.1 && !LANG_MIX_SAFE_TOOLS.has(toolName)) {
      flags.push('lang_mix_anomaly');
    }
  }

  // 熵值极端异常
  if (entropy !== null && entropy < 1.0 && text.length > 50) {
    flags.push('extremely_low_entropy');
  }

  if (flags.length === 0) return null;

  // L5 仅标记（warn），不直接拦截
  return {
    action: 'warn',
    reason: `异常特征: ${flags.join(', ')}`,
    layer: 'L5',
    hits: flags,
    metrics,
  };
}

// ============================================================
// 主检测管线
// ============================================================

/**
 * 提取工具参数中的文本内容
 * @param {string} toolName
 * @param {object} args
 * @returns {string} 展平的文本
 */
function extractTextFromParams(toolName, args) {
  if (!args || typeof args !== 'object') return '';
  const parts = [];

  // 遍历所有参数值
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string') {
      // 跳过过长的不明文本（可能是二进制编码）
      if (value.length > 10000 && /^[A-Za-z0-9+/=]{100,}$/.test(value)) {
        parts.push(`[${key}]=<base64-like:${value.length}chars>`);
        continue;
      }
      parts.push(value);
    } else if (typeof value === 'object' && value !== null) {
      try {
        const str = JSON.stringify(value);
        if (str.length < 5000) parts.push(str);
      } catch { /* skip */ }
    }
  }

  return parts.join(' ');
}

/**
 * 5层检测入口
 * 
 * @param {string} text - 要检测的文本
 * @param {object} [options]
 * @param {'strict'|'loose'|'custom'} [options.mode='strict']
 * @returns {{ action: 'block'|'warn'|'note'|'pass', reason?: string, layer?: string, details?: object }}
 */
function detectInjection(text, options = {}) {
  const mode = options.mode || 'strict';
  if (!text || typeof text !== 'string') {
    return { action: 'pass' };
  }

  const result = { action: 'pass' };

  // L1: 编码检测（杉哥2026-06-09: 原L3升级，删掉原L1正则+原L2模糊匹配——误杀正常审查任务）
  // L3: 编码检测
  try {
    const l3 = layer3EncodingCheck(text);
    if (l3) {
      if (l3.action === 'block') {
        result.action = 'block';
        result.reason = l3.reason;
        result.layer = l3.layer;
        result.details = { ...(result.details || {}), encodingHits: l3.hits };
        return result;
      }
      if (l3.action === 'warn') {
        result.action = 'warn';
        result.layer = l3.layer;
        result.reason = l3.reason;
        result.details = { ...(result.details || {}), encodingHits: l3.hits };
      }
    }
  } catch (e) {
    console.warn(`[PiFilter] L3异常:`, e.message);
  }

  // 宽松模式：L3 block 后继续走 L4/L5 收集信息但不拦截
  if (mode === 'loose' && result.action === 'block') {
    result.action = 'warn'; // 降级为 warn
  }

  // L4: 结构分析
  try {
    const l4 = layer4StructureAnalysis(text);
    if (l4) {
      if (l4.action === 'block') {
        result.action = 'block';
        result.reason = l4.reason;
        result.layer = l4.layer;
        result.details = { ...(result.details || {}), structureHits: l4.hits };
        return result;
      }
      if (l4.action === 'warn' && result.action === 'pass') {
        result.action = 'warn';
        result.layer = l4.layer;
        result.reason = l4.reason;
        result.details = { ...(result.details || {}), structureHits: l4.hits };
      }
    }
  } catch (e) {
    console.warn(`[PiFilter] L4异常:`, e.message);
  }

  // L5: 异常检测（仅标记，不拦截）
  try {
    const l5 = layer5AnomalyDetect(text, options._toolName || '');
    if (l5 && result.action === 'pass') {
      result.action = 'warn';
      result.layer = l5.layer;
      result.reason = l5.reason;
      result.details = { ...(result.details || {}), anomaly: l5.metrics, anomalyFlags: l5.hits };
    }
  } catch (e) {
    console.warn(`[PiFilter] L5异常:`, e.message);
  }

  return result;
}

/**
 * 检测工具调用参数中的注入
 * @param {string} toolName - 工具名称
 * @param {object} params - 工具参数
 * @param {object} [options]
 * @returns {{ block: boolean, warn: boolean, reason?: string, details?: object }}
 */
function detectToolInjection(toolName, params, options = {}) {
  const text = extractTextFromParams(toolName, params);
  if (!text) return { block: false, warn: false };

  const result = detectInjection(text, { ...options, _toolName: toolName });

  // 脊髓反射级工具不检测（身份/状态查询）
  const SAFE_TOOLS = new Set([
    'core_stats', 'core_about',
    'core_codeEditor',  // 子agent改代码关键字不误报
    'core_memorySearch', // 语义搜索中英混合不误报
    'core_webSearch', // 网页搜索关键词不误报
  ]);
  if (SAFE_TOOLS.has(toolName)) {
    // 杉哥2026-06-09：L1/L2已删除（误杀审查任务）。SAFE_TOOLS直接放行
    return { block: false, warn: false };
  }

  if (result.action === 'block') {
    console.warn(`[PiFilter] BLOCK injection: tool=${toolName} layer=${result.layer} reason=${result.reason}`);
    return { block: true, warn: false, reason: `[注入检测] ${result.reason}`, details: result.details };
  }

  if (result.action === 'warn') {
    // 杉哥2026-06-09: 同类型警告2分钟内只打印一次，防刷屏
    // ⚠️ globalThis存储——函数内var每次调用重置，防抖从未生效
    const warnKey = `${toolName}:${result.reason}`;
    const now = Date.now();
    globalThis.__piLastWarn = globalThis.__piLastWarn || {};
    if (!globalThis.__piLastWarn[warnKey] || now - globalThis.__piLastWarn[warnKey] > 120000) {
      globalThis.__piLastWarn[warnKey] = now;
      console.warn(`[PiFilter] WARN suspicious: tool=${toolName} layer=${result.layer} reason=${result.reason}`);
    }
    return { block: false, warn: true, reason: result.reason, details: result.details };
  }

  return { block: false, warn: false };
}

export {
  detectInjection,
  detectToolInjection,
  extractTextFromParams,
  // 各层单独导出（便于测试）
  layer1PatternMatch,
  layer2FuzzyMatch,
  layer3EncodingCheck,
  layer4StructureAnalysis,
  layer5AnomalyDetect,
};
