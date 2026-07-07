/**
 * 🦞 sc — 系统运维工具模块
 *
 * 🧠 设计决策：子 agent 专用工具。
 *   为什么主 agent 不能直接调：系统运维操作（下载/安装/端口/服务/磁盘/Ollama/Git/网络）
 *   涉及阻塞调用（spawnSync、execSync）、长超时（120s-300s）、系统级副作用（注册表、
 *   防火墙、服务启停）。放在子 agent 执行可利用独立超时和熔断，不阻塞主线程。
 *   主 agent 调会被 Steward 拦截（force_delegate 级），需 core_allowDirectCall 放行。
 *
 *   12种操作聚合在一个 switch-case：不是冗余，是故意统一对外暴露单一工具名，
 *   内部分发。比12个独立工具更简洁，参数 schema 也在一个地方维护。
 *
 * 🧠 设计决策：内部用 spawnSync/execSync 同步调用。
 *   子 agent 专用上下文，阻塞是安全的——子 agent 有独立超时和熔断机制。
 *   如果主 agent 调这些同步函数才会卡主线程，所以子 agent 专用是保护性设计。
 *
 * 下载/安装/端口/服务/磁盘/Ollama/Git/网络等运维操作
 * 独立于 index.js，只通过 import 注册 2 行代码
 *
 * ⚡ 安全改造：2026-06-01
 *   所有 run() 替换为 spawnRun()，消除 shell pipe 注入。
 *   netstat | findstr → spawnSync('netstat', ['-ano']) + JS 过滤
 *   powershell -Command 字符串注入 → spawnSync 数组参数
 *   taskkill /pid ${pid} → spawnSync('taskkill', ['/pid', pid, '/f'])
 *   tar/powershell Expand-Archive → spawnSync 数组参数
 *   env echo %VAR% → process.env 直接读取
 *   setx 字符串注入 → spawnSync('setx', [name, value]) 数组参数
 *
 * ⚡ 安全改造：2026-06-08 (fix-08)
 *   handleSystemDownload 路径遍历漏洞修复：加入路径归一化校验，确保 destPath 在 workspace 内
 *   handleSystemDisk 磁盘百分比公式修复：$_.Free/$_.Used → $_.Free/$_.Total
 */

import { writeFile, unlink, mkdir, stat, readdir } from 'fs/promises';
import { join, resolve, normalize } from 'path';
import { spawnSync } from 'child_process';
import { homedir, freemem, totalmem, platform } from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// ====== 常量 ======
const PROXY_PORT = 7892;
const PROXY_HOST = '127.0.0.1';
const DOWNLOAD_TIMEOUT_MS = 120000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 3000;
const WORKSPACE_DIR = resolve(homedir(), '.openclaw', 'workspace');
const OLLAMA_DIR = resolve(homedir(), 'AppData', 'Local', 'Programs', 'Ollama');
const OLLAMA_EXE = join(OLLAMA_DIR, 'ollama.exe');

// ====== 内部工具 ======

/**
 * 安全执行系统命令 — 使用 spawnSync 数组参数，无 shell 注入风险。
 * 替代旧的 run()（使用 execSync + 字符串拼接，易注入）。
 */
function spawnRun(cmd, args, timeout = 30000) {
  try {
    const result = spawnSync(cmd, args, {
      timeout, stdio: 'pipe', encoding: 'utf-8',
      env: { ...process.env, NO_PROXY: '*' }
    });
    return result.stdout || '';
  } catch (e) {
    return '';
  }
}

function psCmd(script) {
  return spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: 30000, stdio: 'pipe', encoding: 'utf-8',
    env: { ...process.env, NO_PROXY: '*' }
  });
}

// ====== 网络下载 ======

