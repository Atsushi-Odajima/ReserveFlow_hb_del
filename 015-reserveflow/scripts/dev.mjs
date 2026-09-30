// Runs the API server (tsx watch) and the Vite dev server together.
import { spawn } from 'node:child_process';
const procs = [
  spawn('npx', ['tsx', 'watch', 'src/server/index.ts'], { stdio: 'inherit', env: { ...process.env, RUN_WORKER: process.env.RUN_WORKER ?? 'true' } }),
  spawn('npx', ['vite'], { stdio: 'inherit' }),
];
const stop = () => procs.forEach((p) => p.kill('SIGTERM'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
