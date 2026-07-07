/**
 * 🦞 sc v5.37.0 — 共享安全模块 (ESM)
 *
 * 统一路径白名单校验，供 Worker 线程、MCP Server、主插件三方共用。
 * 避免 MCP 直调工具绕过 Worker 层 validatePath 的安全漏洞（H-001/H-002）。
 */

import { realpath } from "fs/promises";
import { resolve, normalize, relative, isAbsolute, dirname, basename, join } from "path";
import { homedir } from "os";

// 🔧 Windows子agent兼容：homedir()在某些子进程环境中可能返回C:\root（因为HOME=/root）
// 优先用USERPROFILE（Windows最可靠），回退homedir()
function getOpenClawRoot() {
  const home = process.env.USERPROFILE || homedir();
  return resolve(home, ".openclaw");
}

// 🟡 异步初始化：realpath 解析 ~/.openclaw 真实路径
//   后续所有 validatePath 调用都等这个 Promise 完成
const ALLOWED_ROOTS_PROMISE = (async () => {
  const base = getOpenClawRoot();
  try {
    return [await realpath(base)];
  } catch (err) {
    // 🔧 空catch修复: 记录解析失败原因，降级为 resolve
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(`[security] realpath 解析 ~/.openclaw 失败: ${err?.message || '未知错误'}，降级为 resolve`);
    }
    return [resolve(base)];
  }
})();

// 🟢 TTL 缓存刷新机制（BUG-D1 修复）
// ALLOWED_ROOTS 在模块加载时只解析一次，沙箱目录移动/重命名后不刷新
// 解决方案：每 60 秒重新解析一次，同时提供 refreshAllowedRoots() 导出函数供外部手动刷新
let _cachedRoots = null;
let _cachedRootsTime = 0;
const ALLOWED_ROOTS_TTL = 60000; // 60 秒 TTL

/**
 * 获取允许的根目录列表（带 TTL 缓存）
 * 缓存有效期 60 秒，超时后自动重新解析
 * @returns {Promise<string[]>}
 */
async function getAllowedRoots() {
  const now = Date.now();
  if (_cachedRoots && (now - _cachedRootsTime) < ALLOWED_ROOTS_TTL) {
    return _cachedRoots;
  }
  // 缓存过期或未初始化，重新解析
  const base = getOpenClawRoot();
  let roots;
  try {
    roots = [await realpath(base)];
  } catch (err) {
    // 🔧 空catch修复: 记录失败原因并降级
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(`[security] getAllowedRoots realpath 失败: ${err?.message || '未知错误'}，降级为 resolve`);
    }
    roots = [resolve(base)];
  }
  _cachedRoots = roots;
  _cachedRootsTime = now;
  return roots;
}

/**
 * 手动刷新白名单根目录缓存
 * 当沙箱目录被移动/重命名后，调用此函数强制重新解析
 * @returns {Promise<string[]>}
 */
export async function refreshAllowedRoots() {
  _cachedRoots = null;
  _cachedRootsTime = 0;
  return getAllowedRoots();
}

/**
 * 路径白名单校验
 * @param {string} filePath - 待校验的文件路径
 * @returns {Promise<string>} 校验通过后的真实路径
 * @throws {Error} BAD_REQUEST / ACCESS_DENIED
 */
export async function validatePath(filePath) {
  if (!filePath) throw Object.assign(new Error("路径不能为空"), { code: "BAD_REQUEST" });

  const isWin = process.platform === "win32";
  const norm = (p) => (isWin ? p.toLowerCase() : p);

  // 使用 TTL 缓存的根目录列表（而非只解析一次的 ALLOWED_ROOTS_PROMISE）
  const ALLOWED_ROOTS = await getAllowedRoots();

  let resolved;
  try {
    resolved = await realpath(filePath);
  } catch (err) {
    if (err.code === "ENOENT") {
      // 🔧 H-001 Fix: 逐级解析已存在的父目录真实路径，防止符号链接绕过
      // 原实现 resolve(normalize(filePath)) 不解析符号链接，可通过symlink写入系统任意目录
      const parentDir = dirname(filePath);
      let parentReal;
      try {
        parentReal = await realpath(parentDir);
      } catch (parentErr) {
        // 🔧 空catch修复: 父目录realpath失败时记录并降级
        if (typeof console !== 'undefined' && console.warn) {
          console.warn(`[security] validatePath 父目录 realpath 失败: ${parentErr?.message || '未知错误'}`);
        }
        parentReal = resolve(parentDir);
      }
      resolved = join(parentReal, basename(filePath));
    } else {
      throw Object.assign(
        new Error(`路径解析失败: ${err.message}`),
        { code: "ACCESS_DENIED" }
      );
    }
  }

  const allowed = ALLOWED_ROOTS.some((root) => {
    const normRoot = norm(root);
    const normResolved = norm(resolved);
    if (isWin) {
      return normResolved.startsWith(normRoot + "\\") || normResolved === normRoot;
    }
    const rel = relative(root, resolved);
    return !rel.startsWith("..") && !isAbsolute(rel);
  });

  if (!allowed) {
    throw Object.assign(
      new Error(`路径不在允许范围内: ${filePath}`),
      { code: "ACCESS_DENIED" }
    );
  }

  return resolved;
}

export default { validatePath, refreshAllowedRoots };
