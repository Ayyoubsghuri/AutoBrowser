// Starts the FastAPI backend as a child process and waits until it is healthy.
const { spawn } = require('child_process');
const crypto = require('crypto');
const net = require('net');
const path = require('path');
const fs = require('fs');
const http = require('http');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function resolveCommand(app) {
  if (app.isPackaged) {
    const exe = process.platform === 'win32' ? 'autobrowser-backend.exe' : 'autobrowser-backend';
    return { cmd: path.join(process.resourcesPath, 'backend', exe), args: [], cwd: path.join(process.resourcesPath, 'backend') };
  }
  const backendDir = path.resolve(__dirname, '..', '..', 'backend');
  const venvPy = process.platform === 'win32'
    ? path.join(backendDir, '.venv', 'Scripts', 'python.exe')
    : path.join(backendDir, '.venv', 'bin', 'python');
  const py = process.env.AB_PYTHON || (fs.existsSync(venvPy) ? venvPy : (process.platform === 'win32' ? 'python' : 'python3'));
  return { cmd: py, args: ['run.py'], cwd: backendDir };
}

async function startBackend(app, log = console.log) {
  // Allow pointing at an already-running backend (useful while developing the API).
  if (process.env.AB_BACKEND_PORT && process.env.AB_BACKEND_TOKEN) {
    return { port: Number(process.env.AB_BACKEND_PORT), token: process.env.AB_BACKEND_TOKEN, stop() {} };
  }
  const port = await freePort();
  const token = crypto.randomBytes(32).toString('base64url');
  const { cmd, args, cwd } = resolveCommand(app);
  const child = spawn(cmd, args, {
    cwd,
    env: {
      ...process.env,
      AUTOBROWSER_PORT: String(port),
      AUTOBROWSER_TOKEN: token,
      AUTOBROWSER_DATA: path.join(app.getPath('userData'), 'data'),
      PYTHONUNBUFFERED: '1',
    },
    windowsHide: true,
  });
  child.stdout.on('data', (d) => log('[backend]', d.toString().trim()));
  child.stderr.on('data', (d) => log('[backend]', d.toString().trim()));
  let exited = false;
  child.on('exit', (code) => { exited = true; log('[backend] exited', code); });

  for (let i = 0; i < 150; i++) {
    if (exited) throw new Error(`Backend failed to start (${cmd}). Is Python installed with backend/requirements.txt?`);
    if (await health(port)) break;
    await new Promise((r) => setTimeout(r, 200));
    if (i === 149) throw new Error('Backend did not become healthy in 30s');
  }
  return { port, token, stop: () => { try { child.kill(); } catch {} } };
}

module.exports = { startBackend };
