import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemMap, type MapNode, type ProbeEnv } from './systemMap.ts';

/**
 * A fake ProbeEnv is a stand-in for the network and the environment, not for
 * our own code: buildSystemMap runs for real against it, so the tests exercise
 * the true mapping from probe result to node status.
 */
function fakeEnv(over: Partial<ProbeEnv> = {}): ProbeEnv {
  return {
    getEnv: () => undefined,
    fetchJson: async () => ({ ok: false, status: 0, error: 'fetch failed' }),
    comfyAvailable: async () => false,
    comfyUrl: 'http://127.0.0.1:8188',
    ollamaUrl: 'http://127.0.0.1:11434',
    ollamaModel: 'qwen2.5:3b',
    ffmpegAvailable: async () => true,
    ...over,
  };
}

const find = (nodes: MapNode[], id: string): MapNode | undefined =>
  nodes.find(n => n.id === id);

test('the map always contains the centre and every documented node', async () => {
  const map = await buildSystemMap(fakeEnv());
  assert.equal(map.center, 'movie-creator');
  const ids = map.nodes.map(n => n.id);
  for (const id of [
    'movie-creator', 'comfyui', 'openhands', 'kaggle', 'colab', 'google-cloud',
    'firebase', 'github', 'copilot', 'google-ai-studio', 'manus',
    'gemini', 'ollama', 'wan', 'claude', 'deepseek', 'meta', 'ffmpeg', 'gdrive',
  ]) {
    assert.ok(ids.includes(id), `missing node ${id}`);
  }
});

test('the centre node is always active — the process answering is the proof', async () => {
  const map = await buildSystemMap(fakeEnv());
  const centre = map.nodes.find(n => n.layer === 'center');
  assert.equal(centre?.id, 'movie-creator');
  assert.equal(centre?.status, 'active');
});

test('a cloud provider that answers 200 is active, with a real round-trip', async () => {
  const map = await buildSystemMap(fakeEnv({
    fetchJson: async url => url.includes('github.com')
      ? { ok: true, status: 200 }
      : { ok: false, status: 0, error: 'fetch failed' },
  }));
  const gh = map.nodes.find(n => n.id === 'github');
  assert.equal(gh?.status, 'active');
  assert.equal(typeof gh?.latency_ms, 'number');
  assert.match(gh?.detail || '', /Sumagot/);
});

test('a provider that answers with an error status is error, never active', async () => {
  const map = await buildSystemMap(fakeEnv({
    fetchJson: async url => url.includes('api.github.com')
      ? { ok: false, status: 503 }
      : { ok: false, status: 0, error: 'fetch failed' },
  }));
  const gh = map.nodes.find(n => n.id === 'github');
  assert.equal(gh?.status, 'error');
  assert.match(gh?.detail || '', /503/);
});

test('a provider we cannot reach is dead, not faked alive', async () => {
  const map = await buildSystemMap(fakeEnv({
    fetchJson: async () => ({ ok: false, status: 0, error: 'fetch failed' }),
  }));
  for (const id of ['github', 'kaggle', 'colab', 'manus', 'google-ai-studio']) {
    assert.equal(find(map.nodes as any, id)?.status, 'dead', `${id} must be dead`);
  }
});

test('Ollama is active only when the configured model is really present', async () => {
  const withModel = await buildSystemMap(fakeEnv({
    fetchJson: async url => url.includes('11434')
      ? { ok: true, status: 200, body: { models: [{ name: 'qwen2.5:3b' }] } }
      : { ok: false, status: 0, error: 'fetch failed' },
  }));
  assert.equal(withModel.nodes.find(n => n.id === 'ollama')?.status, 'active');

  const wrongModel = await buildSystemMap(fakeEnv({
    fetchJson: async url => url.includes('11434')
      ? { ok: true, status: 200, body: { models: [{ name: 'llama3:8b' }] } }
      : { ok: false, status: 0, error: 'fetch failed' },
  }));
  const ollama = wrongModel.nodes.find(n => n.id === 'ollama');
  assert.equal(ollama?.status, 'error');
  assert.match(ollama?.detail || '', /wala ang model/);
});

