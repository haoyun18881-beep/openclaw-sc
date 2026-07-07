/**
 * sc — 共享文件系统操作
 *
 * 管理 shared/ 目录的读写、清理，以及 session 文件的清理。
 * 所有写入走 tmp+rename 原子写（Copy-on-Write），确保 Worker 间 IPC 不会读到半截文件(torn read)。
 * 读取使用 link+tmp 原子读(硬链接快照)，读取时原文件被 rename/覆盖也不影响当前读取。
 */

import { join, dirname } from "path";
import { homedir } from "os";
import { readFile, mkdir, readdir, unlink, rename, stat, writeFile, link } from "fs/promises";
import { randomBytes } from "crypto";
import { SHARED_DIR, SESSION_DIR, SESSION_KEEP_RECENT, TASK_STATES_DIR } from './constants.js';

const PREEMPT_DIR = join(SHARED_DIR, 'preempt');

export async function ensureSharedDir() {
  try { await mkdir(SHARED_DIR, { recursive: true }); } catch (err) {
    console.warn(`[shared-fs] ⚠️ ensureSharedDir失败: ${err?.message || '未知错误'}`);
  }
}

export function sanitizeTaskName(name) {
  if (!name || typeof name !== 'string') throw new Error('无效的 taskName');
  const safe = name.replace(/[^a-zA-Z0-9_\-]/g, '_');
  if (safe !== name) throw new Error(`taskName 包含非法字符: ${name}`);
  return safe;
}

export async function writeSharedResult(taskName, data) {
  const safeName = sanitizeTaskName(taskName);
  await ensureSharedDir();
  const tmpSuffix = randomBytes(4).toString('hex');
  const fp = join(SHARED_DIR, `${safeName}.json`);
  const tmp = join(SHARED_DIR, `${safeName}.${tmpSuffix}.tmp`);
  await writeFile(tmp, JSON.stringify({ taskName: safeName, ...data, timestamp: Date.now() }, null, 2), 'utf-8');
  await rename(tmp, fp);
  return fp;
}

