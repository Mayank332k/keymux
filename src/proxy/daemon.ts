import { spawn, execSync } from 'child_process';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function getPidFile() {
  const dir = path.join(os.homedir(), '.keymux');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'proxy.pid');
}

export async function startDaemon(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`Keymux proxy already running on port ${port}`);
        resolve();
      } else {
        reject(err);
      }
    });

    server.once('listening', () => {
      server.close(async () => {
        try {
          let proxyScriptPath;
          if (typeof __dirname !== 'undefined') {
            proxyScriptPath = path.join(__dirname, 'proxy', 'index.js').replace(/\\/g, '\\\\');
          } else {
            const url = await import('url');
            const dirname = url.fileURLToPath(new URL('.', import.meta.url));
            proxyScriptPath = path.join(dirname, 'proxy', 'index.js').replace(/\\/g, '\\\\');
          }
          const child = spawn('node', ['-e', `import('${proxyScriptPath}').then(m => m.startProxyServer({ port: ${port} })).catch(console.error)`], {
            detached: true,
            stdio: 'ignore'
          });

          if (child.pid) {
            fs.writeFileSync(getPidFile(), child.pid.toString());
          }
          child.unref();
          console.log(`Keymux proxy started on port ${port}`);
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });

    server.listen(port);
  });
}

export async function stopDaemon(port: number): Promise<void> {
  const pidFile = getPidFile();

  if (fs.existsSync(pidFile)) {
    try {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      if (pid && !isNaN(pid)) {
        try {
           const cmd = execSync(`ps -p ${pid} -o command=`).toString();
           if (!cmd.includes('node') && !cmd.includes('keymux')) {
              console.log(`Process ${pid} is not a Keymux proxy. Aborting.`);
              return;
           }
        } catch (e) {
           console.log(`Failed to verify process ${pid}`);
        }
        process.kill(pid, 'SIGTERM');
        console.log(`Keymux proxy (PID ${pid}) stopped gracefully.`);
      }
    } catch (e: any) {
      if (e.code === 'ESRCH') {
         console.log('Proxy is not running (stale PID file).');
      } else {
         console.log('Failed to stop proxy: ' + e.message);
      }
    }
    try { fs.unlinkSync(pidFile); } catch (e) {}
  } else {
    console.log('Keymux proxy is not running.');
  }
}
