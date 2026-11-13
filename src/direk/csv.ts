/** Minimal CSV reader shared by the reference catalog and market intel. */

import fs from 'node:fs';

export interface Csv {
  header: string[];
  rows: string[][];
}

/** Parse one CSV line, honouring double-quoted fields with embedded commas. */
export function parseLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export function parseCsvFile(file: string): Csv | null {
  if (!fs.existsSync(file)) return null;
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.length > 0);
    if (!lines.length) return null;
    const header = parseLine(lines[0]);
    const rows: string[][] = [];
    for (let i = 1; i < lines.length; i++) rows.push(parseLine(lines[i]));
    return { header, rows };
  } catch {
    return null;
  }
}

export function pick(header: string[], row: string[], name: string): string {
  const idx = header.indexOf(name);
  return idx >= 0 ? (row[idx] ?? '') : '';
}

/** Turn a Python-list-looking cell ("['Comedy', 'Drama']") into "Comedy, Drama". */
export function cleanListCell(value: string): string {
  return value
    .replace(/^\[|\]$/g, '')
    .replace(/['"]/g, '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .join(', ');
}
