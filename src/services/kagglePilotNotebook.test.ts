import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const notebookPath = path.join(process.cwd(), 'scripts/direk_kaggle_pilot.ipynb');

function notebookSource(): string {
  const nb = JSON.parse(fs.readFileSync(notebookPath, 'utf8'));
  return nb.cells.map((c: { source: string[] }) => c.source.join('')).join('\n');
}

test('the Kaggle Pilot notebook is present and valid JSON', () => {
  assert.ok(fs.existsSync(notebookPath), 'scripts/direk_kaggle_pilot.ipynb is missing');
  const nb = JSON.parse(fs.readFileSync(notebookPath, 'utf8'));
  assert.equal(nb.nbformat, 4);
  assert.ok(Array.isArray(nb.cells) && nb.cells.length > 0);
  for (const cell of nb.cells) {
    assert.ok(['code', 'markdown'].includes(cell.cell_type));
    assert.ok(Array.isArray(cell.source));
  }
});

test('the notebook serves exactly the routes pilotService.ts calls', () => {
  const source = notebookSource();
  // The bridge POSTs to these three and probes /health. A notebook that only
  // speaks /v1/chat/completions would never work with the app.
  for (const route of ['/health', '/generate_script', '/generate_character_bible', '/breakdown_scenes']) {
    assert.match(source, new RegExp(`["']${route.replace(/\//g, '\\/')}["']`), `missing route ${route}`);
  }
  // The scene route must answer with a `scenes` array of the right keys.
  for (const key of ['heading', 'narration', 'visual', 'mood']) {
    assert.ok(source.includes(key), `scene shape missing ${key}`);
  }
});

test('the notebook is the Qwen 2.5 3B worker and opens a tunnel', () => {
  const source = notebookSource();
  assert.ok(source.includes('Qwen/Qwen2.5-3B-Instruct'), 'expected the 3B Instruct checkpoint');
  assert.ok(source.includes('cloudflared'), 'expected the Cloudflare tunnel setup');
  assert.ok(source.includes('KAGGLE_PILOT_URL'), 'expected the tunnel URL to be surfaced');
});

test('the notebook fails honestly when the model is not loaded', () => {
  const source = notebookSource();
  // Every generation route must 503 rather than fabricate a script.
  assert.ok(source.includes('MODEL_READY'));
  assert.match(source, /_unavailable\(/);
  assert.ok(source.includes('503'), 'expected an honest 503 on failure');
});

test('the notebook holds no secret', () => {
  const source = notebookSource();
  for (const pattern of [/hf_[A-Za-z0-9]{10,}/, /AIza[0-9A-Za-z_\-]{30,}/, /sk-[A-Za-z0-9]{20,}/, /ghp_[A-Za-z0-9]{20,}/, /BEGIN [A-Z ]*PRIVATE KEY/]) {
    assert.doesNotMatch(source, pattern);
  }
});
