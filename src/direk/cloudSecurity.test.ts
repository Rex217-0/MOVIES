/**
 * Guards for the cloud-facing configuration. These read the repo files that
 * decide who may read the private vault, so a future edit cannot quietly widen
 * access or commit a secret.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const rules = fs.readFileSync(path.join(repoRoot, 'firestore.rules'), 'utf8');

/** The `allow read: ... ;` statement inside one `match /Collection/{id} {}`. */
function readRuleFor(collection: string): string {
  const start = rules.indexOf(`match /${collection}/`);
  assert.ok(start !== -1, `no rules block for ${collection}`);
  const block = rules.slice(start, rules.indexOf('\n    }', start));
  const statements = block.split(';').filter(s => s.includes('allow read'));
  assert.equal(statements.length, 1, `${collection} should have exactly one read rule`);
  return statements[0];
}

test('the private vault is never readable by an anonymous user', () => {
  for (const collection of ['MovieJobs', 'SceneJobs']) {
    const rule = readRuleFor(collection);
    assert.match(rule, /request\.auth\.token\.admin == true/,
      `${collection} read must require the admin claim, not just sign-in`);
  }
});

test('movie history stays bound to its own uid', () => {
  const start = rules.indexOf('match /users/{userId}/movie_history/');
  const block = rules.slice(start, rules.indexOf('\n    }', start));
  assert.match(block, /request\.auth\.uid == userId/);
});

test('a catch-all deny is present, so unlisted collections are closed', () => {
  assert.match(rules, /match \/\{document=\*\*\} \{\s*\n\s*allow read, write: if false;/);
});

test('no OAuth secret or private key is committed anywhere in the repo', () => {
  const secretish = /(GOCSPX-[A-Za-z0-9_-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      if (entry.name === '.git' || entry.name === 'node_modules') return [];
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });
  const offenders = walk(repoRoot).filter(f => {
    try { return secretish.test(fs.readFileSync(f, 'utf8')); } catch { return false; }
  });
  assert.deepEqual(offenders, [], `secrets found in: ${offenders.join(', ')}`);
});