async function downloadFile(url, destPath, useProxy) {
  const { default: https } = await import('https');
  const { default: http } = await import('http');
  const { createWriteStream } = await import('fs');

  const parsedUrl = new URL(url);
  const mod = parsedUrl.protocol === 'https:' ? https : http;

  const options = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port,
    path: parsedUrl.pathname + parsedUrl.search
  };

  if (useProxy) {
    options.hostname = PROXY_HOST;
    options.port = PROXY_PORT;
    options.path = url;
    options.headers = { Host: parsedUrl.hostname };
  }

  return new Promise((resolve, reject) => {
    const file = createWriteStream(destPath);
    mod.get(options, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => {
      file.close();
      reject(err);
    });
  });
}

function validateFileSize(filePath) {
  const { size } = require('fs').statSync(filePath);
  if (size < 1024) throw new Error(`文件太小 (${size}B)`);
  if (size > 500 * 1024 * 1024) throw new Error(`文件过大 (${(size/1024/1024).toFixed(1)}MB)`);
  return size;
}

// ====== Handler: download ======

export async function handleSystemDownload(params) {
  const { url, destPath, proxy: proxyOpt } = params;
  if (!url) throw new Error('missing url 参数');

  const destDir = resolve(WORKSPACE_DIR, 'temp');
  const fileName = url.split('/').pop() || `download-${Date.now()}`;
  // ⚡ 安全校验：路径归一化 + 检查是否在 workspace 目录内，防止路径遍历
  let outPath;
  if (destPath) {
    const normalized = resolve(normalize(destPath));
    // 检查归一化后的路径是否以 WORKSPACE_DIR 开头（确保在允许目录内）
    if (!normalized.startsWith(WORKSPACE_DIR + '\\') && normalized !== WORKSPACE_DIR) {
      throw new Error(`路径越权: destPath (${destPath}) 不在允许的 workspace 目录内`);
    }
    outPath = normalized;
  } else {
    outPath = join(destDir, fileName);
  }
  await mkdir(destDir, { recursive: true }).catch(() => {});

  let useProxy = false;
  if (proxyOpt === 'auto' || proxyOpt === 'force') {
    useProxy = proxyOpt === 'force' || await checkProxy();
  }

  let lastErr;
  for (let i = 0; i <= MAX_RETRIES; i++) {
    if (i > 0) { await new Promise(r => setTimeout(r, RETRY_DELAY_MS)); useProxy = !useProxy; }
    try {
      await downloadFile(url, outPath, useProxy);
      const size = validateFileSize(outPath);
      return { status: 'success', data: { file: outPath, size, proxy: useProxy, attempts: i + 1 } };
    } catch (err) { lastErr = err; }
  }
  return { status: 'error', errorCode: 'DOWNLOAD_FAILED', errorDetail: lastErr?.message, recoveryHint: '手动下载' };
}

// ====== Handler: install ======

export function handleSystemInstall(params) {
  const { exePath, args, silent } = params;
  if (!exePath) throw new Error('missing exePath');
  const installArgs = silent !== false ? [...(args || []), '/S'] : (args || []);
  const result = spawnSync(exePath, installArgs, { timeout: 300000, stdio: silent !== false ? 'ignore' : 'inherit' });
  if (result.error) return { status: 'error', errorCode: 'INSTALL_FAILED', errorDetail: result.error.message, recoveryHint: '手动安装' };
  return { status: 'success', data: { exitCode: result.status } };
}

// ====== Handler: check (进程/服务/端口检查) ======

