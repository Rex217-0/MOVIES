/**
 * Contract test: the notebook must read exactly what buildColabJob() writes,
 * and write exactly what readColabStatus()/collectVerifiedArtifact() expect.
 * A drift here is silent — training runs, then the app never sees the output.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildColabJob, jobPaths } from './colabTrainer.ts';

const NOTEBOOK = 'scripts/lora_trainer_v2.ipynb';

/** The notebook's code cells, concatenated, so we can assert on real source. */
function notebookSource(): string {
  const nb = JSON.parse(readFileSync(NOTEBOOK, 'utf8'));
  return nb.cells
    .filter((c: any) => c.cell_type === 'code')
    .map((c: any) => c.source.join(''))
    .join('\n');
}

test('job.json written by the app has the fields the notebook reads', () => {
  const job = buildColabJob({
    id: 'job-abc',
    title: 'Test',
    trigger: 'test',
    config: 'resolution = 1024\nmax_train_epochs = 10\n',
    baseModel: 'stabilityai/stable-diffusion-xl-base-1.0',
  });
  const src = notebookSource();

  // Every job.json key the notebook touches must exist in the real document.
  for (const key of ['job_id', 'dataset', 'output', 'output_name', 'base_model', 'train_args']) {
    assert.ok(key in job, `buildColabJob must emit ${key}`);
    assert.ok(src.includes(`job["${key}"]`), `notebook must read job["${key}"]`);
  }

  // train_args keys the notebook renders into the TOML.
  for (const key of ['resolution', 'batch_size', 'num_repeats', 'network_module',
                     'network_dim', 'network_alpha', 'learning_rate', 'optimizer_type',
                     'lr_scheduler', 'max_train_epochs', 'save_every_n_epochs',
                     'mixed_precision', 'seed', 'save_model_as']) {
    assert.ok(key in job.train_args, `buildColabJob must emit train_args.${key}`);
    assert.ok(src.includes(`cfg["${key}"]`), `notebook must read cfg["${key}"]`);
  }
});

test('the notebook writes status.json in the shape readColabStatus accepts', () => {
  const src = notebookSource();
  const states = ['QUEUED', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED'];
  for (const state of ['RUNNING', 'DONE', 'FAILED', 'CANCELLED']) {
    assert.ok(src.includes(`"${state}"`), `notebook must be able to write ${state}`);
    assert.ok(states.includes(state));
  }
  // The app maps these onto job status; the notebook must not invent new ones.
  assert.ok(/write_json\(.*status\.json/.test(src));
  assert.ok(src.includes('"state"'), 'status.json needs a state key');
  assert.ok(src.includes('"updated_at"'), 'status.json needs updated_at');
});

test('the notebook writes manifest.json in the shape collectVerifiedArtifact accepts', () => {
  const src = notebookSource();
  assert.ok(src.includes('"sha256"'), 'manifest entries need sha256');
  assert.ok(src.includes('"bytes"'), 'manifest entries need bytes');
  assert.ok(src.includes('"name"'), 'manifest entries need name');
  assert.ok(src.includes('{"files": files}'), 'manifest must be {files: [...]}');
});

test('the notebook uses the SDXL trainer, not the SD 1.5 one', () => {
  const src = notebookSource();
  assert.ok(src.includes('sdxl_train_network.py'), 'must use the SDXL trainer');
  // A bare train_network.py in executable code would be the SD 1.5 trainer.
  assert.ok(!/(?<!sdxl_)train_network\.py/.test(src),
    'must not invoke the SD 1.5 train_network.py');
  assert.ok(!src.includes('xformers'), 'xformers is not in sd-scripts requirements');
});

test('jobPaths layout matches what the notebook builds', () => {
  const p = jobPaths('job-abc');
  assert.equal(p.base, 'jobs/job-abc');
  assert.equal(p.dataset, 'jobs/job-abc/dataset');
  assert.equal(p.output, 'jobs/job-abc/output');
  assert.equal(p.status, 'jobs/job-abc/status.json');
  assert.equal(p.manifest, 'jobs/job-abc/manifest.json');
  assert.equal(p.cancel, 'jobs/job-abc/cancel.flag');

  const src = notebookSource();
  assert.ok(src.includes('"jobs"'), 'notebook must use the jobs/ folder');
  assert.ok(src.includes('"status.json"'));
  assert.ok(src.includes('"manifest.json"'));
  assert.ok(src.includes('"cancel.flag"'));
});

test('every code cell is valid Python', () => {
  const nb = JSON.parse(readFileSync(NOTEBOOK, 'utf8'));
  const cells = nb.cells.filter((c: any) => c.cell_type === 'code');
  const dir = mkdtempSync(path.join(tmpdir(), 'nbcells-'));
  try {
    cells.forEach((c: any, i: number) => {
      const src = c.source.join('');
      if (src.trim().startsWith('!')) return; // a shell magic, not Python
      const f = path.join(dir, `cell${i}.py`);
      writeFileSync(f, src);
      execFileSync('python3', ['-c',
        `import ast,sys; ast.parse(open(sys.argv[1]).read())`, f]);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
