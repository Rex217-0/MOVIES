import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveAsset, listAssets, findAsset, reviewAsset, supersedeAsset, SIDECAR_SUFFIX } from './assets.ts';
import {
  VAULT_DISPOSITIONS, STITCHABLE_DISPOSITIONS, SETTLED_DISPOSITIONS,
  actionToDisposition, normalizeDisposition, dispositionToLegacy, legacyToDisposition,
  isVaultDisposition, originalityProvenance, promptHash,
  ORIGINALITY_DECLARATION_GROUNDED, ORIGINALITY_DECLARATION_UNGOUNDED,
} from './provenance.ts';

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-'));
  const saved = process.env.DIREK_ASSETS_DIR;
  process.env.DIREK_ASSETS_DIR = dir;
  try {
    fn(dir);
  } finally {
    if (saved === undefined) delete process.env.DIREK_ASSETS_DIR;
    else process.env.DIREK_ASSETS_DIR = saved;
  }
}

function sidecarOf(dir: string, name: string): any {
  return JSON.parse(fs.readFileSync(path.join(dir, `${name}${SIDECAR_SUFFIX}`), 'utf8'));
}

test('there are exactly seven dispositions, and only APPROVED_MASTER is stitchable', () => {
  assert.equal(VAULT_DISPOSITIONS.length, 7);
  assert.deepEqual(STITCHABLE_DISPOSITIONS, ['APPROVED_MASTER']);
  for (const d of SETTLED_DISPOSITIONS) assert.ok(isVaultDisposition(d));
  assert.ok(VAULT_DISPOSITIONS.every(isVaultDisposition));
  assert.equal(isVaultDisposition('approved'), false, 'a legacy status is not a disposition');
  assert.equal(isVaultDisposition(undefined), false);
});

test('the legacy three states map onto dispositions and back', () => {
  assert.equal(legacyToDisposition('pending'), 'PENDING_REVIEW');
  assert.equal(legacyToDisposition('approved'), 'APPROVED_MASTER');
  assert.equal(legacyToDisposition('rejected'), 'REJECTED_CREATIVE');

  assert.equal(dispositionToLegacy('APPROVED_MASTER'), 'approved');
  assert.equal(dispositionToLegacy('PENDING_REVIEW'), 'pending');
  assert.equal(dispositionToLegacy('REFINE'), 'rejected');
  assert.equal(dispositionToLegacy('APPROVED_PREVIEW_ONLY'), 'rejected');
});

test('normalizeDisposition accepts dispositions, legacy statuses and short actions', () => {
  assert.equal(normalizeDisposition('APPROVED_TECHNICAL' as any), undefined, 'unknown is refused');
  assert.equal(normalizeDisposition('REFINE'), 'REFINE');
  assert.equal(normalizeDisposition('refine'), 'REFINE');
  assert.equal(normalizeDisposition('approve'), 'APPROVED_MASTER');
  assert.equal(normalizeDisposition('approved'), 'APPROVED_MASTER');
  assert.equal(normalizeDisposition('reject'), 'REJECTED_CREATIVE');
  assert.equal(normalizeDisposition('REJECTED_TECHNICAL'), 'REJECTED_TECHNICAL');
  assert.equal(normalizeDisposition('  pending  '), 'PENDING_REVIEW');
  assert.equal(normalizeDisposition(''), undefined);
  assert.equal(normalizeDisposition(null), undefined);
  assert.equal(actionToDisposition('supersede'), 'SUPERSEDED');
});

test('a new asset lands PENDING_REVIEW and states that no grounding was recorded', () => {
  withTempDir(() => {
    const meta = saveAsset(Buffer.from('x'), {
      title: 'Eksena', ext: 'mp4', mime: 'video/mp4', source: 'test',
    });
    assert.equal(meta.disposition, 'PENDING_REVIEW');
    assert.equal(meta.reviewStatus, 'pending', 'the legacy view is derived, not separately set');
    assert.equal(meta.originality?.groundingUsed, false);
    assert.equal(meta.originality?.referenceCount, 0);
    assert.equal(meta.originality?.declaration, ORIGINALITY_DECLARATION_UNGOUNDED);
    assert.equal(meta.originality?.humanReviewed, false);
    assert.ok(meta.checksum && meta.checksum.length === 64);
  });
});

test('the checksum is measured from the bytes, never taken from the caller', () => {
  withTempDir(() => {
    const meta = saveAsset(Buffer.from('tunay na bytes'), {
      title: 'Eksena', ext: 'mp4', mime: 'video/mp4', source: 'test',
      provenance: { checksum: 'a'.repeat(64) },
    });
    assert.notEqual(meta.checksum, 'a'.repeat(64), 'a forged checksum is overwritten');
    assert.equal(meta.checksum, saveAssetChecksum('tunay na bytes'));
  });
});