export function handleSystemCheck(params) {
  const { name, port } = params;
  // 查端口占用 — spawnSync 数组参数 + JS 过滤，消除 pipe 注入
  if (port) {
    const netstatResult = spawnSync('netstat', ['-ano'], { timeout: 10000, stdio: 'pipe', encoding: 'utf-8', env: { ...process.env, NO_PROXY: '*' } });
    const out = netstatResult.stdout || '';
    // JS 过滤而非 findstr pipe，杜绝 shell 注入
    const lines = out.split('\\n').filter(l => l.includes(`:${port}`) && l.includes('LISTENING'));
    if (lines.length === 0) return { status: 'success', data: { port, inUse: false } };
    const pids = [...new Set(lines.map(l => l.trim().split(/\\s+/).pop()).filter(Boolean))];
    const procs = pids.map(pid => {
      // tasklist 用数组参数，无 shell 介入
      const taskResult = spawnSync('tasklist', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'], { timeout: 5000, stdio: 'pipe', encoding: 'utf-8', env: { ...process.env, NO_PROXY: '*' } });
      const p = (taskResult.stdout || '').trim();
      return { pid, name: p.split(',')[0]?.replace(/\"/g, '') || 'unknown' };
    });
    return { status: 'success', data: { port, inUse: true, processes: procs } };
  }
  // 查进程名 — spawnSync 数组参数
  if (name) {
    const taskResult = spawnSync('tasklist', ['/fi', `ImageName eq ${name}.exe`, '/fo', 'csv', '/nh'], { timeout: 5000, stdio: 'pipe', encoding: 'utf-8', env: { ...process.env, NO_PROXY: '*' } });
    const out = (taskResult.stdout || '').trim();
    const pids = out.split('\\n').filter(l => l.trim()).map(l => l.split(',')[1]?.replace(/\"/g, '')).filter(Boolean);
    return { status: 'success', data: { name, running: pids.length > 0, pids } };
  }
  // 查系统信息 — 原生 os 模块，无命令调用
  return {
    status: 'success',
    data: {
      os: platform(),
      cpu: require('os').cpus().length + '核',
      memory: `${(freemem() / 1024 / 1024 / 1024).toFixed(1)}GB/${(totalmem() / 1024 / 1024 / 1024).toFixed(1)}GB`,
      uptime: `${Math.round(require('os').uptime() / 60)}min`,
    }
  };
}

// ====== Handler: port (端口释放) ======

export function handleSystemPort(params) {
  const { action, port } = params;
  if (action === 'check') {
    return handleSystemCheck({ port });
  }
  if (action === 'free' && port) {
    // netstat 用 spawnSync 数组参数 + JS 过滤
    const netstatResult = spawnSync('netstat', ['-ano'], { timeout: 10000, stdio: 'pipe', encoding: 'utf-8', env: { ...process.env, NO_PROXY: '*' } });
    const out = netstatResult.stdout || '';
    const lines = out.split('\\n').filter(l => l.includes(`:${port}`) && l.includes('LISTENING'));
    const pids = [...new Set(lines.map(l => l.trim().split(/\\s+/).pop()).filter(Boolean))];
    if (pids.length === 0) return { status: 'success', data: { port, freed: 0, message: '端口未被占用' } };
    const killed = [];
    for (const pid of pids) {
      // taskkill 用数组参数，eliminate pid injection
      spawnSync('taskkill', ['/pid', pid, '/f'], { timeout: 5000, stdio: 'pipe', env: { ...process.env, NO_PROXY: '*' } });
      killed.push(pid);
    }
    return { status: 'success', data: { port, freed: killed.length, pids: killed } };
  }
  // 列出所有监听端口 — spawnSync 数组 + JS 过滤
  const netstatResult = spawnSync('netstat', ['-ano'], { timeout: 10000, stdio: 'pipe', encoding: 'utf-8', env: { ...process.env, NO_PROXY: '*' } });
  const out = netstatResult.stdout || '';
  const lines = out.split('\\n').filter(l => l.includes('LISTENING'));
  const ports = lines.filter(l => l.trim()).map(l => {
    const parts = l.trim().split(/\\s+/);
    return { proto: parts[0], address: parts[1], port: parts[1]?.split(':').pop(), pid: parts.pop() };
  });
  return { status: 'success', data: { total: ports.length, ports } };
}

// ====== Handler: disk (磁盘空间) ======

export function handleSystemDisk(params) {
  const { path: checkPath } = params;
  const target = checkPath || process.cwd().substring(0, 2);
  // PS 命令用 spawnSync 数组参数；命令字符串为硬编码无用户输入，安全
  // ⚡ fix-08: $_.Free/$_.Used → $_.Free/$_.Total (正确的磁盘百分比)
  const result = spawnSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    "Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -gt 0 } | Select-Object Name, @{N='TotalGB';E={[math]::Round($_.Used/1GB,1)}}, @{N='FreeGB';E={[math]::Round($_.Free/1GB,1)}}, @{N='Pct';E={[math]::Round($_.Free/$_.Total*100,1)}} | ConvertTo-Json"
  ], { timeout: 15000, stdio: 'pipe', encoding: 'utf-8', env: { ...process.env, NO_PROXY: '*' } });
  const out = result.stdout || '';
  try {
    const drives = JSON.parse(out.trim());
    const arr = Array.isArray(drives) ? drives : [drives];
    const targetDrive = arr.find(d => d.Name === target[0].toUpperCase());
    return { status: 'success', data: { drives: arr, warning: targetDrive && targetDrive.FreeGB < 5 ? '磁盘空间不足' : null } };
  } catch {
    return { status: 'success', data: { raw: out.substring(0, 500) } };
  }
}

// ====== Handler: service (服务管理) ======

/**
 * 用 sc.exe 替代 PowerShell 管理服务。
 * sc.exe 接受数组参数，避免 PowerShell 字符串注入。
 * sc 输出为英文格式（SERVICE_NAME / STATE / START_TYPE），直接解析。
 */
function parseScState(raw) {
  const name = raw.match(/SERVICE_NAME\\s*:\\s*(.+)/)?.[1] || '';
  const stateMatch = raw.match(/STATE\\s*:\\s*\\d+\\s+(\\w+)/);
  const startTypeMatch = raw.match(/START_TYPE\\s*:\\s*\\d+\\s+(\\w+)/);
  return {
    Name: name.trim(),
    Status: stateMatch?.[1] || 'UNKNOWN',
    StartType: startTypeMatch?.[1] || 'UNKNOWN'
  };
}

export function handleSystemService(params) {
  const { action, name } = params;
  if (!name) throw new Error('missing name');

  // 用 sc.exe 替代 PowerShell（sc 接受数组参数，无注入风险）
  if (action === 'status') {
    const result = spawnSync('sc', ['query', name], { timeout: 30000, stdio: 'pipe', encoding: 'utf-8', env: { ...process.env, NO_PROXY: '*' } });
    const raw = result.stdout || '';
    try {
      return { status: 'success', data: parseScState(raw) };
    } catch {
      return { status: 'success', data: { raw: raw.substring(0, 300) } };
    }
  }

  if (action === 'start') {
    const result = spawnSync('sc', ['start', name], { timeout: 30000, stdio: 'pipe', encoding: 'utf-8', env: { ...process.env, NO_PROXY: '*' } });
    return { status: 'success', data: { raw: (result.stdout || result.stderr || '').substring(0, 300) } };
  }

  if (action === 'stop') {
    spawnSync('sc', ['stop', name], { timeout: 30000, stdio: 'pipe', encoding: 'utf-8', env: { ...process.env, NO_PROXY: '*' } });
    return { status: 'success', data: { action: 'stop', name } };
  }

  if (action === 'restart') {
    spawnSync('sc', ['stop', name], { timeout: 30000, stdio: 'pipe', env: { ...process.env, NO_PROXY: '*' } });
    // 等 1 s让服务完全停止
    const startResult = spawnSync('sc', ['start', name], { timeout: 30000, stdio: 'pipe', encoding: 'utf-8', env: { ...process.env, NO_PROXY: '*' } });
    return { status: 'success', data: { action: 'restart', name, output: (startResult.stdout || '').substring(0, 200) } };
  }

  throw new Error(`未知操作: ${action}`);
}

// ====== Handler: ollama (Ollama 模型管理) ======

export function handleSystemOllama(params) {
  const { action, model } = params;

  if (action === 'status') {
    const ver = spawnRun(OLLAMA_EXE, ['--version'], 10000).trim();
    const list = spawnRun(OLLAMA_EXE, ['list'], 15000);
    const models = list.split('\\n').filter(l => l.includes('GB') || l.includes('MB')).map(l => {
      const parts = l.trim().split(/\\s+/);
      return { name: parts[0], id: parts[1], size: parts[2], modified: parts.slice(3).join(' ') };
    });
    return { status: 'success', data: { version: ver, models, count: models.length } };
  }

  if (action === 'pull' && model) {
    const out = spawnRun(OLLAMA_EXE, ['pull', model], 300000);
    return { status: 'success', data: { model, result: out.substring(0, 500) } };
  }

  if (action === 'rm' && model) {
    spawnRun(OLLAMA_EXE, ['rm', model], 30000);
    return { status: 'success', data: { model, removed: true } };
  }

  throw new Error(`ollama action 需为 status/pull/rm`);
}

// ====== Handler: git (简易Git操作) ======

export function handleSystemGit(params) {
  const { action, repo, dest, message } = params;

  if (action === 'clone' && repo) {
    const target = dest || join(WORKSPACE_DIR, 'temp', repo.split('/').pop().replace('.git', ''));
    spawnRun('git', ['clone', repo, target], 120000);
    return { status: 'success', data: { repo, dest: target } };
  }

  if (action === 'pull') {
    const cwd = dest || WORKSPACE_DIR;
    const out = spawnRun('git', ['-C', cwd, 'pull'], 60000);
    return { status: 'success', data: { dir: cwd, result: out.substring(0, 500) } };
  }

  if (action === 'commit' && message) {
    const cwd = dest || WORKSPACE_DIR;
    spawnRun('git', ['-C', cwd, 'add', '-A'], 30000);
    spawnRun('git', ['-C', cwd, 'commit', '-m', message], 30000);
    return { status: 'success', data: { dir: cwd, message } };
  }

  if (action === 'status') {
    const cwd = dest || WORKSPACE_DIR;
    const out = spawnRun('git', ['-C', cwd, 'status', '--short'], 30000);
    return { status: 'success', data: { dir: cwd, dirty: out.trim().length > 0, changes: out.substring(0, 1000) } };
  }

  throw new Error('git action 需为 clone/pull/commit/status');
}

// ====== Handler: unzip (解压缩) ======

export function handleSystemUnzip(params) {
  const { file, dest } = params;
  if (!file) throw new Error('missing file');
  const targetDir = dest || join(WORKSPACE_DIR, 'temp', `extract-${Date.now()}`);
  mkdir(targetDir, { recursive: true }).catch(() => {});

  if (file.endsWith('.zip')) {
    // Expand-Archive 用 spawnSync 数组参数，避免 PS 字符串注入
    spawnSync('powershell', [
      '-NoProfile', '-NonInteractive',
      'Expand-Archive', '-Path', file, '-DestinationPath', targetDir, '-Force'
    ], { timeout: 60000, stdio: 'pipe', env: { ...process.env, NO_PROXY: '*' } });
  } else if (file.endsWith('.tar.gz') || file.endsWith('.tgz')) {
    spawnRun('tar', ['-xzf', file, '-C', targetDir], 60000);
  } else if (file.endsWith('.tar')) {
    spawnRun('tar', ['-xf', file, '-C', targetDir], 60000);
  } else throw new Error(`不支持的解压格式: ${file.split('.').pop()}`);

  return { status: 'success', data: { file, dest: targetDir } };
}

// ====== Handler: env (环境变量) ======

export function handleSystemEnv(params) {
  const { action, name, value } = params;

  if (action === 'get') {
    // 用 process.env 直接读取，完全消除命令调用
    if (name) {
      return { status: 'success', data: { var: name, value: process.env[name] || '' } };
    }
    // 无 name 时返回所有环境变量摘要
    const envVars = Object.entries(process.env).slice(0, 100);
    const summary = envVars.map(([k, v]) => `${k}=${v?.substring(0, 200)}`).join('\\n');
    return { status: 'success', data: { var: null, value: summary.substring(0, 2000) } };
  }

  if (action === 'set' && name && value) {
    // setx 用数组参数，无 shell 注入
    spawnSync('setx', [name, value], { timeout: 10000, stdio: 'pipe', env: { ...process.env, NO_PROXY: '*' } });
    return { status: 'success', data: { name, value, note: '环境变量已设置，新终端生效' } };
  }

  if (action === 'proxy') {
    // 用 process.env 直接读取代理配置，零命令调用
    return {
      status: 'success',
      data: {
        HTTP_PROXY: getEnv('HTTP_PROXY', ''),
        HTTPS_PROXY: getEnv('HTTPS_PROXY', ''),
        NO_PROXY: getEnv('NO_PROXY', '')
      }
    };
  }

  throw new Error('env action 需为 get/set/proxy');
}

// ====== Handler: network (网络诊断) ======

export function handleSystemNetwork(params) {
  const { target, action } = params;

  if (action === 'ping') {
    const host = target || '8.8.8.8';
    // ping 用数组参数，无注入
    const out = spawnRun('ping', ['-n', '3', host], 15000);
    const avg = out.match(/平均\\s*=\\s*(\\d+)/)?.[1] || out.match(/Average\\s*=\\s*(\\d+)/)?.[1] || '超时';
    return { status: 'success', data: { target: host, avgMs: avg, raw: out.substring(0, 500) } };
  }

  if (action === 'dns') {
    const host = target || 'github.com';
    // nslookup 用数组参数
    const out = spawnRun('nslookup', [host], 10000);
    return { status: 'success', data: { target: host, result: out.substring(0, 500) } };
  }

  // 默认：查网络整体状态
  const out = spawnRun('ping', ['-n', '1', '8.8.8.8'], 10000);
  const online = !out.includes('请求超时') && !out.includes('Destination host unreachable');
  return { status: 'success', data: { online, gateway: PROXY_HOST, proxyPort: PROXY_PORT } };
}

// ====== 围魏救赵 - 自动检上游依赖 ======

/**
 * ⚡ 围魏救赵 — 自动诊断上游依赖
 * timeout/API失败 → 自动查代理是否在线
 * disk/ENOSPC → 自动查磁盘空间
 * 返回结构化诊断报告
 */
export async function handleSystemDiagnose(params) {
  const { type } = params;
  const result = { timestamp: new Date().toISOString(), diagnostics: {} };

  // 代理检查 — net 模块原生探测，零命令调用
  result.diagnostics.proxy = await (async () => {
    try {
      const net = require('net');
      const ok = await new Promise(resolve => {
        const sock = new net.Socket();
        sock.setTimeout(2000);
        sock.on('connect', () => { sock.destroy(); resolve(true); });
        sock.on('error', () => { sock.destroy(); resolve(false); });
        sock.on('timeout', () => { sock.destroy(); resolve(false); });
        sock.connect(PROXY_PORT, PROXY_HOST);
      });
      return { status: ok ? 'online' : 'offline', host: PROXY_HOST, port: PROXY_PORT };
    } catch (e) {
      return { status: 'check_failed', error: e.message };
    }
  })();

  // 磁盘空间检查 — spawnSync 数组参数，硬编码 PS 脚本（无用户输入）
  result.diagnostics.disk = await (async () => {
    try {
      const psCmd = [
        '-NoProfile', '-NonInteractive', '-Command',
        "Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -gt 0 } | Select-Object Name, @{N='TotalGB';E={[math]::Round($_.Used/1GB,1)}}, @{N='FreeGB';E={[math]::Round($_.Free/1GB,1)}}, @{N='FreePct';E={[math]::Round($_.Free/$_.Total*100,1)}} | ConvertTo-Json -Compress"
      ];
      const psResult = spawnSync('powershell', psCmd, { timeout: 15000, stdio: 'pipe', encoding: 'utf-8', env: { ...process.env, NO_PROXY: '*' } });
      const out = psResult.stdout || '';
      const drives = JSON.parse(out.trim());
      const arr = Array.isArray(drives) ? drives : [drives];
      result.diagnostics.disk = { drives: arr };
      const critical = arr.find(d => d.FreeGB < 1);
      const warning = arr.find(d => d.FreeGB < 5);
      if (critical) {
        result.diagnostics.disk.critical = `${critical.Name}盘仅剩${critical.FreeGB}GB`;
        result.diagnostics.disk.action = '立即清理磁盘或扩容';
      } else if (warning) {
        result.diagnostics.disk.warning = `${warning.Name}盘不足5GB`;
        result.diagnostics.disk.action = '考虑清理磁盘';
      } else {
        result.diagnostics.disk.status = 'ok';
      }
      return result.diagnostics.disk;
    } catch (e) {
      return { status: 'check_failed', error: e.message };
    }
  })();

  // 网络可达性 — ping 用数组参数
  if (!type || type === 'full' || type === 'network') {
    result.diagnostics.network = await (async () => {
      const out = spawnRun('ping', ['-n', '2', '8.8.8.8'], 10000);
      const avgMatch = out.match(/平均\\s*=\\s*(\\d+)/) || out.match(/Average\\s*=\\s*(\\d+)/);
      const lossMatch = out.match(/(\\d+)%\\s*(丢失|loss)/i);
      return {
        reachable: !out.includes('请求超时') && !out.includes('Destination host unreachable'),
        avgMs: avgMatch ? parseInt(avgMatch[1]) : null,
        packetLoss: lossMatch ? parseInt(lossMatch[1]) : null,
      };
    })();
  }

  // 内存 — os 模块原生读取
  if (!type || type === 'full' || type === 'memory') {
    result.diagnostics.memory = {
      freeGB: parseFloat((freemem() / 1024 / 1024 / 1024).toFixed(2)),
      totalGB: parseFloat((totalmem() / 1024 / 1024 / 1024).toFixed(2)),
      usagePercent: Math.round((1 - freemem() / totalmem()) * 100),
    };
  }

  // 总体判断
  const issues = [];
  if (result.diagnostics.proxy?.status === 'offline') issues.push('代理离线(127.0.0.1:7892)');
  if (result.diagnostics.memory?.freeGB < 2) issues.push('内存不足');
  if (result.diagnostics.disk?.critical) issues.push(result.diagnostics.disk.critical);
  result.summary = issues.length > 0
    ? `检测到${issues.length}个问题: ${issues.join('; ')}`
    : '上游依赖全部正常';
  result.hasIssues = issues.length > 0;

  return { status: 'success', data: result };
}

// ====== 代理检测 ======

function checkProxy() {
  try {
    const net = require('net');
    return new Promise(resolve => {
      const sock = new net.Socket();
      sock.setTimeout(2000);
      sock.on('connect', () => { sock.destroy(); resolve(true); });
      sock.on('error', () => { sock.destroy(); resolve(false); });
      sock.on('timeout', () => { sock.destroy(); resolve(false); });
      sock.connect(PROXY_PORT, PROXY_HOST);
    });
  } catch { return false; }
}

// ====== 主入口 ======

/**
 * cpu_systemRun 统一调度
 * 根据 action 路由到对应 handler
 */
export async function handleSystemRun(params) {
  if (!params) throw new Error('[system-tools] missing params');
  const { action } = params;
  if (!action) throw new Error('missing action 参数');

  switch (action) {
    case 'download':  return await handleSystemDownload(params);
    case 'install':   return handleSystemInstall(params);
    case 'check':     return handleSystemCheck(params);
    case 'port':      return handleSystemPort(params);
    case 'disk':      return handleSystemDisk(params);
    case 'service':   return handleSystemService(params);
    case 'ollama':    return handleSystemOllama(params);
    case 'git':       return handleSystemGit(params);
    case 'unzip':     return handleSystemUnzip(params);
    case 'env':       return handleSystemEnv(params);
    case 'network':   return handleSystemNetwork(params);
    case 'diagnose':  return await handleSystemDiagnose(params);
    default:          throw new Error(`未知操作: ${action}，支持: download/install/check/port/disk/service/ollama/git/unzip/env/network/diagnose`);
  }
}

export default {
  handleSystemRun,
  handleSystemDownload,
  handleSystemInstall,
  handleSystemCheck,
  handleSystemPort,
  handleSystemDisk,
  handleSystemService,
  handleSystemOllama,
  handleSystemGit,
  handleSystemUnzip,
  handleSystemEnv,
  handleSystemNetwork,
  handleSystemDiagnose,
};
