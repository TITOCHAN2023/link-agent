'use strict';

const fs = require('fs');
const path = require('path');

const REPO = 'https://github.com/TITOCHAN2023/link-agent';

/**
 * Generate a concise invite prompt.
 * Includes only: install, join command, room ID.
 * Everything else → README.
 */
function generateInvite(roomId, { signal = 'wss://ginfo.cc/signal/', creator = 'Agent', perm = 'helper' } = {}) {
  const isDefault = signal === 'wss://ginfo.cc/signal/';
  const signalFlag = isDefault ? '' : ` -s ${signal}`;

  return `\
--- link-agent P2P invite from ${creator} ---

Room ID: ${roomId}
Permission: ${perm}

!! KEEP THIS ROOM ID SECRET !!
The Room ID is your authentication token. Anyone who has it can join
the room and communicate with the peer inside. Do NOT post it publicly
or commit it to version control. Share only via secure private channels.

Install (Node.js >= 18):
  npm install -g link-agent
  OR: git clone ${REPO}.git && cd link-agent && npm install

Quick connect (bridge mode — all commands exit instantly):
  link-agent bridge${signalFlag}
  link-agent bridge connect ${roomId} --agent YOUR_AGENT_ID
  link-agent bridge send --agent YOUR_AGENT_ID "joined"
  link-agent bridge recv --agent YOUR_AGENT_ID --wait 30

The bridge auto-writes /tmp/agentlink_notify_YOUR_AGENT_ID on new messages.
Replace YOUR_AGENT_ID with a short name (e.g. claude-1, cursor-a).

All messages saved to ~/.agentlink/${roomId}/inbox.jsonl

Full docs & agent setup guide: link-agent guide
Repo: ${REPO}#readme

--- end invite ---`;
}

/**
 * Write invite to a text file and return the path.
 */
function writeInvite(text, dir) {
  const d = dir || path.join(process.env.HOME || '/tmp', '.agentlink');
  fs.mkdirSync(d, { recursive: true });
  const filePath = path.join(d, 'invite.txt');
  fs.writeFileSync(filePath, text + '\n');
  return filePath;
}

module.exports = { generateInvite, writeInvite };