export async function readSharedResult(taskName) {
  const safeName = sanitizeTaskName(taskName);
  const fp = join(SHARED_DIR, `${safeName}.json`);
  const suffix = randomBytes(4).toString('hex');
  const readingFp = join(SHARED_DIR, `${safeName}.${suffix}.reading.json`);
  try {
    // 硬链接原子读：创建硬链接后即使原文件被 rename/覆盖，链接依然指向旧 inode
    await link(fp, readingFp);
    const content = await readFile(readingFp, 'utf-8');
    await unlink(readingFp).catch(() => {});
    return JSON.parse(content);
  } catch (err) {
    // 清理可能的硬链接残留
    await unlink(readingFp).catch(() => {});
    // 回退：直接读原始文件（可能被其他进程 rename 走了，但写入端会重建）
    try {
      const content = await readFile(fp, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }
}

export async function cleanupSharedDir(maxAgeMs = 3600000) {
  try {
    await ensureSharedDir();
    const files = await readdir(SHARED_DIR);
    const now = Date.now();
    let cleaned = 0;
    for (const f of files) {
      const fp = join(SHARED_DIR, f);
      try {
        const st = await stat(fp);
        // 清理超时的临时文件(.tmp 和 .reading.json)，超过1小时
        if (f.endsWith('.tmp') || f.endsWith('.reading.json')) {
          if (now - st.mtimeMs > 3600000) {
            await unlink(fp);
            cleaned++;
          }
          continue;
        }
        // 只清理过期的 .json 结果文件
        if (!f.endsWith('.json')) continue;
        if (now - st.mtimeMs > maxAgeMs) {
          await unlink(fp);
          cleaned++;
        }
      } catch (err) {
        console.warn(`[shared-fs] ⚠️ 处理文件失败 ${f}: ${err?.message || '未知错误'}`);
      }
    }
    // 清理 decomposed/ 子目录的过期文件
    try {
      const decomposedDir = join(SHARED_DIR, 'decomposed');
      const decomposedFiles = await readdir(decomposedDir).catch(() => []);
      for (const df of decomposedFiles) {
        if (!df.endsWith('.json')) continue;
        const dfp = join(decomposedDir, df);
        try {
          const st = await stat(dfp);
          if (now - st.mtimeMs > maxAgeMs) {
            await unlink(dfp);
            cleaned++;
          }
        } catch (err) {
          console.warn(`[shared-fs] ⚠️ 处理decomposed文件失败 ${df}: ${err?.message}`);
        }
      }
    } catch (err) {
      console.warn(`[shared-fs] ⚠️ 清理decomposed目录失败: ${err?.message}`);
    }
    // 清理 preempt/ 子目录的残留 tmp 文件（进程崩溃后遗留）
    try {
      const preemptFiles = await readdir(PREEMPT_DIR).catch(() => []);
      for (const pf of preemptFiles) {
        if (!pf.endsWith('.tmp') && !pf.endsWith('.reading.json')) continue;
        const pfp = join(PREEMPT_DIR, pf);
        try {
          const st = await stat(pfp);
          if (now - st.mtimeMs > 3600000) {
            await unlink(pfp);
            cleaned++;
          }
        } catch (err) {
          console.warn(`[shared-fs] ⚠️ 处理preempt临时文件失败 ${pf}: ${err?.message}`);
        }
      }
    } catch (err) {
      console.warn(`[shared-fs] ⚠️ 清理preempt目录失败: ${err?.message}`);
    }
    if (cleaned > 0) console.log(`[sc] 🧹 清理了 ${cleaned} 个超时共享文件（含 decomposed/ 子步骤、preempt/ 残留tmp）`);
  } catch (err) {
    console.warn(`[shared-fs] ⚠️ cleanupSharedDir失败: ${err?.message}`);
  }
}

export async function cleanupOldSessions() {
  try {
    const files = await readdir(SESSION_DIR).catch(() => []);

    const tempFiles = files.filter(f => f.endsWith('.lock') || f.endsWith('.tmp'));
    let tempDeleted = 0;
    for (const f of tempFiles) {
      try { await unlink(join(SESSION_DIR, f)); tempDeleted++; } catch (err) { console.error("[sc] cleanupOldSessions 删除临时文件失败:", err.message); }
    }
    if (tempDeleted > 0) console.log(`[sc] 🧹 清理了 ${tempDeleted} 个临时文件（.lock/.tmp）`);

    const sessionFiles = files.filter(f => f.endsWith('.jsonl') || f.endsWith('.trajectory.jsonl'));
    if (sessionFiles.length <= SESSION_KEEP_RECENT) return;

    const withTime = await Promise.all(
      sessionFiles.map(async (f) => {
        try {
          const st = await stat(join(SESSION_DIR, f));
          return { name: f, mtime: st.mtimeMs };
        } catch { return null; }
      })
    );
    const valid = withTime.filter(Boolean).sort((a, b) => b.mtime - a.mtime);
    const toDelete = valid.slice(SESSION_KEEP_RECENT);

    let deleted = 0;
    for (const f of toDelete) {
      try { await unlink(join(SESSION_DIR, f.name)); deleted++; } catch (err) { console.error("[sc] cleanupOldSessions 删除旧session文件失败:", err.message); }
    }
    if (deleted > 0) console.log(`[sc] 🧹 清理了 ${deleted} 个旧session文件（保留${SESSION_KEEP_RECENT}个）`);
  } catch (err) { console.error("[sc] cleanupOldSessions 函数异常:", err.message); }
}

export async function cleanupTaskStates() {
  try {
    const files = await readdir(TASK_STATES_DIR).catch(() => []);
    if (files.length === 0) return;

    const now = Date.now();
    const DAY_MS = 86400000;
    let deleted = 0;

    for (const f of files) {
      if (!f.endsWith('.json') && !f.endsWith('.md')) continue;
      try {
        const st = await stat(join(TASK_STATES_DIR, f));
        if (now - st.mtimeMs > DAY_MS) {
          await unlink(join(TASK_STATES_DIR, f));
          deleted++;
        }
      } catch (err) { console.warn(`[shared-fs] 跳过无法访问的文件 ${f}: ${err?.message}`); }
    }

    if (deleted > 0) console.log(`[sc] 🧹 清理了 ${deleted} 个孤儿任务元数据（task-states/，超过24小时）`);
  } catch (err) { console.error("[sc] cleanupTaskStates 函数异常:", err.message); }
}

export async function ensurePreemptDir() {
  try { await mkdir(PREEMPT_DIR, { recursive: true }); } catch (err) {
    console.warn(`[shared-fs] 确保preempt目录失败: ${err?.message || '未知错误'}`);
  }
}

export async function writePreemptState(jobId, state) {
  await ensurePreemptDir();
  const safeName = jobId.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const fp = join(PREEMPT_DIR, `${safeName}.json`);
  const tmp = join(PREEMPT_DIR, `${safeName}.${randomBytes(4).toString('hex')}.tmp`);
  await writeFile(tmp, JSON.stringify({ ...state, _preemptSavedAt: Date.now() }, null, 2), 'utf-8');
  await rename(tmp, fp);
  return fp;
}

export async function readPreemptState(jobId) {
  const safeName = jobId.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const fp = join(PREEMPT_DIR, `${safeName}.json`);
  try {
    const content = await readFile(fp, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    console.warn(`[shared-fs] 读取preempt状态失败 ${jobId}: ${err?.message || '未知错误'}`);
    return null;
  }
}

export async function clearPreemptState(jobId) {
  const safeName = jobId.replace(/[^a-zA-Z0-9_\-]/g, '_');
  try {
    await unlink(join(PREEMPT_DIR, `${safeName}.json`));
  } catch (err) {
    console.warn(`[shared-fs] 清除preempt状态失败 ${jobId}: ${err?.message || '未知错误'}`);
  }
}

export default {
  ensureSharedDir,
  sanitizeTaskName,
  writeSharedResult,
  readSharedResult,
  cleanupSharedDir,
  cleanupOldSessions,
  cleanupTaskStates,
  ensurePreemptDir,
  writePreemptState,
  readPreemptState,
  clearPreemptState,
};
