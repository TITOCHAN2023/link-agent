'use strict';

const crypto = require('crypto');

// ============================================================
// Message types for Agent-to-Agent communication
// ============================================================

const MSG = {
  CHAT: 'chat',          // plain text chat
  TASK: 'task',          // delegate a structured task
  RESULT: 'result',      // return task result
  FILE: 'file',          // share file content
  QUERY: 'query',        // ask a specific question
  ACK: 'ack',            // acknowledge receipt
  SESSION: 'session',    // session lifecycle (start/accept/reject/end)
};

/**
 * Create a message envelope with unique ID and timestamp.
 * All P2P messages go through this.
 *
 * @param {string} type     One of MSG.*
 * @param {object} payload  Type-specific data
 * @param {object} [opts]
 * @param {string} [opts.from]     Sender name
 * @param {string} [opts.replyTo]  Message ID this is replying to
 * @returns {object}
 */
function createMessage(type, payload, { from, replyTo } = {}) {
  return {
    id: crypto.randomBytes(4).toString('hex'),
    type,
    payload,
    from: from || null,
    replyTo: replyTo || null,
    ts: Date.now(),
  };
}

/**
 * Shorthand constructors
 */

function chat(text, from) {
  return createMessage(MSG.CHAT, { content: text }, { from });
}

function task(description, data, from) {
  return createMessage(MSG.TASK, { description, data }, { from });
}

function result(data, from, replyTo) {
  return createMessage(MSG.RESULT, { data }, { from, replyTo });
}

function file(name, content, from) {
  return createMessage(MSG.FILE, { name, content }, { from });
}

function query(question, from) {
  return createMessage(MSG.QUERY, { question }, { from });
}

function ack(msgId, from) {
  return createMessage(MSG.ACK, {}, { from, replyTo: msgId });
}

function session(action, opts = {}) {
  return createMessage(MSG.SESSION, {
    action,
    sessionId: opts.sessionId || null,
    description: opts.description || null,
    reason: opts.reason || null,
  }, { from: opts.from });
}

module.exports = {
  MSG,
  createMessage,
  chat,
  task,
  result,
  file,
  query,
  ack,
  session,
};
