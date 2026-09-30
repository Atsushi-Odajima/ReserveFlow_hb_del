export function normEmail(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  return s || null;
}

export function normPhone(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.normalize('NFKC').replace(/[^0-9+]/g, '');
  return s || null;
}

export function normName(v: string): string {
  return v.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}
