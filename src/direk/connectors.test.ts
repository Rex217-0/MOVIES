import test from 'node:test';
import assert from 'node:assert/strict';
import { CONNECTORS, connectorCatalog, runConnector } from './connectors.ts';
import { SKILLS } from './skills.ts';
import { ACTION_SKILLS, MOVIE_ROBO_SYSTEM } from './persona.ts';
import { getExtensionSkills } from './skills.ts';
import { SEASON_ONE_SKILLS } from '../extensions/season01/index.ts';

test('every API skill in the registry has a free local connector', () => {
  const apiSkills = Object.entries(SKILLS)
    .filter(([, spec]) => spec.kind === 'api')
    .map(([name]) => name);
  for (const skill of apiSkills) {
    assert.ok(CONNECTORS[skill], `walang connector para sa '${skill}'`);
  }
});

test('the catalog names what each connector replaces', () => {
  const catalog = connectorCatalog();
  const poster = catalog.find(c => c.skill === 'poster_design');
  assert.equal(poster?.was, 'Orshot');
  assert.match(poster?.free ?? '', /ffmpeg/);
});

test('an unknown skill fails with a clear note instead of throwing', async () => {
  const result = await runConnector('wala_sa_listahan', {});
  assert.equal(result.ok, false);
  assert.match(result.note, /wala_sa_listahan/);
});

test('growth_seo produces a real metadata pack, no credentials needed', async () => {
  const result = await runConnector('growth_seo', { title: 'Alat ng Dagat', keywords: ['drama'] });
  assert.equal(result.ok, true);
  const seo = result.data as { titles: string[]; tags: string[] };
  assert.ok(seo.titles.length >= 2);
  assert.ok(seo.tags.includes('drama'));
  assert.ok(result.assets.length === 1);
  assert.equal(result.download?.mime, 'application/json');
});

test('delete_asset reports honestly when the name is unknown', async () => {
  const result = await runConnector('delete_asset', { name: 'wala-talaga.png' });
  assert.equal(result.ok, false);
  assert.match(result.note, /Hindi mahanap/);
});

test('the persona lists exactly the connectors that exist', () => {
  // Season extensions own extra skills, so those are excluded here: this test is
  // about the built-in connector table staying in step with the persona.
  const extensionOwned = new Set<string>([...getExtensionSkills(), ...SEASON_ONE_SKILLS]);
  const listed = new Set(ACTION_SKILLS.map(s => s.skill).filter(id => !extensionOwned.has(id)));
  for (const skill of Object.keys(CONNECTORS)) {
    assert.ok(listed.has(skill), `hindi nakalista sa persona: ${skill}`);
  }
  for (const skill of listed) {
    assert.ok(CONNECTORS[skill], `nasa persona pero walang connector: ${skill}`);
  }
});

test('the system prompt teaches the model to emit an action block', () => {
  assert.match(MOVIE_ROBO_SYSTEM, /```action/);
  assert.match(MOVIE_ROBO_SYSTEM, /"skill"/);
});
