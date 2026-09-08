import { spawn, execSync } from 'child_process';
import * as net from 'net';

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
          const path = await import('path');
          let proxyScriptPath;
          if (typeof __dirname !== 'undefined') {
            proxyScriptPath = path.join(__dirname, 'proxy', 'index.js').replace(/\\/g, '\\\\');
          } else {
            const url = await import('url');
            const dirname = url.fileURLToPath(new URL('.', import.meta.url));
            proxyScriptPath = path.join(dirname, 'proxy', 'index.js').replace(/\\/g, '\\\\');
          }
          const child = spawn('node', ['-e', `require('${proxyScriptPath}').startProxyServer({ port: ${port} })`], {
            detached: true,
            stdio: 'ignore'
          });
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
  try {
    const pids = execSync(`lsof -t -i:${port}`).toString().trim().split('\n');
    let killed = false;
    for (const pid of pids) {
      if (pid) {
        execSync(`kill -9 ${pid}`);
        killed = true;
      }
    }
    console.log('Keymux proxy stopped');
  } catch (e) {
    console.log('Keymux proxy stopped');
  }
}
