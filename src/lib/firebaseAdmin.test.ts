import test from 'node:test';
import assert from 'node:assert/strict';

import {
  adminReady,
  firebaseState,
  firebaseProjectId,
  firebaseLastError,
  resetFirebaseAdmin,
} from './firebaseAdmin.ts';

/**
 * Only the credential resolution is tested here. A real Firestore connection
 * needs a live project, so `adminReady()` is expected to be false in the
 * sandbox — and that is exactly the branch the SQLite fallback depends on.
 */

/** A synthetic PEM, assembled so no literal key block is committed. */
const FAKE_PEM = ['-----BEGIN ', 'PRIVATE KEY-----', '\\nMIIEvQIBADANBg\\n',
  '-----END ', 'PRIVATE KEY-----', '\\n'].join('');

function clearEnv(): void {
  delete process.env.FIREBASE_SERVICE_ACCOUNT;
  delete process.env.FIREBASE_PROJECT_ID;
  delete process.env.FIREBASE_CLIENT_EMAIL;
  delete process.env.FIREBASE_PRIVATE_KEY;
  resetFirebaseAdmin();
}

test('no credentials at all means standby, not a crash', () => {
  clearEnv();
  assert.equal(adminReady(), false);
  assert.equal(firebaseState(), 'standby');
  assert.equal(firebaseProjectId(), null);
  assert.equal(firebaseLastError(), null);
});

test('a service-account JSON with escaped newlines is accepted', () => {
  clearEnv();
  // The shape a host dashboard stores: the PEM on one line with literal \n.
  process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
    projectId: 'movie-creator-test',
    clientEmail: 'robot@movie-creator-test.iam.gserviceaccount.com',
    privateKey: FAKE_PEM,
  });

  assert.equal(firebaseProjectId(), 'movie-creator-test');
  // Initialising with a syntactically fake key must not throw out of the module.
  assert.doesNotThrow(() => adminReady());
  clearEnv();
});

test('a malformed service-account blob is rejected honestly', () => {
  clearEnv();
  process.env.FIREBASE_SERVICE_ACCOUNT = '{ this is not json';
  assert.equal(firebaseProjectId(), null);
  assert.equal(adminReady(), false);
  assert.equal(firebaseState(), 'standby');
  clearEnv();
});

test('a JSON blob missing a field is rejected', () => {
  clearEnv();
  process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
    projectId: 'only-project',
    clientEmail: '',
    privateKey: '',
  });
  assert.equal(firebaseProjectId(), null);
  assert.equal(adminReady(), false);
  clearEnv();
});

test('the split env form is used when the JSON blob is absent', () => {
  clearEnv();
  process.env.FIREBASE_PROJECT_ID = 'split-project';
  process.env.FIREBASE_CLIENT_EMAIL = 'robot@split-project.iam.gserviceaccount.com';
  process.env.FIREBASE_PRIVATE_KEY = FAKE_PEM;

  assert.equal(firebaseProjectId(), 'split-project');
  assert.doesNotThrow(() => adminReady());
  clearEnv();
});

test('the JSON blob wins over the split vars', () => {
  clearEnv();
  process.env.FIREBASE_PROJECT_ID = 'from-split';
  process.env.FIREBASE_CLIENT_EMAIL = 'a@b.c';
  process.env.FIREBASE_PRIVATE_KEY = 'k';
  process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
    projectId: 'from-json',
    clientEmail: 'x@y.z',
    privateKey: FAKE_PEM,
  });

  assert.equal(firebaseProjectId(), 'from-json');
  clearEnv();
});
