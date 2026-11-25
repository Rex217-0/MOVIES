/**
 * Contract tests for the Tagalog worker notebook.
 *
 * The notebook runs on Kaggle, so it cannot be imported here. What CAN be pinned
 * is the contract: the routes `pilotService.ts` calls, the JSON keys it reads,
 * and — the reason this notebook exists — that its Tagalog gate actually rejects
 * the output the 3B model really produced.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const NOTEBOOK = path.join(process.cwd(), 'scripts/direk_tagalog_worker.ipynb');

interface Cell {
  cell_type: string;
  source: string[];
  outputs?: unknown[];
}

function notebook(): { cells: Cell[]; metadata: Record<string, any> } {
  return JSON.parse(fs.readFileSync(NOTEBOOK, 'utf8'));
}

function sourceOf(cell: Cell): string {
  return cell.source.join('');
}

function codeCells(): string[] {
  return notebook().cells.filter(c => c.cell_type === 'code').map(sourceOf);
}

function allSource(): string {
  return notebook().cells.map(sourceOf).join('\n');
}

/** Code cells with `#` comments stripped, so docs about a pattern are not it. */
function executableSource(): string {
  return codeCells()
    .map(src => src.split('\n').map(line => line.replace(/(^|\s)#.*$/, '')).join('\n'))
    .join('\n');
}

/**
 * The gate cell, extracted and run by a real Python interpreter.
 *
 * Running it for real is the point: a test that only greps for the word
 * "repetition" would pass while the scorer still returns 60 for obvious
 * garbage. Python is already a test dependency here (see loraNotebook.test.ts).
 */
function runGate(text: string): { score: number; issues: string[]; threshold: number } {
  const cell = codeCells().find(src => src.includes('def tagalog_report'));
  assert.ok(cell, 'the Tagalog gate cell is missing');

  // Strip the imports; the harness supplies `re` and `os` itself, so the gate
  // cannot quietly depend on torch, pandas or the model.
  const body = cell
    .split('\n')
    .filter(line => !/^\s*(import|from)\s/.test(line))
    .join('\n');

  const script = `
import json, os, re, sys
${body}
text = sys.stdin.read()
score, issues = tagalog_report(text)
print("__GATE__" + json.dumps({"score": score, "issues": issues, "threshold": MIN_TAGALOG_SCORE}))
`;

  const out = execFileSync('python3', ['-c', script], { input: text, encoding: 'utf8' });
  const line = out.split('\n').find(l => l.startsWith('__GATE__'));
  assert.ok(line, `the gate produced no result:\n${out}`);
  return JSON.parse(line.slice('__GATE__'.length));
}

/** The exact output the Qwen 2.5 3B worker produced on Kaggle, quoted verbatim. */
const REAL_BAD_OUTPUT = `Pagtitira ko ang mga kaluluwa sa isang madaling bahay na may pag-ibig sa probinsya.

Bahagi: Simula

Bahagi: Gitna

Bahagi: Wakas

Sa probinsyahan, masamang hanggang sa mga araw na ito. Ang mga tao ay hindi pa rin makatawag bilang humarap. Hindi pa rin sila makakita ng iba't ibang puso.

Masamang kasintahan ang mga pananampalataya na walang magbabago. Masamang kasintahan ang mga tao na hindi makikita ang pagkakaiba-biba.

Nakakakaban talaga ang mga sariling puso sa mga bayad na lumipas. Nakakakaban talaga ang mga sariling puso sa mga tao na hindi makikita ang pagkakaiba-biba.

Nakakakaban talaga ang mga sariling puso sa mga bayad na lumipas. Naglilibing sila sa mga bahay na masamang masamang. Hindi pa rin sila makikita ng iba't ibang puso.

Mayroon bang isang dalhin? Mayroon bang isang halimbawa ng pagkakaiba-biba? Sa mga araw na ito, hindi pa rin sila makikita.`;

/** A clean screenplay in the shape the app expects. */
const GOOD_SCREENPLAY = `PAMAGAT: Ang Huling Bangka
LOGLINE: Isang matandang mangingisda ang naghahanap ng kaniyang anak sa dagat na kinain ng bagyo.

EKSENA 1: Dalampasigan - Madaling araw
  VISUAL: Nakatanaw si Tandang Isko sa maamong dagat habang hawak ang lumang lambat.
  NARRATION: Bawat umaga ay sinusubukan niyang hanapin ang bangkang nawala noong isang taon.

EKSENA 2: Palengke - Umaga
  VISUAL: Naglalakad si Isko sa masikip na palengke at tinatanong ang mga tindera.
  NARRATION: Alam niya sa sarili na wala nang magbabalik, ngunit hindi siya tumitigil.

EKSENA 3: Bahay - Gabi
  VISUAL: Nakaupo si Isko sa harap ng larawan ng anak niya habang umiiyak.
  NARRATION: Sa wakas, tinanggap niya na ang dagat ay hindi na magbabalik sa kaniya.`;

test('the notebook exists, is valid JSON, and has no committed outputs', () => {
  assert.ok(fs.existsSync(NOTEBOOK), 'scripts/direk_tagalog_worker.ipynb is missing');
  const nb = notebook();
  assert.ok(Array.isArray(nb.cells) && nb.cells.length > 0);
  for (const cell of nb.cells) {
    assert.ok(['code', 'markdown'].includes(cell.cell_type));
    assert.ok(Array.isArray(cell.source), 'source must be a list, as Jupyter writes it');
  }
  // Outputs from a real run would embed a tunnel URL and the model's chatter.
  const outputs = nb.cells.reduce((n, c) => n + (c.outputs?.length ?? 0), 0);
  assert.equal(outputs, 0, 'the notebook ships with no saved outputs');
});

test('the notebook is configured to actually run: GPU and internet on', () => {
  const kaggle = notebook().metadata.kaggle ?? {};
  // The shipped notebook had both off. Cell 1 runs `pip install` and the model
  // download needs the network, so an offline session fails immediately.
  assert.equal(kaggle.isInternetEnabled, true, 'pip install and the model download need the network');
  assert.equal(kaggle.isGpuEnabled, true, 'a 3B model in fp16 does not run on Kaggle CPU');
  assert.equal(kaggle.accelerator, 'nvidiaTeslaT4');
});

test('every route pilotService.ts calls is served', () => {
  const src = allSource();
  for (const route of ['/health', '/v1/models', '/generate_script', '/generate_character_bible', '/breakdown_scenes', '/v1/chat/completions']) {
    assert.ok(src.includes(`"${route}"`), `missing route ${route}`);
  }
});

test('the scene shape matches what pilotService reads', () => {
  const src = allSource();
  // `pickScenes` reads `visual`; a worker that emits `visual_prompt` would make
  // every scene lose its shot description silently.
  for (const key of ['heading', 'narration', 'visual', 'mood']) {
    assert.ok(src.includes(`"${key}"`), `scene shape missing ${key}`);
  }
  assert.match(
    src,
    /scene\.get\("visual"\)\s+or\s+scene\.get\("visual_prompt"/,
    'visual_prompt is not mapped to visual',
  );
});

test('the model is loaded with the current dtype argument', () => {
  // Check the executable code, not the comments: a note explaining that
  // `torch_dtype=` is deprecated is not the same as passing it.
  const code = executableSource();
  assert.match(code, /from_pretrained\(MODEL_ID,\s*dtype=torch\.float16/, 'dtype= is the current transformers argument');
  assert.doesNotMatch(code, /torch_dtype=/, 'torch_dtype= is deprecated and warns on every run');
});

test('repetition_penalty is disabled, because it is what poisoned the Tagalog', () => {
  const code = executableSource();
  // This is the actual root cause. At 1.1 the model is pushed off the highest
  // frequency tokens, which in Tagalog are the function words ang/ng/sa/na/ay.
  // That produced "Nakakakaban talaga ang mga sariling puso". The notebook may
  // still NAME 1.1 in a comment explaining the bug; what matters is that no
  // generate() call passes it.
  assert.match(code, /repetition_penalty=1\.0/, 'repetition_penalty must be 1.0 (off)');
  assert.doesNotMatch(code, /repetition_penalty=1\.[1-9]/, 'any value above 1.0 poisons Tagalog function words');
});

test('the gate rejects the output the model really produced', () => {
  const { score, issues, threshold } = runGate(REAL_BAD_OUTPUT);
  assert.ok(
    score < threshold,
    `the real garbage must be rejected, but it scored ${score} (threshold ${threshold}): ${issues.join('; ')}`,
  );
  assert.ok(issues.length > 0, 'a rejected draft must say why');
});

test('the gate accepts a clean screenplay', () => {
  const { score, issues, threshold } = runGate(GOOD_SCREENPLAY);
  assert.ok(
    score >= threshold,
    `a clean screenplay must pass, but it scored ${score}: ${issues.join('; ')}`,
  );
});

test('the gate does not reject simple, correct Tagalog', () => {
  const { score, threshold } = runGate(
    'Ang bata ay kumain ng mangga. Masaya siya dahil matamis ito. Umuwi siya sa bahay nang nakangiti.',
  );
  assert.ok(score >= threshold, `plain correct Tagalog scored only ${score}`);
});

test('the gate names the invented word it found', () => {
  const { issues } = runGate(REAL_BAD_OUTPUT);
  assert.ok(
    issues.some(i => i.includes('pagkakaiba-biba')),
    `expected the invented reduplication to be named: ${issues.join('; ')}`,
  );
});

test('a short, clean sentence is not punished for being short', () => {
  const { score, threshold } = runGate('Oo.');
  // The function-word ratio is only meaningful on real prose; a two-word answer
  // must not be scored as garbage.
  assert.ok(score >= threshold, `"Oo." scored ${score}`);
});

test('the gate asks for the genre, not only the length and mood', () => {
  const code = executableSource();
  // Without a genre the model invents its own, and that is where the bad output
  // started. `missing_fields` must include it.
  assert.match(code, /missing\.append\("uri"\)/, 'the gate never asks for the genre');
  assert.match(code, /"uri":\s*"Anong uri ng pelikula/, 'there is no question text for the genre');
});

test('the gate runs before the model check, so it can answer while weights load', () => {
  const cell = codeCells().find(src => src.includes('def chat_completions'));
  assert.ok(cell, 'chat_completions is missing');
  // Slice from the handler itself: the earlier handlers in the same cell also
  // check MODEL_READY, and their position says nothing about this order.
  const call = cell.slice(cell.indexOf('def chat_completions'));
  const gateAt = call.indexOf('if missing:');
  const modelAt = call.indexOf('if not MODEL_READY:');
  assert.ok(gateAt > 0 && modelAt > 0, 'both checks must exist in chat_completions');
  assert.ok(
    gateAt < modelAt,
    'the gate is pure string logic and needs no model; behind the model check it stays silent for the whole model load',
  );
});

test('the worker fails honestly instead of inventing a screenplay', () => {
  const src = allSource();
  assert.ok(src.includes('AI_UNAVAILABLE'), 'the honest error code is missing');
  assert.ok(src.includes('503'), 'a failure must answer 503');
  assert.ok(src.includes('MODEL_READY'), 'there is no readiness flag to check');
  assert.match(src, /if not MODEL_READY:\s*\n\s*return unavailable/, 'a missing model must be an honest 503');
});

test('the worker never answers with a non-JSON 200 for the scene breakdown', () => {
  const src = allSource();
  // The shipped version returned `{"text": raw}` on a parse failure, which
  // reads to the app as a scene list with zero scenes — a silent empty film.
  assert.doesNotMatch(src, /return \{"text": raw\}/, 'a parse failure must not masquerade as a scene list');
  assert.ok(src.includes('Hindi JSON ang sagot'), 'a bad JSON answer must be reported');
});

test('the detail gate looks at the whole conversation, not the last message', () => {
  const src = allSource();
  // Otherwise "3 minuto" as a follow-up answer erases the genre from the brief.
  assert.ok(src.includes('user_turns'), 'the gate only reads one message');
  assert.ok(src.includes('whole = "\\n".join(user_turns)'), 'the turns are not joined for the gate');
});

test('the prompt asks for a screenplay, not a short story', () => {
  const src = allSource();
  assert.ok(src.includes('EKSENA 1:'), 'the prompt does not ask for numbered scenes');
  assert.ok(src.includes('VISUAL:'), 'the prompt does not ask for a visual per scene');
  assert.ok(src.includes('NARRATION:'), 'the prompt does not ask for narration per scene');
});

test('the notebook holds no secret', () => {
  const src = allSource();
  for (const pattern of [
    /hf_[A-Za-z0-9]{10,}/,
    /AIza[0-9A-Za-z_-]{30,}/,
    /sk-[A-Za-z0-9]{20,}/,
    /ghp_[A-Za-z0-9]{20,}/,
    /BEGIN [A-Z ]*PRIVATE KEY/,
  ]) {
    assert.doesNotMatch(src, pattern);
  }
});

test('the tunnel prefers a permanent named tunnel and warns when it is temporary', () => {
  const src = allSource();
  assert.ok(src.includes('CF_TUNNEL_TOKEN'), 'the named tunnel token is never read');
  assert.ok(src.includes('CF_TUNNEL_HOSTNAME'), 'the named tunnel hostname is never read');
  assert.ok(src.includes('PERMANENTE'), 'the operator is never told the URL is stable');
  assert.ok(src.includes('PANSAMANTALA'), 'the operator is never warned the URL will change');
  const permanent = src.indexOf('if CF_TOKEN and CF_HOSTNAME:');
  const quick = src.indexOf('"tunnel", "--url"');
  assert.ok(permanent > 0 && permanent < quick, 'the permanent tunnel must be tried first');
});

test('the notebook can register its own URL with the app', () => {
  const src = allSource();
  assert.ok(src.includes('/api/pilot/update-kaggle-url'), 'the sync route is never called');
  assert.ok(src.includes('PILOT_SYNC_TOKEN'), 'the sync token is never read');
  // The token goes in a header, never in the URL, so it cannot leak into logs.
  assert.match(src, /Authorization": f"Bearer \{SYNC_TOKEN\}/);
});
