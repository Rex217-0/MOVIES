import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FsDriveStore, GoogleDriveStore, sha256, driveStoreFromEnv, type DriveStore,
} from './trainDrive.ts';
import {
  ColabTrainBackend, buildColabJob, jobPaths, parseKohyaConfig,
  readColabStatus, jobStatusForState, type ColabState,
} from './colabTrainer.ts';
import { LocalTrainBackend, trainBackendName } from './trainer.ts';
import { createTrainBackend } from './trainBackend.ts';

/** Run `fn` with the given env vars, restoring them afterwards. */
async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void> | void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('timed out waiting for the job to finish');
}

/** An in-memory Drive, so the tests never touch the network. */
class MemoryDriveStore implements DriveStore {
  readonly kind = 'gdrive' as const;
  readonly files = new Map<string, Buffer>();

  async read(rel: string): Promise<Buffer | null> {
    return this.files.get(rel) ?? null;
  }

  async write(rel: string, data: Buffer): Promise<void> {
    this.files.set(rel, data);
  }

  async list(prefix: string): Promise<string[]> {
    const base = prefix.replace(/\/+$/, '');
    return [...this.files.keys()].filter(k => k === base || k.startsWith(`${base}/`)).sort();
  }

  async remove(rel: string): Promise<void> {
    this.files.delete(rel);
  }
}

const CONFIG = `[general]
enable_bucket = true
output_dir = "/runs/x/out"
output_name = "t_x"
save_model_as = "safetensors"

[[datasets]]
resolution = 768
batch_size = 1

  [[datasets.subsets]]
  image_dir = "/runs/x/dataset"
  caption_extension = ".txt"
  num_repeats = 7

[network_arguments]
network_module = "networks.lora"
network_dim = 24
network_alpha = 12

[optimizer_arguments]
learning_rate = 1e-4
optimizer_type = "AdamW8bit"

[training_arguments]
pretrained_model_name_or_path = "/models/base.safetensors"
max_train_epochs = 3
seed = 7
`;

function startOptions(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job1',
    title: 'Alat ng Dagat',
    trigger: 'direk_alat',
    root: tmpDir('run-'),
    captions: [{ name: 'direk_alat_001', text: 'direk_alat, a weathered face' }],
    images: new Map([['direk_alat_001', Buffer.from('PNGDATA')]]),
    config: CONFIG,
    ...overrides,
  };
}

test('TRAIN_BACKEND defaults to local, and local is unchanged', async () => {
  await withEnv({ TRAIN_BACKEND: undefined }, () => {
    assert.equal(trainBackendName(), 'local');
    const backend = createTrainBackend();
    assert.ok(backend instanceof LocalTrainBackend);
    assert.equal(backend.name, 'local');
  });
  await withEnv({ TRAIN_BACKEND: 'colab' }, () => {
    assert.equal(trainBackendName(), 'colab');
    const backend = createTrainBackend({ store: () => new MemoryDriveStore() });
    assert.equal(backend.name, 'colab');
  });
});

