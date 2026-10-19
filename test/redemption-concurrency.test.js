import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/db.js';
import { handleRedemptionApi } from '../src/redemption.js';

for (const method of ['PUT', 'DELETE']) {
  test(`并发销毁后管理员 ${method} 不能覆盖兑换码状态`, async t => {
    const db = createDatabase(); t.after(() => db.close());
    const id = db.prepare("INSERT INTO redemption_codes (code_hash,code_suffix,label,type,product_id) VALUES ('hash','suffix','test','plan',1)").run().lastInsertRowid;
    // Commit destruction immediately after the handler's initial read, before
    // its write. This deterministically exercises both stale-read paths.
    let injected = false;
    const interleavedDb = { prepare(sql) {
      const statement = db.prepare(sql);
      if (sql === 'SELECT * FROM redemption_codes WHERE id=?') return { async get(...params) {
        const row = await statement.get(...params);
        if (!injected) {
          injected = true;
          db.prepare("UPDATE redemption_codes SET status='destroyed',destroyed_at=CURRENT_TIMESTAMP,destroyed_reason='plan_once_collision' WHERE id=?").run(id);
        }
        return row;
      } };
      return statement;
    } };
    const call = database => handleRedemptionApi({ req: { method }, url: new URL(`/api/admin/billing/redemption-codes/${id}`, 'http://localhost'), user: { role: 'admin', id: 1 }, db: database, billing: {}, readBody: async () => ({ label: 'renamed' }) });
    await assert.rejects(call(interleavedDb), error => error.status === 409 && /销毁/.test(error.message));
    const row = db.prepare('SELECT * FROM redemption_codes WHERE id=?').get(id);
    assert.equal(row.status, 'destroyed'); assert.equal(row.label, 'test');
    assert.ok(row.destroyed_at); assert.equal(row.destroyed_reason, 'plan_once_collision');
    // Ordinary active codes remain editable and disableable.
    db.prepare("UPDATE redemption_codes SET status='active',destroyed_at=NULL,destroyed_reason=NULL WHERE id=?").run(id);
    assert.equal((await call(db)).status, 200);
    assert.equal(db.prepare('SELECT status FROM redemption_codes WHERE id=?').get(id).status, method === 'PUT' ? 'active' : 'disabled');
  });
}
