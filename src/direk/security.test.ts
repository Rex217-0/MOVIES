import test from 'node:test';
import assert from 'node:assert/strict';
import {
  securityHeaders, corsDecision, RateLimiter,
  issueTicket, verifyTicket, ticketToParam, paramToTicket,
} from './security.ts';

test('security headers lock the app down without breaking it', () => {
  const h = securityHeaders();
  assert.equal(h['X-Content-Type-Options'], 'nosniff');
  assert.equal(h['X-Frame-Options'], 'DENY');
  assert.match(h['Strict-Transport-Security'], /max-age=\d+/);
});

test('cors allows same-origin, the allow-list, and wildcard, and refuses the rest', () => {
  assert.equal(corsDecision(undefined, []).allowed, true, 'no Origin is same-origin');
  assert.equal(corsDecision('https://app.example', ['https://app.example']).allowed, true);
  assert.equal(corsDecision('https://evil.example', ['https://app.example']).allowed, false);
  assert.equal(corsDecision('https://anything', ['*']).allowed, true);
  const wild = corsDecision('https://anything', ['*']);
  assert.equal(wild.headers['Access-Control-Allow-Origin'], '*');
  const exact = corsDecision('https://app.example', ['https://app.example']);
  assert.equal(exact.headers['Access-Control-Allow-Origin'], 'https://app.example');
});

test('the rate limiter allows up to the limit then refuses with a retry hint', () => {
  const rl = new RateLimiter(3, 1000);
  assert.equal(rl.check('ip', 0).allowed, true);
  assert.equal(rl.check('ip', 10).allowed, true);
  assert.equal(rl.check('ip', 20).allowed, true);
  const blocked = rl.check('ip', 30);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfter, 1);
  // A different client has its own window.
  assert.equal(rl.check('other', 30).allowed, true);
  // After the window resets, the first client is allowed again.
  assert.equal(rl.check('ip', 1100).allowed, true);
});

test('rate limiter windows are pruned so the map cannot grow without bound', () => {
  const rl = new RateLimiter(1, 1000);
  rl.check('a', 0);
  rl.check('b', 0);
  rl.prune(2000);
  // Both expired; a fresh check starts a new window.
  assert.equal(rl.check('a', 2000).remaining, 0);
});

test('a stream ticket is valid only for its purpose and before it expires', () => {
  const secret = 'test-secret';
  const ticket = issueTicket(secret, 'stream', 60_000, 1000);
  assert.equal(verifyTicket(secret, 'stream', ticket.value, ticket.expiresAt, 2000), true);
  assert.equal(verifyTicket(secret, 'stream', ticket.value, ticket.expiresAt, 1000 + 61_000), false, 'expired');
  assert.equal(verifyTicket(secret, 'other', ticket.value, ticket.expiresAt, 2000), false, 'wrong purpose');
  assert.equal(verifyTicket('other-secret', 'stream', ticket.value, ticket.expiresAt, 2000), false, 'wrong secret');
  assert.equal(verifyTicket(secret, 'stream', 'forged', ticket.expiresAt, 2000), false, 'forged value');
});

test('a ticket survives a round-trip through a URL parameter', () => {
  const ticket = issueTicket('s', 'stream', 1000, 5000);
  const parsed = paramToTicket(ticketToParam(ticket));
  assert.ok(parsed);
  assert.equal(parsed!.value, ticket.value);
  assert.equal(parsed!.expiresAt, ticket.expiresAt);
  assert.equal(paramToTicket('nonsense'), null);
  assert.equal(paramToTicket(''), null);
});