function saveAssetChecksum(text: string): string {
  const saved = process.env.DIREK_ASSETS_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-sum-'));
  process.env.DIREK_ASSETS_DIR = dir;
  try {
    return saveAsset(Buffer.from(text), {
      title: 'S', ext: 'mp4', mime: 'video/mp4', source: 't',
    }).checksum!;
  } finally {
    if (saved === undefined) delete process.env.DIREK_ASSETS_DIR;
    else process.env.DIREK_ASSETS_DIR = saved;
  }
}

test('provenance is persisted to the sidecar and read back', () => {
  withTempDir(dir => {
    const meta = saveAsset(Buffer.from('v'), {
      title: 'Eksena 3', ext: 'mp4', mime: 'video/mp4', source: 'factory',
      prompt: 'isang babaeng naka-barong sa ulan',
      mediaClass: 'SYNTHETIC_MOTION',
      qualityTier: 'MASTER',
      backend: 'comfyui',
      provenance: {
        seed: 123456,
        resolution: '832x480',
        modelOrWorkflowVersion: 'wan2.2_ti2v_5B_fp16.safetensors (wan.json)',
        framesDuration: { frames: 49, seconds: 300 },
        audioState: 'voiced',
      },
    });

    const onDisk = sidecarOf(dir, meta.name);
    assert.equal(onDisk.seed, 123456);
    assert.equal(onDisk.resolution, '832x480');
    assert.equal(onDisk.audioState, 'voiced');
    assert.equal(onDisk.qualityTier, 'MASTER');
    assert.equal(onDisk.backend, 'comfyui');
    assert.equal(
      onDisk.promptHash,
      promptHash('isang babaeng naka-barong sa ulan'),
      'the prompt hash is derived from the prompt that was sent',
    );
    assert.equal(onDisk.prompt, 'isang babaeng naka-barong sa ulan');
  });
});

test('a renderer that reports no seed records no seed, rather than zero', () => {
  withTempDir(dir => {
    const meta = saveAsset(Buffer.from('v'), {
      title: 'Stock', ext: 'mp4', mime: 'video/mp4', source: 'stock',
      provenance: { backend: 'stock', mediaClass: 'STOCK_FOOTAGE' },
    });
    const onDisk = sidecarOf(dir, meta.name);
    assert.equal('seed' in onDisk, false);
    assert.equal(onDisk.seed, undefined);
  });
});

test('a multi-shot scene records every seed and no single one', () => {
  withTempDir(dir => {
    const meta = saveAsset(Buffer.from('v'), {
      title: 'Eksena 7', ext: 'mp4', mime: 'video/mp4', source: 'factory',
      provenance: { seeds: [11, 22, 33] },
    });
    const onDisk = sidecarOf(dir, meta.name);
    assert.deepEqual(onDisk.seeds, [11, 22, 33]);
    assert.equal(onDisk.seed, undefined, 'three seeds cannot be described by one number');
  });
});

test('reviewAsset stores the reviewer and the reason with the disposition', () => {
  withTempDir(dir => {
    const meta = saveAsset(Buffer.from('v'), {
      title: 'Eksena', ext: 'mp4', mime: 'video/mp4', source: 't',
    });
    const updated = reviewAsset(meta.id, 'REFINE', {
      reviewer: 'Rex', reason: 'Masyadong mabilis ang cut sa dulo.',
    })!;
    assert.equal(updated.disposition, 'REFINE');
    assert.equal(updated.reviewStatus, 'rejected');
    assert.equal(updated.reviewer, 'Rex');
    assert.equal(updated.reason, 'Masyadong mabilis ang cut sa dulo.');

    const onDisk = sidecarOf(dir, meta.name);
    assert.equal(onDisk.disposition, 'REFINE');
    assert.equal(onDisk.reviewer, 'Rex');
  });
});

test('a human review marks the originality declaration as reviewed', () => {
  withTempDir(() => {
    const meta = saveAsset(Buffer.from('v'), {
      title: 'Eksena', ext: 'mp4', mime: 'video/mp4', source: 't',
      originality: originalityProvenance({ genre: 'Drama', referenceCount: 6 }),
    });
    assert.equal(meta.originality?.humanReviewed, false);
    const updated = reviewAsset(meta.id, 'APPROVED_MASTER', { reviewer: 'Rex' })!;
    assert.equal(updated.originality?.humanReviewed, true);
    assert.equal(updated.originality?.groundingUsed, true, 'the declaration itself is unchanged');
  });
});

test('a recognise-only disposition is refused rather than stored', () => {
  withTempDir(() => {
    const meta = saveAsset(Buffer.from('v'), {
      title: 'Eksena', ext: 'mp4', mime: 'video/mp4', source: 't',
    });
    assert.equal(reviewAsset(meta.id, 'NOT_A_STATE'), null);
    assert.equal(findAsset(meta.id)!.disposition, 'PENDING_REVIEW', 'the asset is untouched');
  });
});

