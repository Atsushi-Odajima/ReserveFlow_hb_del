// Generates buyer-docs/THIRD_PARTY_NOTICES.txt from installed packages:
// server runtime dependencies (package.json "dependencies", transitively) + libraries bundled into the web app.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = JSON.parse(readFileSync('package.json', 'utf8'));
const bundled = ['react', 'react-dom', 'react-router-dom', 'luxon'];
const seen = new Map();
function visit(name, from = '.') {
  let dir = join(from, 'node_modules', name);
  if (!existsSync(dir)) dir = join('node_modules', name);
  if (!existsSync(dir)) return;
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const key = `${pkg.name}@${pkg.version}`;
  if (seen.has(key)) return;
  const lic = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? (pkg.licenses ?? []).map((l) => l.type).join(' OR ') ?? 'UNKNOWN';
  let text = '';
  for (const f of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'LICENCE', 'license.md']) if (existsSync(join(dir, f))) { text = readFileSync(join(dir, f), 'utf8').trim(); break; }
  seen.set(key, { name: pkg.name, version: pkg.version, license: lic || 'UNKNOWN', homepage: pkg.homepage ?? pkg.repository?.url ?? pkg.repository ?? '', text });
  for (const d of Object.keys(pkg.dependencies ?? {})) visit(d, dir);
}
for (const d of [...Object.keys(root.dependencies), ...bundled]) visit(d);
const list = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
const counts = {};
for (const p of list) counts[p.license] = (counts[p.license] ?? 0) + 1;
let out = `THIRD_PARTY_NOTICES — ReserveFlow ${root.version}\n\n本ソフトウェアは以下のオープンソースソフトウェアを利用しています（本番実行時に含まれるもの）。\n各ライセンス条件に従って再配布しています。\n\nライセンス内訳: ${Object.entries(counts).map(([k, v]) => `${k} ${v}件`).join(' / ')}\n\n`;
out += list.map((p) => `- ${p.name} ${p.version} (${p.license})`).join('\n');
out += '\n\n================================================================\n各ライセンス本文\n================================================================\n';
for (const p of list) out += `\n----------------------------------------------------------------\n${p.name} ${p.version} — ${p.license}\n${p.homepage ? `${String(p.homepage)}\n` : ''}\n${p.text || '(ライセンス本文はパッケージに同梱されていません。ライセンス名を参照してください)'}\n`;
out += `\n----------------------------------------------------------------\n開発・テストのみに使用（配布物には含まれない）: typescript, vite, @vitejs/plugin-react, vitest, tsx, @playwright/test (Apache-2.0), @axe-core/playwright / axe-core (MPL-2.0) 等。\nPostgreSQL（PostgreSQL License）はホスティング事業者が提供するものを利用します。\n`;
writeFileSync('buyer-docs/THIRD_PARTY_NOTICES.txt', out);
console.log(`packages: ${list.length}`, counts);
