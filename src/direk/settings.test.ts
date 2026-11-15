import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readSettings, writeSettings, applySettings, effectiveSettings, configPath,
} from './settings.ts';

/** Point DIREK_CONFIG at a temp file for the duration of `fn`. */
async function withConfig(fn: () => void | Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'direkcfg-'));
  const saved = process.env.DIREK_CONFIG;
  const savedUrl = process.env.COMFYUI_URL;
  process.env.DIREK_CONFIG = path.join(dir, 'direk.config.json');
  delete process.env.COMFYUI_URL;
  try {
    await fn();
  } finally {
    if (saved === undefined) delete process.env.DIREK_CONFIG;
    else process.env.DIREK_CONFIG = saved;
    if (savedUrl === undefined) delete process.env.COMFYUI_URL;
    else process.env.COMFYUI_URL = savedUrl;
  }
}

test('settings round-trip through the config file', async () => {
  await withConfig(() => {
    assert.equal(configPath(), process.env.DIREK_CONFIG);
    writeSettings({ comfyui_url: 'http://10.0.0.5:8188', kohya_dir: '/opt/kohya_ss' });
    const read = readSettings();
    assert.equal(read.comfyui_url, 'http://10.0.0.5:8188');
    assert.equal(read.kohya_dir, '/opt/kohya_ss');
  });
});

test('applySettings fills the environment without clobbering a real env var', async () => {
  await withConfig(() => {
    process.env.COMFYUI_URL = 'http://env-wins:8188';
    applySettings({ comfyui_url: 'http://from-file:8188', kohya_python: 'python3.11' });
    assert.equal(process.env.COMFYUI_URL, 'http://env-wins:8188');
    assert.equal(process.env.KOHYA_PYTHON, 'python3.11');
    delete process.env.KOHYA_PYTHON;
  });
});

test('applySettings with override lets the UI update live', async () => {
  await withConfig(() => {
    process.env.COMFYUI_URL = 'http://old:8188';
    applySettings({ comfyui_url: 'http://new:8188' }, true);
    assert.equal(process.env.COMFYUI_URL, 'http://new:8188');
  });
});

test('effectiveSettings reports where each value came from', async () => {
  await withConfig(() => {
    writeSettings({ comfyui_url: 'http://file:8188', kohya_dir: '/from/file' });
    process.env.COMFYUI_URL = 'http://env:8188';
    const { settings, source } = effectiveSettings();
    assert.equal(settings.comfyui_url, 'http://env:8188');
    assert.equal(source.comfyui_url, 'env');
    assert.equal(settings.kohya_dir, '/from/file');
    assert.equal(source.kohya_dir, 'file');
    assert.equal(source.kohya_base_model, 'default');
    delete process.env.COMFYUI_URL;
  });
});

test('the video workflow path round-trips through settings and the environment', async () => {
  await withConfig(() => {
    const saved = process.env.COMFYUI_VIDEO_WORKFLOW;
    delete process.env.COMFYUI_VIDEO_WORKFLOW;
    try {
      writeSettings({ comfyui_video_workflow: '/workflows/video.json' });
      assert.equal(readSettings().comfyui_video_workflow, '/workflows/video.json');
      applySettings({ comfyui_video_workflow: '/workflows/video.json' }, true);
      assert.equal(process.env.COMFYUI_VIDEO_WORKFLOW, '/workflows/video.json');
    } finally {
      if (saved === undefined) delete process.env.COMFYUI_VIDEO_WORKFLOW;
      else process.env.COMFYUI_VIDEO_WORKFLOW = saved;
    }
  });
});