test('a legacy sidecar with only reviewStatus is backfilled deterministically', () => {
  withTempDir(dir => {
    const legacy = {
      id: 'AST-OLD-1',
      name: 'lumang-render.mp4',
      ext: 'mp4', mime: 'video/mp4', bytes: 3, kind: 'video',
      title: 'Lumang render', source: 'movie-creator',
      createdAt: '2026-01-01T00:00:00.000Z',
      reviewStatus: 'approved',
    };
    fs.writeFileSync(path.join(dir, `lumang-render.mp4${SIDECAR_SUFFIX}`), JSON.stringify(legacy));

    const [asset] = listAssets();
    assert.equal(asset.disposition, 'APPROVED_MASTER', 'the old approval keeps meaning approved');
    assert.equal(asset.reviewStatus, 'approved');
    assert.equal('seed' in asset, false, 'no field is invented for an old row');
  });
});

test('a legacy sidecar with no review field at all reads as pending', () => {
  withTempDir(dir => {
    const legacy = {
      id: 'AST-OLD-2', name: 'wala.mp4', ext: 'mp4', mime: 'video/mp4', bytes: 1,
      kind: 'video', title: 'Wala', source: 't', createdAt: '2026-01-01T00:00:00.000Z',
    };
    fs.writeFileSync(path.join(dir, `wala.mp4${SIDECAR_SUFFIX}`), JSON.stringify(legacy));
    assert.equal(listAssets()[0].disposition, 'PENDING_REVIEW');
  });
});

test('supersedeAsset keeps the old asset and links it to its replacement', () => {
  withTempDir(() => {
    const old = saveAsset(Buffer.from('luma'), {
      title: 'Eksena 1', ext: 'mp4', mime: 'video/mp4', source: 't',
    });
    const fresh = saveAsset(Buffer.from('bago'), {
      title: 'Eksena 1', ext: 'mp4', mime: 'video/mp4', source: 't',
      provenance: { parentAssetId: old.id },
    });

    const superseded = supersedeAsset(old.id, fresh.id)!;
    assert.equal(superseded.disposition, 'SUPERSEDED');
    assert.equal(superseded.replacementAssetId, fresh.id);
    assert.equal(findAsset(old.id)!.disposition, 'SUPERSEDED', 'the old asset still exists');

    assert.equal(findAsset(fresh.id)!.parentAssetId, old.id, 'the chain points both ways');
    assert.equal(listAssets().length, 2, 'nothing was deleted');
  });
});

test('an atomic sidecar write leaves no temp file behind', () => {
  withTempDir(dir => {
    saveAsset(Buffer.from('v'), { title: 'Eksena', ext: 'mp4', mime: 'video/mp4', source: 't' });
    const leftovers = fs.readdirSync(dir).filter(f => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });
});

test('a grounded brief declares its purpose and what was not derived', () => {
  const prov = originalityProvenance({
    genre: 'Drama', referenceCount: 6, usedFor: ['genre_benchmark', 'pacing_benchmark', 'market_benchmark'],
  });
  assert.equal(prov.groundingUsed, true);
  assert.equal(prov.groundingGenre, 'Drama');
  assert.equal(prov.referenceCount, 6);
  assert.deepEqual(prov.groundingPurpose, ['genre_benchmark', 'pacing_benchmark', 'market_benchmark']);
  assert.equal(prov.declaration, ORIGINALITY_DECLARATION_GROUNDED);
  assert.deepEqual(
    [...prov.notDerived].sort(),
    ['characters', 'dialogue', 'music', 'script', 'shot_list', 'visual_style'],
  );
});

test('a brief with no catalog match claims no grounding', () => {
  const prov = originalityProvenance({ genre: null, referenceCount: 0 });
  assert.equal(prov.groundingUsed, false);
  assert.deepEqual(prov.groundingPurpose, []);
  assert.equal(prov.declaration, ORIGINALITY_DECLARATION_UNGOUNDED);
});

test('a genre with zero references is not counted as grounding', () => {
  const prov = originalityProvenance({ genre: 'Drama', referenceCount: 0 });
  assert.equal(prov.groundingUsed, false, 'a genre name alone is not data that was consulted');
});

test('two renders of the same scene never overwrite each other', () => {
  withTempDir(() => {
    // Same title, same second: without a guard both calls produce the same name
    // and the second silently destroys the first, which is the asset the
    // supersede chain exists to keep.
    const a = saveAsset(Buffer.from('una'), {
      title: 'Scene 1 — Pelikula', ext: 'mp4', mime: 'video/mp4', source: 't',
    });
    const b = saveAsset(Buffer.from('ikalawa'), {
      title: 'Scene 1 — Pelikula', ext: 'mp4', mime: 'video/mp4', source: 't',
    });
    assert.notEqual(a.name, b.name);
    assert.equal(listAssets().length, 2, 'both renders survive on disk');
    assert.equal(fs.readFileSync(
      path.join(process.env.DIREK_ASSETS_DIR!, a.name), 'utf8'), 'una');
    assert.equal(fs.readFileSync(
      path.join(process.env.DIREK_ASSETS_DIR!, b.name), 'utf8'), 'ikalawa');
  });
});
