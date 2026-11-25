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
interface GateResult {
  score: number;
  issues: string[];
  threshold: number;
  accepted?: boolean;
  shape?: { eksena: number; visual: number; narration: number; pamagat: number };
}

function runGate(text: string, screenplay = false): GateResult {
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
payload = {"threshold": MIN_TAGALOG_SCORE}
if ${screenplay ? 'True' : 'False'}:
    ok, score, issues, shape = screenplay_report(text)
    payload.update({"score": score, "issues": issues, "accepted": ok, "shape": shape})
else:
    score, issues = tagalog_report(text)
    payload.update({"score": score, "issues": issues})
print("__GATE__" + json.dumps(payload))
`;

  const out = execFileSync('python3', ['-c', script], { input: text, encoding: 'utf8' });
  const line = out.split('\n').find(l => l.startsWith('__GATE__'));
  assert.ok(line, `the gate produced no result:\n${out}`);
  return JSON.parse(line.slice('__GATE__'.length)) as GateResult;
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


/**
 * The three outputs from Rex's real Kaggle run (2026-11-25), quoted verbatim.
 *
 * These matter more than any sample I could invent: the gate passed two of them
 * before the shape check existed, because their Tagalog, while wrong, is not
 * repetitive enough to trip the language score alone.
 */
const REAL_RUN_HORROR = `Pagbabago: Ang Paglinting ng Pangangasiwa
Paglinting ng Pangangasiwa
Simula:
"Sa mga araw na ito ng proseso ng paglinting, ang pangangasiwa ay hindi makakakuha ng sumusunod na kasaysayan."
Gitna:
"Nagiging masariling panahon na lang, kapag ang mga tao ay natapos sila ng paglinting. Hindi pa rin sila makakasama sa kanilang mga sarili."
Wika:
"Pagguluhan sila ngunit hindi nila alam kung ano ang ibig sila matutunan. Naglalarawan sila ng mga puso ng mga tao, ngunit hindi sila makakatawan sa kanyang mga damdamin."
Pagtatayo:
"Hindi sila makakatawan sa kanyang mga damdamin, at hindi sila makakakuha ng sumusunod na kasaysayan. Kaya't hindi sila makakakuha ng sumusunod na kasaysayan."
Wika:
"Hindi sila makakakuha ng sumusunod na kasaysayan, at hindi sila makakasama sa kanilang mga sarili. Hindi sila makakasama sa kanilang mga sarili, at hindi sila makakasama sa kanilang mga sarili."`;

const REAL_RUN_ROMANCE = `Pagbabago ng Pamagat: "Diwa sa Pag-ibig"
Simula:
"Diwa sa Pag-ibig"
Gitna:
Isang malaking balay ng pagsamba ang pinakamataas na umaga sa lungsod. Sa loob ng kanilang parusa, isa pa rin sila'y nagtrato ng pagkain at paglalarawan. Si Leon, isang mag-aaral na babae, ay nagpunta sa panahon ng pagkain bilang parte ng iba't ibang trabaho.
Wakas:
Sa ilalim ng malaking taas ng pagkain, tinukoy si Leon sa kanilang taberno ang kanyang kapamilya. Ang mga anak niya ay naglabas ng mga sigla at pagbasa sa kanya. Ito ang pinaka-pagmamananahan sa lahat - ang pagkain, ang paglabas ng mga anak, at ang di-dili-tiwasang pag-iiba ng pag-ibig sa kanyang sariling halip na nagtrato ng pagkain.`;

const REAL_RUN_COMEDY = `"Palengke Palpit"
Simula:
Tindera ni Juan ay nagpunta sa palengke.
Gitna:
Nakita niya ang mga anak niya sa pista ng pagdami.
Juan: "Ani, anak! Hindi ka ba nagtrato ng pagdami?"
Wakas:
Nag-ask siya kay mga magbigay ng pagdami.
Juan: "Sige, anu-ano ang pricelist mo?"
Mga anak ni Juan: "Sir, 50 per unit."
Juan: "Ha? Ano nga bang 50 pesos ang isang unit?"
Mga anak ni Juan: "Eh, hindi pa rin kami makakakuha ng 50 pesos sa isang unit."
Juan: "Masakit po talaga ako, anak!"
Juan: "Diyosito, di ko alam kung ano ang problema nila."
Juan: "Ani, anak! Nagpunta ako dito para makuha ang pagdami, hindi lang para makuha ang halaman mo!"`;

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

test('all three real Kaggle outputs are rejected as screenplays', () => {
  // The language score alone passed two of these. The shape check is what
  // catches them: the model wrote "Simula/Gitna/Wakas" prose, and the app reads
  // EKSENA/VISUAL/NARRATION, so a passing score here meant an empty film.
  for (const [label, text] of Object.entries({
    horror: REAL_RUN_HORROR,
    romance: REAL_RUN_ROMANCE,
    comedy: REAL_RUN_COMEDY,
  })) {
    const result = runGate(text, true);
    assert.equal(result.accepted, false, `${label} was accepted as a screenplay`);
    assert.equal(result.shape?.eksena, 0, `${label} should have zero EKSENA headings`);
    assert.ok(
      result.issues.some(i => i.includes('eksena')),
      `${label} was rejected without naming the missing scenes: ${result.issues.join('; ')}`,
    );
  }
});

test('a real screenplay still passes the shape check', () => {
  const result = runGate(GOOD_SCREENPLAY, true);
  assert.equal(result.accepted, true, `clean screenplay rejected: ${result.issues.join('; ')}`);
  assert.equal(result.shape?.eksena, 3);
  assert.equal(result.shape?.visual, 3);
  assert.equal(result.shape?.narration, 3);
});

test('an essay with a fake VISUAL line bolted on is still rejected', () => {
  // VISUAL/NARRATION only count when they sit under an EKSENA heading. Counting
  // them anywhere would let a prose answer pass by appending two lines.
  const trapped = `${REAL_RUN_ROMANCE}\nVISUAL: isang eksena\nNARRATION: isang linya`;
  const result = runGate(trapped, true);
  assert.equal(result.accepted, false);
  assert.equal(result.shape?.eksena, 0);
  assert.equal(result.shape?.visual, 0, 'a VISUAL outside any EKSENA must not count');
});

test('the invented-word rule does not punish real Tagalog compounds', () => {
  // The first version of this rule flagged 13 of these 31 words. A gate that
  // rejects "bahay-kubo" and "takip-silim" is worse than no gate: it would train
  // Rex to ignore it.
  const real = [
    'bahay-kubo', 'balik-aral', 'anak-araw', 'tao-tao', 'iba-iba', 'sari-sari',
    'araw-araw', 'gabi-gabi', 'sabay-sabay', 'dahan-dahan', 'unti-unti',
    'pag-asa', 'pag-ibig', 'nag-iisip', 'mag-aaral', 'di-wasto', 'bigay-kaya',
    'kapit-bisig', 'lakad-pagong', 'ningas-kugon', 'patay-malisya',
    'takip-silim', 'bahag-hari', 'agaw-buhay', 'hampas-lupa',
    'pakikipag-ugnayan', 'nagpapasalamat', 'tagapagtanggol',
  ];
  const cell = codeCells().find(src => src.includes('def reduplication_errors'));
  assert.ok(cell, 'reduplication_errors is missing');
  const body = cell
    .split('\n')
    .filter(line => !/^\s*(import|from)\s/.test(line))
    .join('\n');
  const script = `
import json, os, re, sys
${body}
words = json.loads(sys.stdin.read())
print("__W__" + json.dumps({w: bool(reduplication_errors(w)) for w in words}))
`;
  const out = execFileSync('python3', ['-c', script], {
    input: JSON.stringify(real),
    encoding: 'utf8',
  });
  const flagged = JSON.parse(out.split('\n').find(l => l.startsWith('__W__'))!.slice(5));
  const bad = Object.entries(flagged).filter(([, v]) => v).map(([k]) => k);
  assert.deepEqual(bad, [], `real Tagalog compounds flagged as invented: ${bad.join(', ')}`);
});

test('the invented-word rule still catches the garbage it was written for', () => {
  const cell = codeCells().find(src => src.includes('def reduplication_errors'))!;
  const body = cell
    .split('\n')
    .filter(line => !/^\s*(import|from)\s/.test(line))
    .join('\n');
  const script = `
import json, os, re, sys
${body}
words = json.loads(sys.stdin.read())
print("__W__" + json.dumps({w: bool(reduplication_errors(w)) for w in words}))
`;
  const out = execFileSync('python3', ['-c', script], {
    input: JSON.stringify(['pagkakaiba-biba', 'masamang-masamang']),
    encoding: 'utf8',
  });
  const flagged = JSON.parse(out.split('\n').find(l => l.startsWith('__W__'))!.slice(5));
  assert.equal(flagged['pagkakaiba-biba'], true, 'pagkakaiba-biba must be flagged');
  assert.equal(flagged['masamang-masamang'], true, 'masamang-masamang must be flagged');
});

test('generate_script refuses to return prose it cannot turn into scenes', () => {
  const src = codeCells().find(s => s.includes('def generate_script'))!;
  assert.match(src, /screenplay_report\(/, 'generate_script never calls the screenplay gate');
  // The failure branch is `if not ok:` ... `return unavailable(...)`, with the
  // rationale comment in between. Match the branch, not the whitespace.
  assert.match(
    src,
    /if not ok:[\s\S]{0,400}?return unavailable\(/,
    'generate_script must return an honest 503 when the gate fails, not the prose',
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
