#!/usr/bin/env node

import { runDashboard } from './cli/dashboard';
import { startDaemon, stopDaemon } from './proxy/daemon';

const args = process.argv.slice(2);


const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function runBootAnimation() {
  const chalk = (await import('chalk')).default;
  const logo = [
    "  ██╗  ██╗███████╗██╗   ██╗███╗   ███╗██╗   ██╗██╗  ██╗",
    "  ██║ ██╔╝██╔════╝╚██╗ ██╔╝████╗ ████║██║   ██║╚██╗██╔╝",
    "  █████╔╝ █████╗   ╚████╔╝ ██╔████╔██║██║   ██║ ╚███╔╝",
    "  ██╔═██╗ ██╔══╝    ╚██╔╝  ██║╚██╔╝██║██║   ██║ ██╔██╗",
    "  ██║  ██╗███████╗   ██║   ██║ ╚═╝ ██║╚██████╔╝██╔╝ ██╗",
    "  ╚═╝  ╚═╝╚══════╝   ╚═╝   ╚═╝     ╚═╝ ╚═════╝ ╚═╝  ╚═╝"
  ];
  
  console.clear();
  console.log('\n');
  for (const line of logo) {
    console.log(chalk.cyan(line));
    await sleep(30);
  }
  
  console.log(chalk.gray('\n ⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤\n'));
  console.log(chalk.bold(' [ DECORATIVE BOOT SEQUENCE - NOT LIVE DATA ] '));
  
  const pings = [
    { name: 'groq', ttft: '184ms' },
    { name: 'nvidia', ttft: '412ms' },
    { name: 'openrouter', ttft: '590ms' },
    { name: 'mistral', ttft: '245ms' },
    { name: 'gemini', ttft: '810ms' },
  ];
  
  for (const p of pings) {
    process.stdout.write(` ◦ ${p.name.padEnd(12)} `);
    await sleep(200);
    console.log(chalk.gray(`──${chalk.cyan('●')}───────── `) + chalk.green(`[${p.ttft}] `) + chalk.bold('ONLINE'));
  }
  
  console.log('\n' + chalk.bold(' [ STRATEGY: TTFT FAST-POOL ]'));
  console.log(chalk.gray(' target_model  : llama-3.1-70b-versatile'));
  console.log(chalk.gray(' lead_provider : Groq'));
  console.log(chalk.gray(' variance      : ± 0.0ms\n'));
}
const helpText = `Usage: keymux [command] [options]

Commands:
  -d, --dashboard    Run the interactive dashboard
  proxy, start       Start the Keymux proxy daemon
  stop               Stop the Keymux proxy daemon

Options for proxy/start:
  --port <port>      Specify the port to run the proxy on (default: 3002)

Examples:
  keymux -d
  keymux start
  keymux proxy --port 8080
  keymux stop`;

async function main() {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(helpText);
    return;
  }

  if (args.length === 0 || args.includes('-d') || args.includes('--dashboard')) {
    runDashboard().catch(console.error);
    return;
  }

  const command = args[0];

  if (command === 'proxy' || command === 'start') {
    let port = 3002;
    const portIndex = args.indexOf('--port');
    if (portIndex !== -1 && args.length > portIndex + 1) {
      port = parseInt(args[portIndex + 1] ?? '3002', 10);
    }
    await runBootAnimation();
    await startDaemon(port);
  } else if (command === 'stop') {
    let port = 3002;
    const portIndex = args.indexOf('--port');
    if (portIndex !== -1 && args.length > portIndex + 1) {
      port = parseInt(args[portIndex + 1] ?? '3002', 10);
    }
    await stopDaemon(port);
  } else {
    console.log(`Unknown command: ${command}`);
    console.log(helpText);
    process.exit(1);
  }
}

main().catch(console.error);
