'use strict';

// ============================================================
// 权限系统 (Permission System)
//
// 三级权限:
//   INTIMATE (0) — 完全信任，可读写配置、文件等
//   HELPER   (1) — 协作模式，可 chat + session + file，但不可读写配置
//   CHAT     (2) — 仅聊天，不可发起 session、不可操作文件/配置
//
// 协商规则: 双方各声明自己的权限级别，取较低（更保守）的那个
// ============================================================

const LEVELS = {
  INTIMATE: 0,
  HELPER: 1,
  CHAT: 2,
};

// 权限名称映射（小写 → 大写键名）
const LEVEL_NAMES = {
  intimate: 'INTIMATE',
  helper: 'HELPER',
  chat: 'CHAT',
};

// 隐私数据关键词（HELPER 模式下过滤）
const PRIVATE_PATTERNS = [
  /api[_\s-]?key/i,
  /token/i,
  /password/i,
  /secret/i,
  /openclaw\.json/i,
  /MEMORY\.md/i,
  /SOUL\.md/i,
  /手机|邮件|电话|地址|位置/,
];

/**
 * 协商权限级别：取双方较低（数值较大 = 更保守）的权限
 * @param {string} levelA - 'intimate' | 'helper' | 'chat'
 * @param {string} levelB - 'intimate' | 'helper' | 'chat'
 * @returns {string} 协商后的权限名称（小写）
 */
function negotiate(levelA, levelB) {
  const a = LEVELS[LEVEL_NAMES[levelA]] ?? LEVELS.CHAT;
  const b = LEVELS[LEVEL_NAMES[levelB]] ?? LEVELS.CHAT;
  // 数值越大越保守，取 max
  const result = Math.max(a, b);
  const name = Object.keys(LEVELS).find((k) => LEVELS[k] === result);
  return name.toLowerCase();
}

/**
 * 检测文本是否包含隐私数据关键词
 * @param {string} text
 * @returns {boolean}
 */
function isPrivate(text) {
  return PRIVATE_PATTERNS.some((p) => p.test(text));
}

/**
 * 检查当前协商权限是否允许执行某操作
 * @param {string} negotiatedLevel - 'intimate' | 'helper' | 'chat'
 * @param {string} action - 'chat' | 'session' | 'file' | 'config'
 * @returns {boolean}
 */
function canPerform(negotiatedLevel, action) {
  switch (negotiatedLevel) {
    case 'intimate':
      return true;
    case 'helper':
      return action !== 'config';
    case 'chat':
      return action === 'chat';
    default:
      return false;
  }
}

/**
 * 获取权限级别的人类可读描述
 * @param {string} level
 * @returns {string}
 */
function describe(level) {
  switch (level) {
    case 'intimate':
      return 'INTIMATE — Full trust: chat, session, file, config';
    case 'helper':
      return 'HELPER — Collaboration: chat, session, file (no config)';
    case 'chat':
      return 'CHAT — Chat only: no session, no file, no config';
    default:
      return 'UNKNOWN';
  }
}

module.exports = { LEVELS, LEVEL_NAMES, negotiate, isPrivate, canPerform, describe, PRIVATE_PATTERNS };
