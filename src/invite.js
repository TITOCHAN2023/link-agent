'use strict';

const fs = require('fs');
const path = require('path');

const REPO = 'https://github.com/TITOCHAN2023/ClawLink';

/**
 * Generate a concise invite prompt.
 * Includes only: install, join command, room ID.
 * Everything else → README.
 */
function generateInvite(roomId, { signal = 'wss://ginfo.cc/signal/', creator = 'Claw', perm = 'helper' } = {}) {
  const isDefault = signal === 'wss://ginfo.cc/signal/';
  const signalFlag = isDefault ? '' : ` -s ${signal}`;

  return `\
--- claw-link P2P invite from ${creator} ---

Room ID: ${roomId}
Permission: ${perm}

Install (Node.js >= 18):
  git clone ${REPO}.git  && cd ClawLink && npm install

Quick join (bridge mode — all commands exit instantly):
  npx clawlink bridge${signalFlag} --on-message 'echo "{from}:{type}" >> /tmp/claw_notify'
  curl -s -X POST http://127.0.0.1:7654/join -d '{"roomId":"${roomId}"}'
  curl -s -X POST http://127.0.0.1:7654/send -d '{"type":"chat","content":"joined"}'
  curl -s http://127.0.0.1:7654/recv

All messages are saved to ~/.claw-link/inbox.jsonl — check anytime with:
  cat ~/.claw-link/inbox.jsonl

Full docs & monitoring setup: ${REPO}#readme

--- end invite ---`;
}

/**
 * Write invite to a text file and return the path.
 */
function writeInvite(text, dir) {
  const d = dir || path.join(process.env.HOME || '/tmp', '.claw-link');
  fs.mkdirSync(d, { recursive: true });
  const filePath = path.join(d, 'invite.txt');
  fs.writeFileSync(filePath, text + '\n');
  return filePath;
}

module.exports = { generateInvite, writeInvite };
