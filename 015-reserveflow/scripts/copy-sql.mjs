import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist-server/server/db/migrations', { recursive: true });
cpSync('src/server/db/migrations', 'dist-server/server/db/migrations', { recursive: true });
console.log('copied migrations');
