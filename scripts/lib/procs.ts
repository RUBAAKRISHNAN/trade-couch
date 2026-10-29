import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const tsxCli = path.join(root, 'node_modules/tsx/dist/cli.mjs');

/** Start an app's main.ts with tsx; output goes to a log file. */
export function startApp(
  app: 'engine' | 'worker' | 'api',
  logFile: string,
  env: Record<string, string> = {},
): ChildProcess {
  const cwd = path.join(root, 'apps', app);
  const out = createWriteStream(logFile);
  const child = spawn(process.execPath, [tsxCli, '--env-file-if-exists=../../.env', 'src/main.ts'], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.pipe(out);
  child.stderr!.pipe(out);
  return child;
}

/** Kill a process AND its children (tsx spawns a child node). On Windows a plain kill() leaves orphans. */
export function killTree(child: ChildProcess) {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32')
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