test('colab mode builds job.json from the kohya config', () => {
  const doc = buildColabJob({
    id: 'job1', title: 'Alat ng Dagat', trigger: 'direk_alat',
    config: CONFIG, baseModel: '/models/base.safetensors',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(doc.job_id, 'job1');
  assert.equal(doc.trigger, 'direk_alat');
  assert.equal(doc.dataset, 'jobs/job1/dataset');
  assert.equal(doc.output, 'jobs/job1/output');
  assert.equal(doc.base_model, '/models/base.safetensors');
  // The args come from the config, not typed by hand.
  assert.equal(doc.train_args.resolution, 768);
  assert.equal(doc.train_args.num_repeats, 7);
  assert.equal(doc.train_args.network_dim, 24);
  assert.equal(doc.train_args.network_alpha, 12);
  assert.equal(doc.train_args.max_train_epochs, 3);
  assert.equal(doc.train_args.seed, 7);
  assert.equal(doc.train_args.network_module, 'networks.lora');
});

test('parseKohyaConfig reads the values the app writes', () => {
  const args = parseKohyaConfig(CONFIG);
  assert.equal(args.resolution, 768);
  assert.equal(args.learning_rate, 1e-4);
  assert.equal(args.optimizer_type, 'AdamW8bit');
  assert.equal(args.batch_size, 1);
  assert.equal(args.save_model_as, 'safetensors');
});

test('readColabStatus maps every state, and a missing file is QUEUED', async () => {
  const store = new MemoryDriveStore();
  const p = jobPaths('job1');
  assert.equal((await readColabStatus(store, 'job1')).state, 'QUEUED');

  for (const state of ['QUEUED', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED'] as ColabState[]) {
    await store.write(p.status, Buffer.from(JSON.stringify({ state })));
    assert.equal((await readColabStatus(store, 'job1')).state, state);
  }

  await store.write(p.status, Buffer.from(JSON.stringify({ state: 'FAILED', error: 'boom' })));
  const failed = await readColabStatus(store, 'job1');
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.error, 'boom');

  await store.write(p.status, Buffer.from('not json'));
  assert.equal((await readColabStatus(store, 'job1')).state, 'QUEUED');
});

test('jobStatusForState maps Colab states onto job statuses', () => {
  assert.equal(jobStatusForState('QUEUED'), 'running');
  assert.equal(jobStatusForState('RUNNING'), 'running');
  assert.equal(jobStatusForState('DONE'), 'done');
  assert.equal(jobStatusForState('FAILED'), 'failed');
  assert.equal(jobStatusForState('CANCELLED'), 'cancelled');
});

test('colab start uploads the dataset and job.json to Drive', async () => {
  const store = new MemoryDriveStore();
  const backend = new ColabTrainBackend({ store: () => store, stageDir: tmpDir('stage-'), pollMs: 20 });
  await backend.start(startOptions());

  assert.ok(store.files.has('jobs/job1/job.json'));
  assert.ok(store.files.has('jobs/job1/dataset/direk_alat_001.png'));
  assert.ok(store.files.has('jobs/job1/dataset/direk_alat_001.txt'));
  assert.equal(store.files.get('jobs/job1/dataset/direk_alat_001.txt')?.toString(), 'direk_alat, a weathered face\n');
  const doc = JSON.parse(store.files.get('jobs/job1/job.json')!.toString());
  assert.equal(doc.train_args.resolution, 768);
});

test('colab cancel writes cancel.flag and never kills anything', async () => {
  const store = new MemoryDriveStore();
  const backend = new ColabTrainBackend({ store: () => store, stageDir: tmpDir('stage-'), pollMs: 50 });
  await backend.start(startOptions());
  assert.equal(store.files.has('jobs/job1/cancel.flag'), false);
  assert.equal(await backend.cancel(), true);
  assert.ok(store.files.has('jobs/job1/cancel.flag'));
  // A second cancel is a no-op once the flag is set.
  assert.equal(await backend.cancel(), true);
});

test('colab completes end to end and publishes a verified artifact', async () => {
  const store = new MemoryDriveStore();
  const published: string[] = [];
  const backend = new ColabTrainBackend({ store: () => store, stageDir: tmpDir('stage-'), pollMs: 20 });
  const opts = startOptions();
  await backend.start({ ...opts, onArtifact: file => published.push(file) });

  const p = jobPaths('job1');
  await store.write(p.status, Buffer.from(JSON.stringify({ state: 'RUNNING', epoch: 1, total_epochs: 3 })));
  await waitFor(() => backend.current()?.log.some(l => l.includes('RUNNING')) ?? false);

  const weights = Buffer.from('SAFETENSORS-BYTES');
  await store.write(`${p.output}/direk_alat_colab.safetensors`, weights);
  await store.write(p.manifest, Buffer.from(JSON.stringify({
    files: [{ name: 'direk_alat_colab.safetensors', bytes: weights.length, sha256: sha256(weights) }],
  })));
  await store.write(p.status, Buffer.from(JSON.stringify({ state: 'DONE' })));

  await waitFor(() => backend.current()?.status !== 'running');
  const job = backend.current()!;
  assert.equal(job.status, 'done');
  assert.ok(job.artifact?.endsWith('direk_alat_colab.safetensors'));
  assert.equal(published.length, 1);
  assert.deepEqual(fs.readFileSync(published[0]), weights);
});

test('a sha256 mismatch fails the job and publishes nothing', async () => {
  const store = new MemoryDriveStore();
  const published: string[] = [];
  const backend = new ColabTrainBackend({ store: () => store, stageDir: tmpDir('stage-'), pollMs: 20 });
  await backend.start({ ...startOptions(), onArtifact: file => published.push(file) });

  const p = jobPaths('job1');
  const weights = Buffer.from('REAL-WEIGHTS');
  await store.write(`${p.output}/direk_alat_colab.safetensors`, weights);
  await store.write(p.manifest, Buffer.from(JSON.stringify({
    files: [{ name: 'direk_alat_colab.safetensors', bytes: weights.length, sha256: sha256(Buffer.from('TAMPERED')) }],
  })));
  await store.write(p.status, Buffer.from(JSON.stringify({ state: 'DONE' })));

  await waitFor(() => backend.current()?.status !== 'running');
  const job = backend.current()!;
  assert.equal(job.status, 'failed');
  assert.match(job.error || '', /sha256 mismatch/);
  assert.equal(published.length, 0);
});

test('a missing manifest fails the job instead of publishing', async () => {
  const store = new MemoryDriveStore();
  const backend = new ColabTrainBackend({ store: () => store, stageDir: tmpDir('stage-'), pollMs: 20 });
  await backend.start(startOptions());
  const p = jobPaths('job1');
  await store.write(`${p.output}/direk_alat_colab.safetensors`, Buffer.from('W'));
  await store.write(p.status, Buffer.from(JSON.stringify({ state: 'DONE' })));
  await waitFor(() => backend.current()?.status !== 'running');
  assert.equal(backend.current()?.status, 'failed');
  assert.match(backend.current()?.error || '', /manifest/);
});

test('a FAILED status fails the job with the notebook error', async () => {
  const store = new MemoryDriveStore();
  const backend = new ColabTrainBackend({ store: () => store, stageDir: tmpDir('stage-'), pollMs: 20 });
  await backend.start(startOptions());
  const p = jobPaths('job1');
  await store.write(p.status, Buffer.from(JSON.stringify({ state: 'FAILED', error: 'CUDA out of memory' })));
  await waitFor(() => backend.current()?.status !== 'running');
  assert.equal(backend.current()?.status, 'failed');
  assert.match(backend.current()?.error || '', /CUDA out of memory/);
});

test('colab is honestly unavailable when Drive is not configured', async () => {
  await withEnv({ COLAB_DRIVE_ROOT: undefined, COLAB_DRIVE_FOLDER_ID: undefined }, () => {
    const backend = new ColabTrainBackend();
    const status = backend.status();
    assert.equal(status.available, false);
    assert.match(status.reason || '', /COLAB_DRIVE_ROOT/);
  });
});

test('colab is available when COLAB_DRIVE_ROOT is set', async () => {
  const root = tmpDir('drive-root-');
  await withEnv({ COLAB_DRIVE_ROOT: root, COLAB_DRIVE_FOLDER_ID: undefined }, () => {
    const backend = new ColabTrainBackend();
    assert.equal(backend.status().available, true);
  });
});

test('driveStoreFromEnv picks the fs store, the gdrive store, or null', async () => {
  const root = tmpDir('drive-root-');
  await withEnv({ COLAB_DRIVE_ROOT: root, COLAB_DRIVE_FOLDER_ID: undefined }, () => {
    const store = driveStoreFromEnv();
    assert.ok(store instanceof FsDriveStore);
    assert.equal(store?.kind, 'fs');
  });
  await withEnv({ COLAB_DRIVE_ROOT: undefined, COLAB_DRIVE_FOLDER_ID: 'folder-123' }, () => {
    const store = driveStoreFromEnv();
    assert.ok(store instanceof GoogleDriveStore);
    assert.equal(store?.kind, 'gdrive');
  });
  await withEnv({ COLAB_DRIVE_ROOT: undefined, COLAB_DRIVE_FOLDER_ID: undefined }, () => {
    assert.equal(driveStoreFromEnv(), null);
  });
});

test('FsDriveStore reads, writes, lists and removes', async () => {
  const root = tmpDir('fs-drive-');
  const store = new FsDriveStore(root);
  assert.equal(await store.read('a/b.txt'), null);
  await store.write('a/b.txt', Buffer.from('hello'));
  assert.equal((await store.read('a/b.txt'))?.toString(), 'hello');
  assert.deepEqual(await store.list('a'), ['a/b.txt']);
  await store.remove('a/b.txt');
  assert.equal(await store.read('a/b.txt'), null);
});

test('FsDriveStore refuses a path that escapes the root', async () => {
  const store = new FsDriveStore(tmpDir('fs-drive-'));
  await assert.rejects(() => store.write('../escape.txt', Buffer.from('x')), /escapes the Drive root/);
});

test('GoogleDriveStore writes and reads back through an injected fetch (no network)', async () => {
  // A minimal fake of the Drive API v3 surface the store uses: folder lookup
  // and creation, file lookup and creation, media upload, and media download.
  const folders = new Map<string, string>(); // "parent/name" -> folder id
  const fileIds = new Map<string, string>(); // "parent/name" -> file id
  const fileData = new Map<string, Buffer>(); // file id -> bytes
  let nextId = 1;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  const fetchImpl = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const method = (init.method || 'GET').toUpperCase();
    const parsed = new URL(url);
    const q = decodeURIComponent(parsed.searchParams.get('q') || '');

    if (method === 'GET' && q) {
      const name = q.match(/name='([^']+)'/)![1];
      const parent = q.match(/'([^']+)' in parents/)![1];
      if (q.includes("mimeType='application/vnd.google-apps.folder'")) {
        const id = folders.get(`${parent}/${name}`);
        return json(id ? { files: [{ id }] } : { files: [] });
      }
      const id = fileIds.get(`${parent}/${name}`);
      return json(id ? { files: [{ id }] } : { files: [] });
    }
    if (method === 'POST' && parsed.searchParams.get('fields') === 'id') {
      const body = JSON.parse(String(init.body)) as { name: string; mimeType?: string; parents: string[] };
      const id = `id${nextId++}`;
      if (body.mimeType === 'application/vnd.google-apps.folder') folders.set(`${body.parents[0]}/${body.name}`, id);
      else fileIds.set(`${body.parents[0]}/${body.name}`, id);
      return json({ id });
    }
    if (method === 'PATCH' && parsed.searchParams.get('uploadType') === 'media') {
      const id = parsed.pathname.split('/').pop()!;
      fileData.set(id, Buffer.from(init.body as Uint8Array));
      return json({ id });
    }
    if (method === 'GET' && parsed.searchParams.get('alt') === 'media') {
      const id = parsed.pathname.split('/').pop()!;
      const data = fileData.get(id);
      return data
        ? new Response(new Uint8Array(data), { status: 200 })
        : new Response('not found', { status: 404 });
    }
    return new Response('unhandled', { status: 500 });
  };

  const store = new GoogleDriveStore('root', async () => 'token', fetchImpl as any, 5000);
  await store.write('jobs/j1/status.json', Buffer.from('{"state":"DONE"}'));
  const read = await store.read('jobs/j1/status.json');
  assert.equal(read?.toString(), '{"state":"DONE"}');
});
