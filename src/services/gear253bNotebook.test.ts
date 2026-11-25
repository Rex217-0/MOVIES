import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const notebookPath = path.join(process.cwd(), 'scripts/direk_kaggle_gear253b.ipynb');

interface Cell {
  cell_type: string;
  source: string[];
}

function notebook(): { cells: Cell[] } {
  return JSON.parse(fs.readFileSync(notebookPath, 'utf8'));
}

function codeCells(): string[] {
  return notebook()
    .cells.filter(c => c.cell_type === 'code')
    .map(c =>
      c.source
        .join('')
        .split('\n')
        .map(line => line.replace(/(["'])(?:\\.|(?!\1).)*\1/g, '""'))
        .join('\n'),
    );
}

function notebookSource(): string {
  return notebook()
    .cells.map(c => c.source.join(''))
    .join('\n');
}

test('the gear 253B notebook is present and valid', () => {
  assert.ok(fs.existsSync(notebookPath), 'scripts/direk_kaggle_gear253b.ipynb is missing');
  const nb = notebook();
  assert.ok(Array.isArray(nb.cells) && nb.cells.length > 0);
  for (const cell of nb.cells) {
    assert.ok(['code', 'markdown'].includes(cell.cell_type));
    assert.ok(Array.isArray(cell.source));
  }
});

test('the notebook serves exactly the routes pilotService.ts calls', () => {
  const source = notebookSource();
  for (const route of ['/health', '/generate_script', '/generate_character_bible', '/breakdown_scenes']) {
    assert.ok(source.includes(`"${route}"`), `missing route ${route}`);
  }
  for (const key of ['heading', 'narration', 'visual', 'mood']) {
    assert.ok(source.includes(key), `scene shape missing ${key}`);
  }
});

test('every module the notebook uses is imported before use', () => {
  // A cell once used `re` without importing it: the tunnel cell died with
  // NameError, so the worker never published a URL and the app stayed offline.
  const known = new Set([
    're', 'os', 'sys', 'json', 'time', 'threading', 'subprocess', 'shutil', 'glob',
    'ipaddress', 'urllib', 'requests', 'torch', 'pandas', 'uvicorn', 'transformers',
  ]);
  const bound = new Set<string>();

  for (const src of codeCells()) {
    const body: string[] = [];
    for (const line of src.split('\n')) {
      const names = /^\s*(?:from\s+[\w.]+\s+)?import\s+(.+)$/.exec(line)?.[1];
      if (names) {
        for (const part of names.split(',')) {
          const alias = /\s+as\s+/.test(part) ? part.split(/\s+as\s+/)[1] : part;
          bound.add(alias.trim().split('.')[0]);
        }
        continue;
      }
      body.push(line);
    }
    for (const m of body.join('\n').matchAll(/\b([a-z_][a-z0-9_]*)\.[A-Za-z_]/g)) {
      const mod = m[1];
      if (!known.has(mod)) continue;
      assert.ok(bound.has(mod), `cell uses \`${mod}\` before it is imported`);
    }
  }
});

test('the notebook is the Qwen 2.5 3B worker and opens a tunnel', () => {
  const source = notebookSource();
  assert.ok(source.includes('Qwen/Qwen2.5-3B-Instruct'));
  assert.ok(source.includes('cloudflared'));
  assert.ok(source.includes('KAGGLE_PILOT_URL'));
});

test('the notebook fails honestly instead of inventing a script', () => {
  const source = notebookSource();
  assert.ok(source.includes('MODEL_READY'));
  assert.ok(source.includes('503'));
  assert.ok(source.includes('AI_UNAVAILABLE'));
});

test('the notebook holds no secret', () => {
  const source = notebookSource();
  for (const pattern of [
    /hf_[A-Za-z0-9]{10,}/,
    /AIza[0-9A-Za-z_-]{30,}/,
    /sk-[A-Za-z0-9]{20,}/,
    /ghp_[A-Za-z0-9]{20,}/,
    /BEGIN [A-Z ]*PRIVATE KEY/,
  ]) {
    assert.doesNotMatch(source, pattern);
  }
});

test('the notebook prefers the free permanent ngrok tunnel', () => {
  const source = notebookSource();
  // ngrok's free plan includes one static domain per account, so this is the
  // option that needs no purchased domain. It has to come before the
  // Cloudflare fallbacks, which either need a domain or change URL each run.
  assert.ok(source.includes('NGROK_AUTHTOKEN'), 'NGROK_AUTHTOKEN is never read');
  assert.ok(source.includes('ngrok-v3-stable-linux-amd64'), 'the ngrok binary is never fetched');
  const ngrokAt = source.indexOf('if NGROK_AUTHTOKEN:');
  const cloudflareAt = source.indexOf('cloudflared');
  assert.ok(ngrokAt > 0, 'the ngrok branch is missing');
  assert.ok(ngrokAt < cloudflareAt, 'ngrok must be tried before Cloudflare');
});

test('the ngrok authtoken never reaches argv', () => {
  const cell = notebook().cells[8]!.source.join('');
  // `ps aux` is world-readable on a shared host, so the token goes in through
  // the environment only. A `--authtoken` flag would leak it to every user.
  assert.doesNotMatch(cell, /--authtoken/);
  assert.ok(cell.includes('ng_env["NGROK_AUTHTOKEN"]'), 'the token is not passed via the environment');
});

test('the tunnel cell reports whether the URL is permanent', () => {
  const cell = notebook().cells[8]!.source.join('');
  assert.ok(cell.includes('PERMANENTE'), 'the operator is never told the URL is stable');
  assert.ok(cell.includes('PANSAMANTALA'), 'the operator is never warned the URL will change');
});

test('the app asks ngrok to skip its browser warning page', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/services/pilotService.ts'), 'utf8');
  // The free tier answers browser-like clients with an HTML warning instead of
  // the API response, which would read as a broken worker.
  assert.ok(src.includes('ngrok-skip-browser-warning'), 'the ngrok warning header is missing');
});
