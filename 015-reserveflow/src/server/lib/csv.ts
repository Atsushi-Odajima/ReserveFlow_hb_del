/** Neutralize spreadsheet formula injection: prefix risky leading chars with an apostrophe. */
export function csvSafe(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r|%]/.test(s)) s = `'${s}`;
  return s;
}

function quote(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** UTF-8 BOM + CRLF CSV (opens correctly in Excel). */
export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map((h) => quote(csvSafe(h))).join(',')];
  for (const r of rows) lines.push(r.map((c) => quote(csvSafe(c))).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** RFC4180-ish parser (handles quotes, CRLF, BOM). */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') {
      row.push(cur);
      cur = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
    } else cur += c;
  }
  if (cur !== '' || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Undo csvSafe's apostrophe prefix when re-importing our own exports. */
export function csvUnsafe(s: string): string {
  return /^'[=+\-@\t\r|%]/.test(s) ? s.slice(1) : s;
}
