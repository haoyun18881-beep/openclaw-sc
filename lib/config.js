/**
 * 🦞 sc v5.8+ — 统一模型配置读取
 *
 * 所有模型名统一从此文件读取，不再硬编码。
 * 配置来源：openclaw.json → models.providers
 *
 * 用法：
 *   import { getDeepseekConfig, getEmbeddingConfig, getVisionConfig, getDefaultModel } from './lib/config.js';
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

// ====== Config cache ======
let _configCache = null;
let _configCacheTime = 0;
const CONFIG_CACHE_TTL = 30000;

/**
 * 读取并缓存 openclaw.json
 */
async function readOpenClawConfig() {
  const now = Date.now();
  if (_configCache && now - _configCacheTime < CONFIG_CACHE_TTL) {
    return _configCache;
  }
  try {
    const content = await readFile(join(homedir(), '.openclaw', 'openclaw.json'), 'utf-8');
    _configCache = JSON.parse(content);
    _configCacheTime = now;
  } catch (err) {
    console.warn(`[config] ⚠️ 读取openclaw.json失败: ${err?.message || '未知错误'}`);
    _configCache = null;
    _configCacheTime = now;
  }
  return _configCache;
}

/**
 * 清除缓存（让下一次读取重新加载）
 */
export function clearConfigCache() {
  _configCache = null;
  _configCacheTime = 0;
}

// ====== DeepSeek 聊天模型配置 ======

/**
 * 获取 DeepSeek 聊天模型配置
 * @returns {{ baseUrl: string, apiKey: string, defaultModel: string, models: Array }}
 *          如果没有配置，defaultModel 返回 null
 */
export async function getDeepseekConfig() {
  const cfg = await readOpenClawConfig();
  const provider = cfg?.models?.providers?.deepseek;
  if (!provider || !provider.models || provider.models.length === 0) {
    return {
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: getEnv('DEEPSEEK_API_KEY', ''),
      defaultModel: null,
      models: [],
    };
  }

  // 第一个非 vision 的聊天模型作为默认
  const modelList = provider.models || [];
  const defaultModel = modelList.find(m => !m.id.startsWith('glm'))?.id || modelList[0]?.id || null;

  return {
    baseUrl: provider.baseUrl || 'https://api.deepseek.com/v1',
    apiKey: provider.apiKey || getEnv('DEEPSEEK_API_KEY', ''),
    defaultModel,
    models: modelList,
  };
}

/**
 * 获取 DeepSeek 默认聊天模型 ID
 * 如果没有配置，返回 null
 */
export async function getDefaultChatModel() {
  const cfg = await getDeepseekConfig();
  return cfg.defaultModel;
}

// ====== Embedding / Ollama 配置 ======

/**
 * 获取 Embedding (Ollama) 模型配置
 * @returns {{ baseUrl: string, embeddingModel: string, baseUrlChat: string }}
 *          如果没有配置，embeddingModel 返回 null，baseUrl 返回默认 Ollama 地址
 */
export async function getEmbeddingConfig() {
  const cfg = await readOpenClawConfig();
  const provider = cfg?.models?.providers?.embedding;

  if (!provider) {
    return {
      baseUrl: 'http://127.0.0.1:11434',
      embeddingModel: null,
      baseUrlChat: 'http://127.0.0.1:11434',
    };
  }

  const rawBaseUrl = provider.baseUrl || 'http://127.0.0.1:11434';
  const baseUrl = rawBaseUrl.replace(/\/v1\/?$/, '').replace(/\/api\/?$/, '');

  const modelList = provider.models || [];
  const embeddingModel = modelList[0]?.id || null;

  return {
    baseUrl,
    embeddingModel,
    baseUrlChat: baseUrl,
  };
}

// ====== 视觉模型配置 ======

/**
 * 获取视觉模型配置
 */
export async function getVisionConfig() {
  const cfg = await readOpenClawConfig();

  const visionProvider = cfg?.models?.providers?.vision;
  if (visionProvider && visionProvider.models && visionProvider.models.length > 0) {
    const rawBaseUrl = visionProvider.baseUrl || '';
    const baseUrl = rawBaseUrl.replace(/\/v1\/?$/, '').replace(/\/api\/?$/, '');
    const model = visionProvider.models[0]?.id || null;
    return {
      baseUrl,
      model,
      configured: true,
      provider: 'vision',
      apiKey: visionProvider.apiKey || '',
      api: visionProvider.api || 'openai-completions',
    };
  }

  const embedProvider = cfg?.models?.providers?.embedding;
  if (embedProvider) {
    const rawBaseUrl = embedProvider.baseUrl || 'http://127.0.0.1:11434';
    const baseUrl = rawBaseUrl.replace(/\/v1\/?$/, '').replace(/\/api\/?$/, '');
    return {
      baseUrl,
      model: null,
      configured: false,
      provider: 'embedding',
      apiKey: '',
      note: '视觉模型未配置，使用 Ollama embedding provider 地址',
    };
  }

  return {
    baseUrl: '',
    model: null,
    configured: false,
    provider: '',
    note: '视觉模型未配置，请在 openclaw.json 中添加 models.providers.vision 配置',
  };
}
