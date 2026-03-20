'use strict';

const { Command } = require('commander');
const chalk = require('chalk');
const { SignalingServer } = require('./server');
const { ClawClient } = require('./client');
const { describe } = require('./permissions');

const program = new Command();

program
  .name('claw-link')
  .description('P2P communication tool for OpenClaw instances')
  .version('0.1.0');

// ── server ──────────────────────────────────────────────────
program
  .command('server')
  .description('Start a signaling server and wait for a peer to connect')
  .option('-p, --port <port>', 'Port to listen on', '8765')
  .option('-n, --name <name>', 'Your Claw name', 'ClawServer')
  .option('--perm <level>', 'Permission level to request: intimate | helper | chat', 'helper')
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);

    console.log(chalk.bold('\n🔌 claw-link — Signaling Server Mode\n'));

    const srv = new SignalingServer({
      port,
      onLog: (msg) => console.log(chalk.gray(`[Server] ${msg}`)),
    });

    try {
      await srv.start();
    } catch (err) {
      console.error(chalk.red(`Failed to start server: ${err.message}`));
      process.exit(1);
    }

    console.log(chalk.cyan(`\n📡 Signaling server is running on port ${port}`));
    console.log(chalk.cyan(`   Share this with your peer: ws://<YOUR_IP>:${port}\n`));

    // Server 同时也作为一个 peer 连接进来
    const client = new ClawClient({
      signalingUrl: `ws://127.0.0.1:${port}`,
      name: opts.name,
      permission: opts.perm,
    });

    await client.start();

    // 捕获退出信号
    process.on('SIGINT', () => {
      srv.close();
      console.log(chalk.gray('\nServer stopped.'));
      process.exit(0);
    });
  });

// ── connect ──────────────────────────────────────────────────
program
  .command('connect [url]')
  .description('Connect to a signaling server and establish P2P')
  .option('-n, --name <name>', 'Your Claw name', 'ClawClient')
  .option('--perm <level>', 'Permission level to request: intimate | helper | chat', 'helper')
  .action(async (url = 'wss://ginfo.cc/signal/', opts) => {
    console.log(chalk.bold('\n🔗 claw-link — Connect Mode\n'));
    console.log(chalk.gray(`Connecting to signaling server: ${url}`));
    console.log(chalk.gray(`Your name: ${opts.name} | Requested permission: ${opts.perm.toUpperCase()}`));
    console.log(chalk.gray(`Permission: ${describe(opts.perm)}\n`));

    const client = new ClawClient({
      signalingUrl: url,
      name: opts.name,
      permission: opts.perm,
    });

    await client.start();

    process.on('SIGINT', () => {
      console.log(chalk.gray('\nDisconnecting...'));
      process.exit(0);
    });
  });

// ── ping ──────────────────────────────────────────────────────
program
  .command('ping <url>')
  .description('Test connectivity to a signaling server')
  .action(async (url) => {
    const WebSocket = require('ws');
    console.log(chalk.gray(`Pinging ${url} ...`));
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      console.log(chalk.red('Timeout: no response within 5s'));
      ws.close();
      process.exit(1);
    }, 5000);

    ws.on('open', () => {
      console.log(chalk.green(`✅ Signaling server at ${url} is reachable`));
      clearTimeout(timer);
      ws.close();
      process.exit(0);
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      console.log(chalk.red(`❌ Cannot connect: ${err.message}`));
      process.exit(1);
    });
  });

program.parse(process.argv);