test('Ollama disabled by env is dead and says why', async () => {
  const map = await buildSystemMap(fakeEnv({
    getEnv: name => (name === 'OLLAMA_DISABLE' ? '1' : undefined),
  }));
  const ollama = map.nodes.find(n => n.id === 'ollama');
  assert.equal(ollama?.status, 'dead');
  assert.match(ollama?.detail || '', /OLLAMA_DISABLE/);
});

test('ComfyUI off by env is dead and does not claim a probe ran', async () => {
  let probed = false;
  const map = await buildSystemMap(fakeEnv({
    getEnv: name => (name === 'COMFYUI_DISABLE' ? '1' : undefined),
    comfyAvailable: async () => { probed = true; return true; },
  }));
  const comfy = map.nodes.find(n => n.id === 'comfyui');
  assert.equal(comfy?.status, 'dead');
  assert.equal(probed, false, 'a disabled ComfyUI must not be probed');
});

test('ComfyUI that answers is active, with a real round-trip', async () => {
  const map = await buildSystemMap(fakeEnv({ comfyAvailable: async () => true }));
  const comfy = map.nodes.find(n => n.id === 'comfyui');
  assert.equal(comfy?.status, 'active');
  assert.equal(typeof comfy?.latency_ms, 'number');
});

test('a key that is configured but unverified is standby, never active', async () => {
  const map = await buildSystemMap(fakeEnv({
    getEnv: name => (name === 'GEMINI_API_KEY' ? 'fake-key' : undefined),
  }));
  assert.equal(map.nodes.find(n => n.id === 'gemini')?.status, 'standby');
  // And with no key at all it is dead.
  const empty = await buildSystemMap(fakeEnv());
  assert.equal(empty.nodes.find(n => n.id === 'gemini')?.status, 'dead');
});

test('paid cloud is only standby when opted in, and dead otherwise', async () => {
  const optedIn = await buildSystemMap(fakeEnv({
    getEnv: name => (name === 'FAL_KEY' ? 'fake' : undefined),
  }));
  assert.equal(optedIn.nodes.find(n => n.id === 'wan')?.status, 'standby');
  const off = await buildSystemMap(fakeEnv());
  assert.equal(off.nodes.find(n => n.id === 'wan')?.status, 'dead');
});

test('OpenHands is dead without a URL and probed when one is given', async () => {
  const noUrl = await buildSystemMap(fakeEnv());
  assert.equal(noUrl.nodes.find(n => n.id === 'openhands')?.status, 'dead');

  const withUrl = await buildSystemMap(fakeEnv({
    openhandsUrl: 'http://127.0.0.1:9999',
    fetchJson: async url => url.includes('9999')
      ? { ok: true, status: 200 }
      : { ok: false, status: 0, error: 'fetch failed' },
  }));
  const oh = withUrl.nodes.find(n => n.id === 'openhands');
  assert.equal(oh?.status, 'active');
});

test('the AI models in front are wireless; the tools are wired', async () => {
  const map = await buildSystemMap(fakeEnv());
  for (const id of ['gemini', 'ollama', 'wan', 'claude', 'deepseek', 'meta']) {
    assert.equal(map.nodes.find(n => n.id === id)?.wired, false, `${id} must be wireless`);
  }
  for (const id of ['github', 'copilot', 'kaggle', 'comfyui', 'openhands']) {
    assert.equal(map.nodes.find(n => n.id === id)?.wired, true, `${id} must be wired`);
  }
});

test('every node carries the honest fields the UI needs', async () => {
  const map = await buildSystemMap(fakeEnv());
  for (const n of map.nodes) {
    assert.ok(n.name && n.role && n.detail && n.probe, `${n.id} is missing a field`);
    assert.ok(['active', 'error', 'standby', 'dead'].includes(n.status));
    assert.ok(['center', 'behind', 'left', 'right', 'front'].includes(n.layer));
  }
  assert.equal(
    map.counts.active + map.counts.error + map.counts.standby + map.counts.dead,
    map.nodes.length,
    'the counts must add up to the node list',
  );
});
