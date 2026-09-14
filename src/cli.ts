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
  
  console.log('\n' + chalk.green(' ✔ Keymux Gateway initialized successfully.'));
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
