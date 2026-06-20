const { execSync } = require('child_process');

const port = Number(process.env.PORT || 3000);

function freePortWindows() {
  let output = '';
  try {
    output = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8' });
  } catch {
    return;
  }

  const pids = new Set();
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes('LISTENING')) continue;
    const parts = line.trim().split(/\s+/);
    const pid = parts[parts.length - 1];
    if (pid && /^\d+$/.test(pid) && pid !== '0') pids.add(pid);
  }

  for (const pid of pids) {
    try {
      execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
      console.log(`[free-port] Звільнено порт ${port} (PID ${pid})`);
    } catch (_) {
      /* ignore */
    }
  }
}

function freePortUnix() {
  try {
    execSync(`lsof -ti:${port} | xargs -r kill -9`, { stdio: 'ignore', shell: true });
    console.log(`[free-port] Звільнено порт ${port}`);
  } catch (_) {
    /* port already free */
  }
}

if (process.platform === 'win32') freePortWindows();
else freePortUnix();
