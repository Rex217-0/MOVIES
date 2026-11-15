import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyTask, tierOf, classifyLoraTraining, planExecution, route_to_cloud,
  routingTable, t3LocalAllowed, isLocalVideoTask, TASK_TIERS, TIER_LABELS, type Tier,
} from './taskRouter.ts';

test('tierOf maps every known task type to its tier', () => {
  assert.equal(tierOf('chat'), 'T1');
  assert.equal(tierOf('text'), 'T1');
  assert.equal(tierOf('webhooks'), 'T1');
  assert.equal(tierOf('lora_text'), 'T1');
  assert.equal(tierOf('image_generation'), 'T2');
  assert.equal(tierOf('pollinations'), 'T2');
  assert.equal(tierOf('piper_tts'), 'T2');
  assert.equal(tierOf('lora_train_small'), 'T2');
  assert.equal(tierOf('video_render'), 'T3');
  assert.equal(tierOf('animatediff'), 'T3');
  assert.equal(tierOf('fish_tts'), 'T3');
  assert.equal(tierOf('lora_train_large'), 'T3');
});

test('tierOf normalises case, spaces and dashes', () => {
  assert.equal(tierOf('Video Render'), 'T3');
  assert.equal(tierOf('IMAGE-GENERATION'), 'T2');
  assert.equal(tierOf('  Webhook  '), 'T1');
});

test('tierOf returns null for a task it does not know', () => {
  assert.equal(tierOf('teleport'), null);
  assert.equal(tierOf(''), null);
});

test('classifyTask gives the tier, the placement and a reason', () => {
  const chat = classifyTask('chat');
  assert.equal(chat.tier, 'T1');
  assert.equal(chat.placement, 'local');
  assert.match(chat.reason, /CPU/i);

  const video = classifyTask('video_render');
  assert.equal(video.tier, 'T3');
  assert.equal(video.placement, 'local', 'video renders on the local ComfyUI');
  assert.match(video.reason, /ComfyUI/i);
});

test('an unknown task defaults to T3 so it never loads the local GPU', () => {
  const route = classifyTask('some_new_heavy_thing');
  assert.equal(route.tier, 'T3');
  assert.equal(route.placement, 'cloud');
  assert.equal(route.task, 'some_new_heavy_thing');
});

test('classifyLoraTraining keeps a small run local and offloads a large one', () => {
  const small = classifyLoraTraining({ samples: 8, resolution: 1024, networkDim: 32, epochs: 10 });
  assert.equal(small.tier, 'T2');
  assert.equal(small.placement, 'local');

  const large = classifyLoraTraining({ samples: 40, resolution: 2048, networkDim: 128, epochs: 20 });
  assert.equal(large.tier, 'T3');
  assert.equal(large.placement, 'cloud');
});

test('classifyLoraTraining flags a big epoch count even at low resolution', () => {
  // 20 samples x 30 epochs = 600 > the 400 threshold.
  const route = classifyLoraTraining({ samples: 20, epochs: 30, resolution: 1024, networkDim: 32 });
  assert.equal(route.tier, 'T3');
});

test('planExecution runs T1 and T2 locally', () => {
  assert.equal(planExecution('chat').run, 'local');
  assert.equal(planExecution('image_generation').run, 'local');
});

test('planExecution offloads a non-video T3 when a cloud worker is configured', () => {
  const before = process.env.CLOUD_T3_URL;
  process.env.CLOUD_T3_URL = 'https://cloud.example/run';
  try {
    const plan = planExecution('fish_tts');
    assert.equal(plan.run, 'cloud');
    assert.equal(plan.route.tier, 'T3');
  } finally {
    if (before === undefined) delete process.env.CLOUD_T3_URL;
    else process.env.CLOUD_T3_URL = before;
  }
});

test('planExecution offloads a non-video T3 when the local box is forbidden (T3_ALLOW_LOCAL=0)', () => {
  const cloud = process.env.CLOUD_T3_URL;
  const allow = process.env.T3_ALLOW_LOCAL;
  delete process.env.CLOUD_T3_URL;
  process.env.T3_ALLOW_LOCAL = '0';
  try {
    const plan = planExecution('tts_large');
    assert.equal(plan.run, 'cloud', 'non-video T3 must not run on Server-2 when forbidden');
  } finally {
    if (cloud === undefined) delete process.env.CLOUD_T3_URL; else process.env.CLOUD_T3_URL = cloud;
    if (allow === undefined) delete process.env.T3_ALLOW_LOCAL; else process.env.T3_ALLOW_LOCAL = allow;
  }
});

