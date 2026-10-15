import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDatabase } from '../src/db.js';
import { hashPassword } from '../src/security.js';
import { BillingService } from '../src/billing.js';
import { createApp } from '../src/app.js';

function request(base, path, cookie, method = 'GET', body) {
  return fetch(`${base}${path}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function login(base, username, password) {
  const response = await request(base, '/api/auth/login', null, 'POST', { username, password });
  assert.equal(response.status, 200, await response.text());
  return response.headers.get('set-cookie').split(';')[0];
}

test('灾后认领一次激活、复用同一套餐并拒绝第十六个域名', async t => {
  const db = createDatabase();
  const admin = Number(db.prepare('INSERT INTO users (username,password_hash,role,site_limit) VALUES (?,?,?,?)')
    .run('admin', hashPassword('admin-password'), 'admin', 0).lastInsertRowid);
  const user = Number(db.prepare('INSERT INTO users (username,password_hash,role,site_limit) VALUES (?,?,?,?)')
    .run('recover-user', hashPassword('recover-password'), 'user', 0).lastInsertRowid);
  const upstreamId = Number(db.prepare(`INSERT INTO upstream_accounts (name,base_url,api_key_encrypted,api_secret_encrypted,status,is_default)
    VALUES ('recovery-test','https://upstream.example','key','secret','active',1)`).run().lastInsertRowid);
  db.prepare(`INSERT INTO upstream_packages (upstream_id,package_id,name,enabled) VALUES (?,?,?,1)`).run(upstreamId, '16180', '恢复上游套餐');
  const sites = Array.from({ length: 16 }, (_, index) => ({
    id: `up-${index + 1}`, domain: `recover-${index + 1}.example.com`, backend: [{ addr: `192.0.2.${index + 1}` }],
    http_listen: { port: '80', enable: 1 }, enable: 1,
  }));
  let txtValue = '';
  const upstreams = {
    row: async id => db.prepare('SELECT * FROM upstream_accounts WHERE id=? AND status=\'active\'').get(id),
    clientForAccount: async () => ({
      request: async (_method, path) => {
        const page = Number(new URL(`http://recovery.test${path}`).searchParams.get('page') || 1);
        return { items: sites.slice((page - 1) * 10, page * 10) };
      },
    }),
  };
  const billing = await new BillingService(db, { health: async () => true, request: async () => [] }, { upstreams }).initialize();
  const server = http.createServer(createApp({
    db,
    cdnfly: { health: async () => true, request: async () => [] },
    upstreams,
    billing,
    config: { appOrigin: 'http://127.0.0.1', sessionHours: 24 },
    dnsResolveTxt: async () => [[txtValue]],
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); db.close(); });

  const adminCookie = await login(base, 'admin', 'admin-password');
  const imported = await request(base, '/api/admin/recovery/sites/import', adminCookie, 'POST', { upstreamId, upstreamPackageId: '16180' });
  const importedData = await imported.json();
  assert.equal(imported.status, 200, JSON.stringify(importedData));
  assert.equal(importedData.seen, 16);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM recovery_sites WHERE status='orphaned'").get().count, 16);

  const userCookie = await login(base, 'recover-user', 'recover-password');
  const claim = await request(base, '/api/recovery/claims', userCookie, 'POST', { domain: 'recover-1.example.com' });
  const claimData = await claim.json(); txtValue = claimData.claim.record.value;
  assert.equal(claim.status, 201, JSON.stringify(claimData));
  const verified = await request(base, `/api/recovery/claims/${claimData.claim.id}/verify`, userCookie, 'POST', {});
  const first = await verified.json(); assert.equal(verified.status, 200, JSON.stringify(first)); assert.equal(first.activated, true);

  const secondClaim = await request(base, '/api/recovery/claims', userCookie, 'POST', { domain: 'recover-2.example.com' });
  const secondData = await secondClaim.json(); txtValue = secondData.claim.record.value;
  assert.equal(secondClaim.status, 201, JSON.stringify(secondData));
  const secondVerified = await request(base, `/api/recovery/claims/${secondData.claim.id}/verify`, userCookie, 'POST', {});
  const second = await secondVerified.json(); assert.equal(secondVerified.status, 200, JSON.stringify(second)); assert.equal(second.activated, false);
  assert.equal(second.subscriptionId, first.subscriptionId);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM recovery_activation_grants WHERE user_id=?').get(user).count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM subscriptions WHERE user_id=?').get(user).count, 1);

  for (let index = 3; index <= 15; index += 1) {
    const extraClaim = await request(base, '/api/recovery/claims', userCookie, 'POST', { domain: `recover-${index}.example.com` });
    const extraData = await extraClaim.json(); assert.equal(extraClaim.status, 201, JSON.stringify(extraData));
    txtValue = extraData.claim.record.value;
    const extraVerified = await request(base, `/api/recovery/claims/${extraData.claim.id}/verify`, userCookie, 'POST', {});
    const extraResult = await extraVerified.json(); assert.equal(extraVerified.status, 200, JSON.stringify(extraResult));
  }

  const sixteenthClaim = await request(base, '/api/recovery/claims', userCookie, 'POST', { domain: 'recover-16.example.com' });
  const sixteenth = await sixteenthClaim.json(); txtValue = sixteenth.claim.record.value;
  assert.equal(sixteenthClaim.status, 201, JSON.stringify(sixteenth));
  const rejected = await request(base, `/api/recovery/claims/${sixteenth.claim.id}/verify`, userCookie, 'POST', {});
  const rejectedData = await rejected.json(); assert.equal(rejected.status, 409, JSON.stringify(rejectedData));
  assert.match(rejectedData.error, /域名额度不足/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM recovery_sites WHERE owner_id=?").get(user).count, 15);
  assert.equal(db.prepare('SELECT domain_limit,traffic_limit_bytes,port_limit,enabled,activation_mode FROM plans WHERE code=?').get('recovery-2026-01').domain_limit, 15);
  assert.equal(db.prepare('SELECT traffic_limit_bytes FROM plans WHERE code=?').get('recovery-2026-01').traffic_limit_bytes, null);
  const recoveryPlan = db.prepare('SELECT id FROM plans WHERE code=?').get('recovery-2026-01');
  await assert.rejects(billing.assignPlan(user, recoveryPlan.id), /只能通过域名认领流程激活/);
});
