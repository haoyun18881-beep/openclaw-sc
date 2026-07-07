/**
 * 🦞 sc v5.37.0 — 共享工具处理器 (ESM)
 *
 * 从 index.js 和 tools/bridge.js 提取的公共工具执行逻辑，
 * 减少双份维护、保证行为一致。
 *
 * 每个 handler 签名：
 *   async handleXxx(params, pool) → result
 *
 * params   — 调用方透传的参数字典（对象）
 * pool     — CpuWorkerPool 实例（也可传入 mock/stub）
 *
 * 注：pool 必须提供
 *   .exec(task, priority)    — 派任务给 Worker
 *   .getStats()              — 返回池状态
 *
 * 🧹 已清理已删除工具对应的 handler（2026-06-10）:
 *    删除: handleCoreSearch, handleCoreProcessLog, handleCoreResolveModel,
 *          handleCoreDiff, handleCoreBatch, handleCoreDiagnose, handleCoreScan,
 *          handleCoreWorkspaceSync
 *    保留: handleCoreStats（core_stats）, handleCoreImageBatch（core_batchVision）
 */

import { resolve, basename, join } from 'path';
import { homedir } from 'os';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { validatePath } from '../security.js';

// ========================================================================
// 1. core_stats — Worker 池状态快照
// ========================================================================
/**
 * @param {object} params - (unused, kept for uniform signature)
 * @param {object} pool
 */
export async function handleCoreStats(params, pool) {
  return pool.getStats();
}

// ========================================================================
// 2. core_batchVision (cpu_imageBatch) — 多核图片批量分析
// ========================================================================
/**
 * 多Worker并行压缩图片→调视觉API→合并结果
 * @param {object} params - { files: string[], prompt?: string, model?: string, priority?: string }
 * @param {object} pool
 */
/**
 * 从 openclaw.json 读取默认视觉模型配置
 */
function getDefaultVisionModel() {
  try {
    const configPath = resolve(homedir(), '.openclaw', 'openclaw.json');
    const raw = readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw);
    const model = config?.tools?.media?.image?.models?.[0]?.model;
    if (model) return model;
  } catch (err) {
    // 读取失败就返回默认值
  }
  return 'qwen3-vl:8b';
}

/**
 * inbound 图片目录
 */
const MEDIA_INBOUND_DIR = resolve(homedir(), '.openclaw', 'media', 'inbound');

/**
 * 解析图片路径：先当绝对路径试，不行就去 inbound 目录按文件名找
 */
function resolveImagePath(filePath) {
  // 去掉协议头（media://、file:// 等）
  let cleanPath = filePath;
  if (filePath.includes('://')) {
    cleanPath = filePath.split('://').slice(1).join('://');
  }

  // 先试绝对路径
  let absPath = resolve(cleanPath);
  if (existsSync(absPath)) return absPath;

  // 再试相对于 workspace 的路径
  const wsPath = resolve(homedir(), '.openclaw', 'workspace', cleanPath);
  if (existsSync(wsPath)) return wsPath;

  // 最后去 inbound 目录按文件名找
  const fileName = basename(cleanPath);
  const inboundPath = join(MEDIA_INBOUND_DIR, fileName);
  if (existsSync(inboundPath)) return inboundPath;

  // 真找不到就抛原路径，让下游报错
  return absPath;
}

/**
 * 获取 inbound 目录下最新的 N 个文件
 */
function getLatestInboundFiles(count = 10) {
  if (!existsSync(MEDIA_INBOUND_DIR)) return [];
  const entries = readdirSync(MEDIA_INBOUND_DIR)
    .filter(name => /\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(name))
    .map(name => ({
      name,
      path: join(MEDIA_INBOUND_DIR, name),
      mtime: statSync(join(MEDIA_INBOUND_DIR, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  return entries.slice(0, count).map(e => e.path);
}

export async function handleCoreImageBatch(params, pool) {
  let files = params.files;

  // 支持 "latest" / "current" 语义：解析为 inbound 目录最新一张图
  if (Array.isArray(files) && files.length > 0) {
    const resolvedLatest = [];
    for (const f of files) {
      if (f === 'latest' || f === 'current') {
        const latestFiles = getLatestInboundFiles(1);
        if (latestFiles.length > 0) {
          resolvedLatest.push(latestFiles[0]);
        }
      } else {
        resolvedLatest.push(f);
      }
    }
    files = resolvedLatest;
  }

  // 没传 files → 去 inbound 目录读最新 1 张（不是 10 张，避免 GPU 显存爆炸）
  if (!files || !Array.isArray(files) || files.length === 0) {
    files = getLatestInboundFiles(1);
    if (files.length === 0) {
      throw new Error('未传 files，且 media/inbound/ 目录为空或不存在。发送图片后调用此工具即可自动识别最新一张。');
    }
  }

  // 路径解析：协议路径 → 真实磁盘路径
  const resolvedFiles = files.map(f => resolveImagePath(f));
  for (const f of resolvedFiles) await validatePath(f);

  const model = params.model || getDefaultVisionModel();

  // 🔁 串行处理（不是并行）—— 每张图依次走 Worker，防止多图并发砸 GPU 显存
  const output = [];
  for (let i = 0; i < resolvedFiles.length; i++) {
    const filePath = resolvedFiles[i];
    try {
      const result = await pool.exec({
        type: 'image-process',
        imagePath: filePath,
        prompt: params.prompt,
        model: model,
      }, params.priority || 'normal');
      output.push({ file: files[i], ...result });
    } catch (err) {
      output.push({ file: files[i], success: false, error: err?.message || 'Worker 执行失败' });
    }
  }

  return {
    total: files.length,
    successCount: output.filter(r => r.success).length,
    failCount: output.filter(r => !r.success).length,
    results: output,
  };
}

// ========================================================================
// 📋 处理函数映射表 — 供 MCP / 路由使用
// ========================================================================
export const HANDLER_MAP = {
  cpu_stats: handleCoreStats,
  cpu_imageBatch: handleCoreImageBatch,
};

export default { HANDLER_MAP };
