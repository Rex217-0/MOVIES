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

/**
 * Read a CSV one line at a time, handing each row to `onRow`.
 *
 * `parseCsvFile` holds the whole file plus every split line and parsed cell at
 * once: the 34MB Kaggle metadata CSV spikes the heap by ~900MB that way, which
 * OOM-kills a 512MB container. Reading in fixed-size chunks keeps peak memory
 * flat regardless of file size. Rows whose field count differs from the header
 * are skipped, so a stray newline cannot shift the columns.
 */
export function forEachCsvRow(
  file: string,
  onRow: (header: string[], row: string[]) => void,
  chunkSize = 64 * 1024,
): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return false;
  }
  try {
    const buf = Buffer.allocUnsafe(chunkSize);
    let carry = '';
    let header: string[] | null = null;
    const handle = (line: string) => {
      if (!line) return;
      const cells = parseLine(line);
      if (!header) {
        header = cells;
        return;
      }
      if (cells.length === header.length) onRow(header, cells);
    };
    for (;;) {
      const n = fs.readSync(fd, buf, 0, chunkSize, null);
      if (n === 0) break;
      carry += buf.toString('utf8', 0, n);
      let start = 0;
      for (let nl = carry.indexOf('\n'); nl !== -1; nl = carry.indexOf('\n', start)) {
        handle(carry.slice(start, nl).replace(/\r$/, ''));
        start = nl + 1;
      }
      carry = carry.slice(start);
    }
    handle(carry.replace(/\r$/, ''));
    return true;
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
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
