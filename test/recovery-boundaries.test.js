import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/db.js';
import { BillingService } from '../src/billing.js';
import { handleRecoveryApi, importRecoverySites, recoveryInternals } from '../src/recovery.js';

async function fixture(t, domains = 'first.example.com') {
  const db = createDatabase(); t.after(() => db.close());
  const user = { id: Number(db.prepare("INSERT INTO users (username,password_hash,role) VALUES ('alice','unused','user')").run().lastInsertRowid), role: 'user' };
  const other = { id: Number(db.prepare("INSERT INTO users (username,password_hash,role) VALUES ('bob','unused','user')").run().lastInsertRowid), role: 'user' };
  const account = Number(db.prepare("INSERT INTO upstream_accounts (name,base_url,api_key_encrypted,api_secret_encrypted) VALUES ('test','https://upstream.example','unused','unused')").run().lastInsertRowid);
  const items = [
    { id: 'up-1', domain: domains, backend: [{ addr: '192.0.2.10' }], user_package: 100 },
    { id: 'up-2', domain: 'third.example.com', backend: [{ addr: '192.0.2.11' }], user_package: 100 },
    { id: 'up-other', domain: 'other-package.example.com', backend: [{ addr: '192.0.2.12' }], user_package: 200 },
  ];
  const upstreams = {
    row: async () => ({ id: account }),
    clientForAccount: async () => ({ request: async (_method, path) => new URL(path, 'https://upstream.example').searchParams.get('page') === '1' ? { items } : { items: [] } }),
  };
  const billing = await new BillingService(db, { request: async () => [] }).initialize();
  const txt = new Map();
  let resolveTxt = async name => [[txt.get(name) || 'wrong']];
  const call = (path, method = 'GET', body = {}, asUser = user) => handleRecoveryApi({
    req: { method }, url: new URL(path, 'http://localhost'), user: asUser, db, billing, upstreams,
    readBody: async () => body, dnsResolveTxt: name => resolveTxt(name),
  });
  const imported = await importRecoverySites({ db, upstreams, upstreamId: account, upstreamPackageId: '100' });
  const create = domain => call('/api/recovery/claims', 'POST', { domain });
  const verify = (id, asUser = user) => call(`/api/recovery/claims/${id}/verify`, 'POST', {}, asUser);
  return { db, billing, user, other, txt, call, create, verify, imported, setResolver: fn => { resolveTxt = fn; } };
}

test('认领清单只允许管理员查看，TXT 错误不激活套餐', async t => {
  const f = await fixture(t);
  assert.equal(f.imported.seen, 3); assert.equal(f.imported.imported, 2); assert.equal(f.imported.skipped, 1);
  await assert.rejects(f.call('/api/admin/recovery/sites'), /无管理员权限/);
  await assert.rejects(f.call('/api/recovery/sites'), /域名格式无效/);
  const { data } = await f.create('first.example.com');
  await assert.rejects(f.verify(data.claim.id), /TXT 验证值不匹配/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM subscriptions').get().count, 0);
  assert.equal(f.db.prepare('SELECT owner_id FROM recovery_sites').get().owner_id, null);
});

test('验证前不公开站点的其他域名，多域名必须全部完成 TXT 验证', async t => {
  const f = await fixture(t, 'first.example.com second.example.net');
  const lookup = await f.call('/api/recovery/sites?domain=first.example.com');
  assert.equal(lookup.data.site.domain, 'first.example.com');
  const { data } = await f.create('first.example.com');
  assert.doesNotMatch(JSON.stringify(data), /second\.example\.net/);
  f.txt.set(data.claim.record.name, data.claim.record.value);
  const missing = await f.verify(data.claim.id);
  assert.equal(missing.status, 409);
  assert.deepEqual(missing.data.additionalRecordNames, ['_arenode-claim.second.example.net']);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM subscriptions').get().count, 0);
  f.txt.set('_arenode-claim.second.example.net', data.claim.record.value);
  assert.equal((await f.verify(data.claim.id)).status, 200);
  assert.equal(f.db.prepare('SELECT domain FROM sites').get().domain, 'first.example.com second.example.net');
  await assert.rejects(f.verify(data.claim.id), /已过期/);
  await assert.rejects(f.call('/api/recovery/claims', 'POST', { domain: 'first.example.com' }, f.other), /已被其他账号认领/);
});

test('其他客户不能使用本账号的认领挑战', async t => {
  const f = await fixture(t);
  const { data } = await f.create('first.example.com');
  f.txt.set(data.claim.record.name, data.claim.record.value);
  await assert.rejects(f.verify(data.claim.id, f.other), /不存在或已过期/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM recovery_activation_grants').get().count, 0);
});

for (const [label, sql] of [
  ['查询 DNS 期间挑战过期', "UPDATE recovery_claims SET expires_at=CURRENT_TIMESTAMP - INTERVAL '1 minute'"],
  ['查询 DNS 期间重新生成挑战', "UPDATE recovery_claims SET challenge_hash='replacement'"],
]) {
  test(`${label}时不会发放恢复权益`, async t => {
    const f = await fixture(t);
    const { data } = await f.create('first.example.com');
    f.setResolver(async () => { f.db.prepare(sql).run(); return [[data.claim.record.value]]; });
    await assert.rejects(f.verify(data.claim.id), /已过期或更新/);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM subscriptions').get().count, 0);
  });
}

test('恢复套餐不能从普通购买接口获取且到期后不能重新激活', async t => {
  const f = await fixture(t);
  const plan = f.db.prepare("SELECT * FROM plans WHERE activation_mode='recovery'").get();
  assert.equal(plan.enabled, 0); assert.equal(plan.domain_limit, 15); assert.equal(plan.port_limit, 15); assert.equal(plan.duration_days, 30);
  assert.equal(plan.traffic_limit_bytes, null);
  await assert.rejects(f.billing.assignPlan(f.user.id, plan.id), /只能通过域名认领流程激活/);
  const { data } = await f.create('first.example.com');
  f.txt.set(data.claim.record.name, data.claim.record.value);
  const verified = await f.verify(data.claim.id);
  f.db.prepare("UPDATE subscriptions SET status='expired',ends_at=CURRENT_TIMESTAMP - INTERVAL '1 minute' WHERE id=?").run(verified.data.subscriptionId);
  await assert.rejects(f.create('third.example.com'), /恢复套餐已到期/);
  await assert.rejects(f.billing.assignPlan(f.user.id, plan.id), /只能通过域名认领流程激活/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM recovery_activation_grants').get().count, 1);
});

test('恢复分页不能把缩小的页面当作完整清单，重复页面直接报错', async () => {
  const pages = [];
  const result = await recoveryInternals.fetchAllRecoverySites({ request: async (_method, path) => {
    const page = Number(new URL(path, 'https://upstream.example').searchParams.get('page')); pages.push(page);
    return { items: page < 3 ? [{ id: page }] : [] };
  } });
  assert.deepEqual(result.map(item => item.id), [1, 2]); assert.deepEqual(pages, [1, 2, 3]);
  await assert.rejects(recoveryInternals.fetchAllRecoverySites({ request: async () => ({ items: [{ id: 1 }] }) }), /分页没有推进/);
  await assert.rejects(recoveryInternals.fetchAllRecoverySites({ request: async () => ({ unexpected: [] }) }), /列表格式无效/);
  assert.throws(() => recoveryInternals.normalizeDomain(`${'a'.repeat(254)}.example.com`), /域名格式无效/);
});
