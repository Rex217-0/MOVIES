/**
 * The gate must judge real model output correctly in both directions.
 *
 * Every screenplay fixture below came from an actual free-provider run, not from
 * a hand-written example. That matters: the bugs this pins were only visible in
 * real answers — markdown headings ("### **Eksena 1**"), an English scene keyword
 * ("Scene 1"), a script that stopped on a comma, and a 38%-repetitive script that
 * the app had been accepting.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reduplicationErrors,
  repeatedPhrases,
  screenplayReport,
  screenplayShape,
  tagalogReport,
} from './tagalogGate.ts';

const GOOD = `PAMAGAT: Gintong Buto

EKSENA 1: Bukid sa Nueva Ecija - Umaga
VISUAL: Ang bukid ay basa ng hamog at ang araw ay unti-unting sumisikat.
NARRATION: Si Mang Isko ay yumuko at may nakita sa lupa.

EKSENA 2: Bahay ni Mang Isko - Hapon
VISUAL: Ang maliit na bahay na kawayan ay puno ng amoy ng sinaing.
NARRATION: Ipinakita niya sa kanyang asawa ang gintong buto.

EKSENA 3: Bukid sa Nueva Ecija - Susunod na umaga
VISUAL: Dahan-dahang tumubo ang isang kakaibang halaman sa gitna ng bukid.
NARRATION: Napatakip ng bibig si Mang Isko sa kanyang nakita.
`;

test('a complete screenplay passes and counts its shape', () => {
  const report = screenplayReport(GOOD);
  assert.equal(report.shape.eksena, 3);
  assert.equal(report.shape.visual, 3);
  assert.equal(report.shape.narration, 3);
  assert.equal(report.shape.pamagat, 1);
  assert.equal(report.ok, true, report.issues.join('; '));
});

test('markdown headings still count as scenes and a title', () => {
  // A real free model answered exactly this way and the gate counted 0 scenes.
  const marked = GOOD.replace('PAMAGAT:', '**Pamagat:**')
    .replace('EKSENA 1:', '### **Eksena 1**')
    .replace('EKSENA 2:', '### **Eksena 2**')
    .replace('EKSENA 3:', '### **Eksena 3**');
  const shape = screenplayShape(marked);
  assert.equal(shape.eksena, 3);
  assert.equal(shape.pamagat, 1);
});

test('the English word SCENE counts as a scene heading', () => {
  // A real free model wrote "Scene 1" under a Filipino body; counting only
  // EKSENA reported 0 scenes and rejected a filmable script.
  const english = GOOD.replace(/EKSENA (\d):/g, 'Scene $1:');
  assert.equal(screenplayShape(english).eksena, 3);
});

test('a truncated screenplay is rejected even when the language score is high', () => {
  const cut = GOOD.slice(0, GOOD.indexOf('Napatakip')) + 'Napatakip ng bibig si Mang Isko sa kanyang';
  const report = screenplayReport(cut);
  assert.equal(report.ok, false);
  assert.ok(report.issues.includes('putol ang screenplay sa dulo'), report.issues.join('; '));
});

test('an essay with correct Tagalog but no scenes is rejected', () => {
  const essay = 'Simula. Ang kwento ay tungkol sa isang magsasaka na may nakita. '
    + 'Gitna. Siya ay naglakbay papunta sa bayan at doon ay nagtanong. '
    + 'Wakas. Siya ay umuwi at ang kanyang pamilya ay masaya.';
  const report = screenplayReport(essay);
  assert.equal(report.ok, false);
  assert.equal(report.shape.eksena, 0);
});

test('a fake VISUAL line outside any scene does not make a screenplay', () => {
  const faked = 'Ang sanaysay na ito ay mahaba at walang eksena. '.repeat(8)
    + '\nVISUAL: peke\nNARRATION: peke';
  const report = screenplayReport(faked);
  assert.equal(report.ok, false);
  assert.equal(report.shape.visual, 0);
});

test('a repetitive script is rejected on the measured ratio', () => {
  // A real free-model run repeated 38% of its 3-grams and the app accepted it.
  const spam = 'Ang ang ang ang tao ay ay ay pumunta sa sa sa bahay. '.repeat(6);
  const report = screenplayReport(spam);
  assert.equal(report.ok, false);
  assert.ok(report.score < 55, `score was ${report.score}`);
});

test('real reduplication with a linker is not an invented word', () => {
  // "unti-unting" and "dahan-dahang" are correct Tagalog; both were flagged.
  assert.deepEqual(reduplicationErrors('Ang araw ay unti-unting sumikat at dahan-dahang lumakas.'), []);
  assert.deepEqual(reduplicationErrors('Araw-araw siyang naglalakad papunta sa bukid.'), []);
  assert.deepEqual(reduplicationErrors('Ang bahay-kubo ay maliit lamang.'), []);
});

test('invented hyphenated words are still caught', () => {
  assert.ok(reduplicationErrors('May pagkakaiba-biba sa kanyang sinabi.').includes('pagkakaiba-biba'));
  assert.ok(reduplicationErrors('Iyon ay masamang-masama para sa lahat.').includes('masamang-masama'));
});

test('repeatedPhrases reports both the repeats and the total', () => {
  const { repeated, grams } = repeatedPhrases('ang tao ay ang tao ay ang tao ay');
  assert.ok(repeated > 0);
  assert.ok(grams > 0);
});

test('tagalogReport says why a script is weak instead of only scoring it', () => {
  const { score, issues } = tagalogReport('Ang ang ang ang tao ay ay ay pumunta sa sa sa bahay. '.repeat(6));
  assert.ok(score < 55);
  assert.ok(issues.some(i => i.startsWith('paulit-ulit')), issues.join('; '));
});

test('an empty script scores zero and is not accepted', () => {
  const report = screenplayReport('');
  assert.equal(report.ok, false);
  assert.equal(report.score, 0);
});
