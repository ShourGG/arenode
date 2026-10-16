import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDatabase } from '../src/db.js';
import { hashPassword } from '../src/security.js';
import { createApp } from '../src/app.js';

async function fixture(t, trustedProxyCidrs) {
  const db = createDatabase();
  db.prepare('INSERT INTO users (username,password_hash,role,site_limit) VALUES (?,?,?,?)')
    .run('ip_user', hashPassword('ip-test-password'), 'user', 1);
  const limits = [];
  const cache = { rateLimit: async (scope, identity) => { limits.push({ scope, identity }); return { allowed: true }; } };
  const config = { appOrigin: 'http://127.0.0.1', sessionHours: 24, trustedProxyCidrs };
  const server = http.createServer(createApp({ db, cdnfly: {}, config, cache }));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = headers => fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ username: 'ip_user', password: 'ip-test-password' }),
  });
  return { db, limits, login, base };
}

test('trusted proxy chain records the nearest untrusted visitor in session, audit and rate limiting', async t => {
  const f = await fixture(t, ['127.0.0.1/32', '203.0.113.80/32']);
  const r = await f.login({ 'x-forwarded-for': '192.0.2.199, 198.51.100.24, 203.0.113.80' });
  assert.equal(r.status, 200);
  assert.equal(f.db.prepare('SELECT ip FROM sessions').get().ip, '198.51.100.24');
  assert.equal(f.db.prepare("SELECT ip FROM audit_logs WHERE action='login.success'").get().ip, '198.51.100.24');
  assert.equal(f.limits.find(x => x.scope === 'login').identity, '198.51.100.24');
});

test('direct untrusted peers cannot spoof their session IP with forwarding headers', async t => {
  const f = await fixture(t, ['203.0.113.80/32']);
  const r = await f.login({ 'x-forwarded-for': '192.0.2.199', 'x-real-ip': '192.0.2.200', 'cf-connecting-ip': '192.0.2.201' });
  assert.equal(r.status, 200);
  assert.equal(f.db.prepare('SELECT ip FROM sessions').get().ip, '127.0.0.1');
});

test('an untrusted intermediate hop stops traversal before attacker-supplied prefixes', async t => {
  const f = await fixture(t, ['127.0.0.1/32']);
  const r = await f.login({ 'x-forwarded-for': '192.0.2.199, 198.51.100.24, 203.0.113.7' });
  assert.equal(r.status, 200);
  assert.equal(f.db.prepare('SELECT ip FROM sessions').get().ip, '203.0.113.7');
});

test('malformed forwarded hop cannot be skipped to reach a spoofed prefix', async t => {
  const f = await fixture(t, ['127.0.0.1/32', '203.0.113.80/32']);
  const r = await f.login({ 'x-forwarded-for': '192.0.2.199, invalid, 203.0.113.80' });
  assert.equal(r.status, 200);
  assert.equal(f.db.prepare('SELECT ip FROM sessions').get().ip, '203.0.113.80');
});

test('IPv4-mapped IPv6 headers normalize to IPv4 and genuine IPv6 visitors remain valid', async t => {
  const f = await fixture(t, ['127.0.0.1/32', '203.0.113.80/32']);
  for (const [forwarded, expected] of [
    ['::ffff:198.51.100.24, ::ffff:203.0.113.80', '198.51.100.24'],
    ['2001:db8::42, 203.0.113.80', '2001:db8::42'],
  ]) {
    const r = await f.login({ 'x-forwarded-for': forwarded });
    assert.equal(r.status, 200);
    const hash = (await r.json()).user.id;
    assert.ok(hash);
    const rows = f.db.prepare('SELECT ip FROM sessions').all();
    assert.equal(rows.at(-1).ip, expected);
  }
});

test('new login stores both historical and most recently observed IP', async t => {
  const f = await fixture(t, ['127.0.0.1/32', '203.0.113.80/32']);
  assert.equal((await f.login({ 'x-forwarded-for': '198.51.100.24, 203.0.113.80' })).status, 200);
  const session = f.db.prepare('SELECT * FROM sessions').get();
  assert.equal(session.ip, '198.51.100.24');
  assert.equal(session.last_ip, '198.51.100.24');
});

test('existing session activity refreshes recent IP without rewriting its historical login IP', async t => {
  const f = await fixture(t, ['127.0.0.1/32', '203.0.113.80/32']);
  const login = await f.login({ 'x-forwarded-for': '198.51.100.24, 203.0.113.80' });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  f.db.prepare("UPDATE sessions SET ip='::ffff:172.23.0.1'").run();
  for (const ip of ['198.51.100.31', '198.51.100.32']) {
    const response = await fetch(`${f.base}/api/account/sessions`, {
      headers: { cookie, 'x-forwarded-for': `192.0.2.199, ${ip}, 203.0.113.80` },
    });
    assert.equal(response.status, 200);
    const current = (await response.json()).sessions.find(s => s.current);
    const stored = f.db.prepare('SELECT * FROM sessions').get();
    assert.equal(stored.ip, '::ffff:172.23.0.1');
    assert.equal(stored.last_ip, ip);
    assert.equal(current.ip, '::ffff:172.23.0.1');
    assert.equal(current.lastIp, ip);
  }
});

test('administrator customer detail includes latest observed IP without changing another device', async t => {
  const f = await fixture(t, ['127.0.0.1/32', '203.0.113.80/32']);
  const first = await f.login({ 'x-forwarded-for': '198.51.100.24, 203.0.113.80' });
  const cookie = first.headers.get('set-cookie').split(';')[0];
  const firstSession = f.db.prepare('SELECT * FROM sessions').get();
  f.db.prepare("UPDATE sessions SET ip='::ffff:172.23.0.1' WHERE token_hash=?").run(firstSession.token_hash);
  assert.equal((await f.login({ 'x-forwarded-for': '198.51.100.40, 203.0.113.80' })).status, 200);
  assert.equal((await fetch(`${f.base}/api/me`, { headers: { cookie, 'x-forwarded-for': '198.51.100.31, 203.0.113.80' } })).status, 200);
  f.db.prepare('INSERT INTO users (username,password_hash,role,site_limit) VALUES (?,?,?,?)')
    .run('ip_admin', hashPassword('ip-admin-password'), 'admin', 0);
  const admin = await fetch(`${f.base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'ip_admin', password: 'ip-admin-password' }),
  });
  assert.equal(admin.status, 200);
  const detail = await fetch(`${f.base}/api/admin/customers/${firstSession.user_id}`, {
    headers: { cookie: admin.headers.get('set-cookie').split(';')[0] },
  });
  assert.equal(detail.status, 200);
  const sessions = (await detail.json()).sessions;
  const active = sessions.find(s => s.id === firstSession.token_hash.slice(0, 16));
  assert.equal(active.ip, '::ffff:172.23.0.1');
  assert.equal(active.last_ip, '198.51.100.31');
  assert.equal(active.token_hash, undefined);
  assert.equal(sessions.find(s => s.id !== active.id).last_ip, '198.51.100.40');
});
