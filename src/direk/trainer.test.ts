import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  trainerStatus, trainerScript, buildTrainCommand, parseProgress,
  trainingConfig, writeTrainingJob, findArtifact, LoRATrainer,
} from './trainer.ts';

/** Run `fn` with the given env vars, restoring them afterwards. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
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

test('trainerScript finds the kohya script, or reports none', () => {
  const dir = tmpDir('kohya-');
  assert.equal(trainerScript(dir), null);
  fs.writeFileSync(path.join(dir, 'train_network.py'), '# fake\n');
  assert.equal(trainerScript(dir), path.join(dir, 'train_network.py'));
  const dir2 = tmpDir('kohya-sdxl-');
  fs.writeFileSync(path.join(dir2, 'sdxl_train_network.py'), '# fake\n');
  assert.equal(trainerScript(dir2), path.join(dir2, 'sdxl_train_network.py'));
});

test('trainerStatus is honestly unavailable until fully configured', () => {
  withEnv({ KOHYA_DIR: undefined, KOHYA_BASE_MODEL: undefined }, () => {
    const s = trainerStatus();
    assert.equal(s.available, false);
    assert.match(s.reason || '', /KOHYA_DIR/);
  });

  const dir = tmpDir('kohya-');
  fs.writeFileSync(path.join(dir, 'train_network.py'), '# fake\n');

  withEnv({ KOHYA_DIR: dir, KOHYA_BASE_MODEL: undefined }, () => {
    const s = trainerStatus();
    assert.equal(s.available, false);
    assert.match(s.reason || '', /KOHYA_BASE_MODEL/);
  });

  withEnv({ KOHYA_DIR: dir, KOHYA_BASE_MODEL: 'sd_xl_base_1.0.safetensors' }, () => {
    const s = trainerStatus();
    assert.equal(s.available, true);
    assert.equal(s.script, path.join(dir, 'train_network.py'));
  });
});

test('buildTrainCommand uses python directly or accelerate when asked', () => {
  const status = {
    available: true, dir: '/k', script: '/k/train_network.py', python: 'python3',
    base_model: 'm', output_dir: '/o',
  };
  withEnv({ KOHYA_ACCELERATE: undefined }, () => {
    const { cmd, args } = buildTrainCommand(status, '/o/c.toml');
    assert.equal(cmd, 'python3');
    assert.deepEqual(args, ['/k/train_network.py', '--config_file', '/o/c.toml']);
  });
  withEnv({ KOHYA_ACCELERATE: '1' }, () => {
    const { cmd, args } = buildTrainCommand(status, '/o/c.toml');
    assert.equal(cmd, 'accelerate');
    assert.deepEqual(args.slice(-3), ['/k/train_network.py', '--config_file', '/o/c.toml']);
  });
});

test('parseProgress pulls step and epoch counters out of log lines', () => {
  assert.equal(parseProgress('steps: 40/100 loss=0.1'), 'steps 40/100');
  assert.equal(parseProgress('epoch 2/10'), 'epoch 2/10');
  assert.equal(parseProgress('loading model...'), null);
});

test('trainingConfig points at absolute paths and the chosen base model', () => {
  const toml = trainingConfig({
    datasetDir: '/runs/x/dataset', outputDir: '/runs/x/out', outputName: 't_x',
    baseModel: '/models/sd_xl_base_1.0.safetensors', resolution: 1024,
    numRepeats: 10, maxEpochs: 8, networkDim: 32, networkAlpha: 16, seed: 42,
  });
  assert.match(toml, /image_dir = "\/runs\/x\/dataset"/);
  assert.match(toml, /output_dir = "\/runs\/x\/out"/);
  assert.match(toml, /pretrained_model_name_or_path = "\/models\/sd_xl_base_1\.0\.safetensors"/);
  assert.match(toml, /max_train_epochs = 8/);
  assert.match(toml, /network_dim = 32/);
});

test('writeTrainingJob lays out images and captions side by side', () => {
  const root = tmpDir('run-');
  const images = new Map([['direk_t_001', Buffer.from('png')]]);
  const out = writeTrainingJob({
    root,
    trigger: 'direk_t',
    captions: [
      { name: 'direk_t_001', text: 'direk_t, a face' },
      { name: 'direk_t_002', text: 'direk_t, a wide shot' },
    ],
    images,
    config: '# config\n',
  });
  assert.equal(out.imagesWritten, 1);
  assert.ok(fs.existsSync(path.join(out.datasetDir, 'direk_t_001.png')));
  assert.ok(fs.existsSync(path.join(out.datasetDir, 'direk_t_002.txt')));
  assert.equal(
    fs.readFileSync(path.join(out.datasetDir, 'direk_t_001.txt'), 'utf8'),
    'direk_t, a face\n',
  );
  assert.ok(fs.existsSync(out.configPath));
});

test('findArtifact returns the newest safetensors, or undefined', () => {
  const dir = tmpDir('out-');
  assert.equal(findArtifact(dir), undefined);
  fs.writeFileSync(path.join(dir, 'a.safetensors'), 'a');
  fs.writeFileSync(path.join(dir, 'note.txt'), 'x');
  assert.equal(findArtifact(dir), path.join(dir, 'a.safetensors'));
});

test('LoRATrainer runs a real child process and detects the artifact', async () => {
  // A stand-in trainer that prints progress and writes a checkpoint, so the
  // runner is exercised end to end without kohya or a GPU.
  const dir = tmpDir('kohya-run-');
  fs.writeFileSync(
    path.join(dir, 'train_network.py'),
    [
      'import os, re, sys, time',
      'cfg = sys.argv[sys.argv.index("--config_file") + 1]',
      'text = open(cfg).read()',
      'out = re.search(r\'output_dir = "([^"]+)"\', text).group(1)',
      'os.makedirs(out, exist_ok=True)',
      'print("loading model...")',
      'for i in range(1, 4):',
      '    print(f"steps: {i*10}/30 loss=0.1")',
      '    time.sleep(0.05)',
      'open(os.path.join(out, "checkpoint.safetensors"), "wb").write(b"weights")',
      'print("done")',
      '',
    ].join('\n'),
  );
  const outputDir = tmpDir('kohya-out-');
  const root = tmpDir('kohya-root-');

  await withEnvAsync(
    {
      KOHYA_DIR: dir,
      KOHYA_BASE_MODEL: '/models/base.safetensors',
      KOHYA_OUTPUT_DIR: outputDir,
      KOHYA_PYTHON: process.env.KOHYA_PYTHON || 'python3',
      KOHYA_ACCELERATE: undefined,
    },
    async () => {
      const trainer = new LoRATrainer();
      const job = trainer.start({
        id: 'job1',
        title: 'T',
        trigger: 'direk_t',
        root,
        captions: [{ name: 'direk_t_001', text: 'direk_t, a face' }],
        images: new Map([['direk_t_001', Buffer.from('png')]]),
        config: trainingConfig({
          datasetDir: path.join(root, 'dataset'),
          outputDir: path.join(outputDir, 'job1'),
          outputName: 't_direk_t',
          baseModel: '/models/base.safetensors',
          resolution: 1024, numRepeats: 10, maxEpochs: 1,
          networkDim: 32, networkAlpha: 16, seed: 42,
        }),
      });
      assert.equal(job.status, 'running');

      await waitFor(() => trainer.current()?.status !== 'running');
      const finished = trainer.current()!;
      assert.equal(finished.status, 'done');
      assert.ok(finished.artifact?.endsWith('checkpoint.safetensors'));
      assert.ok(finished.log.some(l => l.includes('steps: 20/30')));
      assert.ok(fs.existsSync(path.join(root, 'dataset', 'direk_t_001.png')));
    },
  );
});

test('LoRATrainer refuses a second run while one is going', async () => {
  const dir = tmpDir('kohya-busy-');
  fs.writeFileSync(
    path.join(dir, 'train_network.py'),
    'import time\ntime.sleep(5)\n',
  );
  const outputDir = tmpDir('kohya-busy-out-');
  const root = tmpDir('kohya-busy-root-');

  await withEnvAsync(
    { KOHYA_DIR: dir, KOHYA_BASE_MODEL: 'm', KOHYA_OUTPUT_DIR: outputDir, KOHYA_ACCELERATE: undefined },
    async () => {
      const trainer = new LoRATrainer();
      const opts = {
        id: 'a', title: 'T', trigger: 'direk_t', root,
        captions: [], images: new Map<string, Buffer>(), config: '# c',
      };
      trainer.start(opts);
      assert.throws(() => trainer.start({ ...opts, id: 'b' }), /tumatakbong training/);
      assert.equal(trainer.cancel(), true);
      assert.equal(trainer.current()?.status, 'cancelled');
      await waitFor(() => trainer.current()?.status !== 'running');
    },
  );
});

async function withEnvAsync(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
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

async function waitFor<T>(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('timed out waiting for the job to finish');
}