test('planExecution falls back to the local GPU only when T3 is allowed and no cloud worker is set', () => {
  const cloud = process.env.CLOUD_T3_URL;
  const allow = process.env.T3_ALLOW_LOCAL;
  delete process.env.CLOUD_T3_URL;
  delete process.env.T3_ALLOW_LOCAL;
  try {
    const plan = planExecution('fish_tts');
    assert.equal(plan.run, 'local');
    assert.equal(plan.route.placement, 'local', 'the reported placement follows the fallback');
  } finally {
    if (cloud !== undefined) process.env.CLOUD_T3_URL = cloud;
    if (allow !== undefined) process.env.T3_ALLOW_LOCAL = allow;
  }
});

test('video render always runs on the local ComfyUI, never the cloud', () => {
  const cloud = process.env.CLOUD_T3_URL;
  const allow = process.env.T3_ALLOW_LOCAL;
  // Even with a cloud worker set and the local box forbidden, video stays local.
  process.env.CLOUD_T3_URL = 'https://cloud.example/run';
  process.env.T3_ALLOW_LOCAL = '0';
  try {
    for (const task of ['video', 'video_render', 'animatediff', 'svd']) {
      const plan = planExecution(task);
      assert.equal(plan.run, 'local', `${task} must render on the local ComfyUI`);
      assert.equal(plan.route.placement, 'local');
      assert.equal(plan.route.tier, 'T3');
    }
  } finally {
    if (cloud === undefined) delete process.env.CLOUD_T3_URL; else process.env.CLOUD_T3_URL = cloud;
    if (allow === undefined) delete process.env.T3_ALLOW_LOCAL; else process.env.T3_ALLOW_LOCAL = allow;
  }
});

test('route_to_cloud reports the job as queued and never claims success', () => {
  const before = process.env.CLOUD_T3_URL;
  delete process.env.CLOUD_T3_URL;
  try {
    const result = route_to_cloud('video_render', { prompt: 'bagyo' });
    assert.equal(result.ok, false, 'the placeholder must not claim it ran');
    assert.equal(result.job.task, 'video_render');
    assert.equal(result.job.tier, 'T3');
    assert.deepEqual(result.job.payload, { prompt: 'bagyo' });
    assert.match(result.note, /cloud/i);
  } finally {
    if (before !== undefined) process.env.CLOUD_T3_URL = before;
  }
});

test('route_to_cloud names the configured worker when one is set', () => {
  const before = process.env.CLOUD_T3_URL;
  process.env.CLOUD_T3_URL = 'https://cloud.example/run';
  try {
    const result = route_to_cloud('fish_tts');
    assert.equal(result.provider, 'https://cloud.example/run');
    assert.match(result.note, /cloud\.example/);
  } finally {
    if (before === undefined) delete process.env.CLOUD_T3_URL;
    else process.env.CLOUD_T3_URL = before;
  }
});

test('routingTable lists every task with its tier and placement, T1 first', () => {
  const table = routingTable();
  assert.equal(table.length, Object.keys(TASK_TIERS).length);
  for (const row of table) {
    assert.ok(['T1', 'T2', 'T3'].includes(row.tier));
    const offloaded = row.tier === 'T3' && !isLocalVideoTask(row.task);
    assert.equal(row.placement, offloaded ? 'cloud' : 'local');
  }
  // Sorted by tier, so the light work comes first.
  const tiers = table.map(r => r.tier) as Tier[];
  assert.deepEqual(tiers, [...tiers].sort());
  assert.equal(table[0].tier, 'T1');
});

test('every tier has a human-readable label', () => {
  for (const tier of ['T1', 'T2', 'T3'] as Tier[]) {
    assert.ok(TIER_LABELS[tier]);
    assert.ok(TIER_LABELS[tier].length > 5);
  }
});

test('t3LocalAllowed defaults to allowed and respects T3_ALLOW_LOCAL=0', () => {
  const before = process.env.T3_ALLOW_LOCAL;
  delete process.env.T3_ALLOW_LOCAL;
  try {
    assert.equal(t3LocalAllowed(), true);
    process.env.T3_ALLOW_LOCAL = '0';
    assert.equal(t3LocalAllowed(), false);
  } finally {
    if (before === undefined) delete process.env.T3_ALLOW_LOCAL;
    else process.env.T3_ALLOW_LOCAL = before;
  }
});
