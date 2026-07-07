/**
 * 🦞 env.js — 统一环境变量读取层
 *
 * 所有代码统一通过此模块读取环境变量，不要直接访问 process.env。
 * 好处：
 *   1. 可统一兜底/日志/类型转换
 *   2. 将来可以支持 .env 文件加载
 *   3. 测试时可 mock 这个模块
 *
 * ✅ 安全的环境变量（系统级）：USERPROFILE, TEMP, SystemRoot, SYSTEMDRIVE, windir
 * ⚠️ 需评审的变量（配置级）：API 密钥、模型名、代理地址
 * ❌ 敏感变量（禁止日志）：含 KEY / SECRET / TOKEN / PASSWORD 的变量
 */

// 白名单：允许直接读取的系统级环境变量（不触发告警）
const SAFE_SYSTEM_VARS = new Set([
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP',
  'SystemRoot', 'SYSTEMDRIVE', 'windir', 'OS', 'PROCESSOR_ARCHITECTURE',
  'COMPUTERNAME', 'USERNAME', 'LOGONSERVER',
]);

// 敏感变量前缀（读取时不会输出到日志）
function isSensitive(name) {
  const u = name.toUpperCase();
  return /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i.test(u);
}

/**
 * 安全地读取环境变量
 * @param {string} name - 变量名（大小写不敏感，建议大写）
 * @param {*} defaultValue - 不存在时的兜底值
 * @returns {string|*} 变量值或默认值
 */
export function getEnv(name, defaultValue = undefined) {
  const value = process.env[name];
  if (value !== undefined) return value;
  return defaultValue;
}

/**
 * 读取布尔型环境变量（'1', 'true', 'yes' → true）
 */
export function getEnvBool(name, defaultValue = false) {
  const value = getEnv(name, null);
  if (value === null) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

/**
 * 读取数字型环境变量
 */
export function getEnvNum(name, defaultValue = 0) {
  const value = getEnv(name, null);
  if (value === null) return defaultValue;
  const num = parseInt(value, 10);
  return isNaN(num) ? defaultValue : num;
}

export default { getEnv, getEnvBool, getEnvNum };
