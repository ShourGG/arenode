import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { billingInternals } from './billing.js';

export const RECOVERY_CAMPAIGN = 'recovery-2026-01';
export const RECOVERY_PLAN_CODE = 'recovery-2026-01';
const CHALLENGE_TTL_MS = 30 * 60_000;
const RECOVERY_PAGE_SIZE = 10;
const RECOVERY_MAX_PAGES = 1000;

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function text(value, max = 512) {
  return String(value ?? '').trim().slice(0, max);
}

export function normalizeDomain(value) {
  const domain = String(value ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!domain || domain.length > 253 || domain.includes('/') || domain.includes(':') || domain.includes('@') || domain.includes('..')) {
    throw httpError('域名格式无效');
  }
  const labels = domain.replace(/^\*\./, '').split('.');
  if (labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw httpError('域名格式无效');
  return domain;
}

function domainList(value) {
  const result = [];
  for (const item of String(value || '').split(/[\s,]+/)) {
    if (!item) continue;
    result.push(normalizeDomain(item));
  }
  return [...new Set(result)];
}

function claimRecordName(domain) {
  return `_arenode-claim.${normalizeDomain(domain).replace(/^\*\./, '')}`;
}

function collectionItems(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ['items', 'data', 'rows', 'list', 'sites']) {
    const value = payload?.[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
      const nested = collectionItems(value);
      if (nested !== null) return nested;
    }
  }
  return null;
}

async function fetchAllRecoverySites(client) {
  const items = [];
  const seenIds = new Set();
  const pageSignatures = new Set();
  for (let page = 1; page <= RECOVERY_MAX_PAGES; page += 1) {
    const payload = await client.request('GET', `/v1/sites?page=${page}&page_size=${RECOVERY_PAGE_SIZE}`);
    const pageItems = collectionItems(payload);
    if (!pageItems) throw httpError('上游站点列表格式无效，暂时无法完整导入恢复清单', 503);
    if (!pageItems.length) return items;

    const ids = pageItems.map(siteId).filter(Boolean);
    const signature = ids.join('|');
    if (signature && pageSignatures.has(signature)) {
      throw httpError('上游站点分页没有推进，暂时无法完整导入恢复清单', 503);
    }
    if (signature) pageSignatures.add(signature);
    for (const item of pageItems) {
      const id = siteId(item);
      if (!id || !seenIds.has(id)) {
        items.push(item);
        if (id) seenIds.add(id);
      }
    }
  }
  throw httpError('上游站点数量超过恢复导入上限，请分批处理', 503);
}

function firstValue(...values) {
  return values.find(value => value !== undefined && value !== null && String(value).trim() !== '');
}

function extractOrigin(site) {
  const backend = firstValue(site?.backend, site?.backends, site?.origin, site?.origins);
  const item = Array.isArray(backend) ? backend[0] : backend;
  if (typeof item === 'object' && item) return text(firstValue(item.addr, item.address, item.host, item.ip, item.origin), 512);
  return text(item, 512);
}

function siteId(site) {
  return text(firstValue(site?.id, site?.site_id, site?.siteId), 160);
}

function siteDomain(site) {
  // Every alias must survive import so the whole upstream site is verified.
  return String(firstValue(site?.domain, site?.domains, site?.server_name) ?? '').trim();
}

function enabledValue(value) {
  return ![0, false, '0', 'false', 'off', 'disabled', 'inactive'].includes(value);
}

function backendProtocol(site) {
  const value = text(firstValue(site?.backend_protocol, site?.backendProtocol), 20).toLowerCase();
  return ['http', 'https', 'follow'].includes(value) ? value : 'http';
}

export function sitePortList(snapshot) {
  const ports = [];
  const add = (listen, standard) => {
    if (!listen || Number(listen.enable ?? listen.ok ?? 1) === 0) return;
    const raw = Array.isArray(listen) ? listen.flatMap(item => item?.port ?? []) : (listen.port ?? '');
    for (const value of Array.isArray(raw) ? raw : String(raw).split(/[\s,]+/)) {
      const port = Number(value);
      if (Number.isInteger(port) && port > 0 && port <= 65535 && port !== standard) ports.push(port);
    }
  };
  add(snapshot?.http_listen, 80); add(snapshot?.https_listen, 443);
  return [...new Set(ports)];
}

function sanitizeSnapshot(site) {
  const fields = [
    'http_listen', 'https_listen', 'backend_http_port', 'backend_https_port', 'proxy_timeout', 'balance_way',
    'block_proxy', 'recv_real_time', 'send_real_time', 'enable_ipv6', 'black_ip', 'white_ip', 'spider_to_sip',
    'extra_cc_rule', 'proxy_cache', 'proxy_http_version', 'cname', 'groups', 'group_id', 'enable', 'enabled',
  ];
  const snapshot = {};
  for (const field of fields) if (site?.[field] !== undefined) snapshot[field] = site[field];
  return snapshot;
}

function publicRecoverySite(row) {
  return {
    id: Number(row.id), domain: row.domain, status: row.status,
    claimed: Boolean(row.owner_id), claimedAt: row.claimed_at || null,
    createdAt: row.created_at,
  };
}

function publicClaim(row, value = null) {
  return {
    id: Number(row.id), domain: row.matched_domain || row.domain,
    record: { type: 'TXT', name: row.record_name, ...(value ? { value } : {}) },
    expiresAt: row.expires_at,
  };
}

function challengeHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function sameHash(left, right) {
  const a = Buffer.from(left, 'hex'); const b = Buffer.from(right, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function ensureRecoveryPlan(db, upstreamId, packageId) {
  let plan = await db.prepare('SELECT * FROM plans WHERE code=?').get(RECOVERY_PLAN_CODE);
  if (!plan) {
    let group = await db.prepare('SELECT id FROM package_groups ORDER BY id LIMIT 1').get();
    if (!group) {
      const id = (await db.prepare("INSERT INTO package_groups (name,description,sort,enabled) VALUES ('恢复资源','域名认领恢复',9000,0)").run()).lastInsertRowid;
      group = { id };
    }
    await db.prepare(`INSERT INTO plans
      (group_id,code,name,description,price_cents,duration_days,domain_limit,traffic_limit_bytes,port_limit,
       enabled,sort,purchase_mode,max_purchase_qty,renewal_mode,activation_mode,upstream_id,upstream_package_id)
      VALUES (?,?,'站点恢复套餐','域名控制权验证成功后激活，每位客户一次。',0,30,15,NULL,15,0,9000,'once',1,'off','recovery',?,?)
      ON CONFLICT(code) DO NOTHING`).run(group.id, RECOVERY_PLAN_CODE, Number(upstreamId), String(packageId));
    plan = await db.prepare('SELECT * FROM plans WHERE code=?').get(RECOVERY_PLAN_CODE);
  }
  if (plan.activation_mode !== 'recovery') throw httpError('恢复套餐配置无效', 503);
  if (plan.upstream_id && String(plan.upstream_id) !== String(upstreamId)) throw httpError('恢复套餐绑定了其他上游', 409);
  if (plan.upstream_package_id && String(plan.upstream_package_id) !== String(packageId)) throw httpError('恢复套餐绑定了其他上游套餐', 409);
  if (!plan.upstream_id || !plan.upstream_package_id) {
    await db.prepare('UPDATE plans SET upstream_id=?, upstream_package_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(Number(upstreamId), String(packageId), plan.id);
    plan = await db.prepare('SELECT * FROM plans WHERE id=?').get(plan.id);
  }
  return plan;
}

export async function importRecoverySites({ db, upstreams, upstreamId, upstreamPackageId, campaignKey = RECOVERY_CAMPAIGN }) {
  if (!upstreams) throw httpError('多上游服务未启用', 503);
  const account = await upstreams.row(Number(upstreamId), { active: true });
  const packageId = text(upstreamPackageId, 160);
  if (!packageId) throw httpError('上游套餐 ID 必填');
  await ensureRecoveryPlan(db, account.id, packageId);
  const client = await upstreams.clientForAccount(account.id, packageId);
  const items = await fetchAllRecoverySites(client);
  let imported = 0; let skipped = 0;
  await db.transaction(async transaction => {
    for (const item of items) {
      const itemPackage = firstValue(item?.user_package, item?.user_package_id, item?.userPackageId);
      if (itemPackage !== undefined && String(itemPackage) !== packageId) { skipped += 1; continue; }
      const upstreamSiteId = siteId(item); const domain = siteDomain(item); const origin = extractOrigin(item);
      const domains = domainList(domain);
      if (!upstreamSiteId || !domains.length || !origin) { skipped += 1; continue; }
      const snapshot = sanitizeSnapshot(item);
      const existing = await transaction.prepare('SELECT id,owner_id FROM recovery_sites WHERE campaign_key=? AND upstream_account_id=? AND upstream_site_id=? FOR UPDATE')
        .get(campaignKey, account.id, upstreamSiteId);
      let recoveryId;
      if (existing) {
        if (existing.owner_id) { imported += 1; continue; }
        await transaction.prepare(`UPDATE recovery_sites SET upstream_package_id=?,domain=?,origin=?,backend_protocol=?,backend_host=?,websocket=?,gzip=?,enabled=?,cname=?,snapshot=?,updated_at=CURRENT_TIMESTAMP
          WHERE id=?`).run(packageId, domain, origin, backendProtocol(item), text(item.backend_host ?? item.backendHost, 512) || null,
          Number(Boolean(item.websocket_enable ?? item.websocket)), Number(Boolean(item.gzip_enable ?? item.gzip)), Number(enabledValue(item.enable ?? item.enabled)),
          text(item.cname, 512) || null, JSON.stringify(snapshot), existing.id);
        recoveryId = Number(existing.id);
        await transaction.prepare('DELETE FROM recovery_site_domains WHERE recovery_site_id=?').run(recoveryId);
      } else {
        recoveryId = Number((await transaction.prepare(`INSERT INTO recovery_sites
          (campaign_key,upstream_account_id,upstream_package_id,upstream_site_id,domain,origin,backend_protocol,backend_host,websocket,gzip,enabled,cname,snapshot)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(campaignKey, account.id, packageId, upstreamSiteId, domain, origin, backendProtocol(item),
          text(item.backend_host ?? item.backendHost, 512) || null, Number(Boolean(item.websocket_enable ?? item.websocket)), Number(Boolean(item.gzip_enable ?? item.gzip)),
          Number(enabledValue(item.enable ?? item.enabled)), text(item.cname, 512) || null, JSON.stringify(snapshot))).lastInsertRowid);
      }
      const insertDomain = transaction.prepare('INSERT INTO recovery_site_domains (campaign_key,recovery_site_id,domain,normalized_domain) VALUES (?,?,?,?) ON CONFLICT(campaign_key,normalized_domain) DO NOTHING');
      for (const value of domains) await insertDomain.run(campaignKey, recoveryId, value, value);
      imported += 1;
    }
  });
  return { campaignKey, upstreamId: Number(account.id), upstreamPackageId: packageId, seen: items.length, imported, skipped };
}

async function usageForSubscription(db, userId, subscriptionId) {
  const sites = await db.prepare('SELECT domain FROM sites WHERE owner_id=? AND subscription_id=?').all(userId, subscriptionId);
  const domains = sites.reduce((sum, row) => sum + billingInternals.domainCount(row.domain), 0);
  const sitePorts = await db.prepare('SELECT COUNT(*) AS count FROM site_custom_ports p JOIN sites s ON s.id=p.site_id WHERE s.owner_id=? AND s.subscription_id=?').get(userId, subscriptionId);
  const streamPorts = await db.prepare(`SELECT COUNT(*) AS count FROM stream_ports p JOIN tenant_resources r ON r.id=p.resource_id
    WHERE r.owner_id=? AND r.subscription_id=? AND r.kind='streams'`).get(userId, subscriptionId);
  return { domains, ports: Number(sitePorts.count) + Number(streamPorts.count) };
}

async function ensureSubscription(transaction, { userId, site, campaignKey }) {
  let grant = await transaction.prepare(`SELECT g.*,s.status,s.ends_at FROM recovery_activation_grants g
    JOIN subscriptions s ON s.id=g.subscription_id WHERE g.campaign_key=? AND g.user_id=? FOR UPDATE`).get(campaignKey, userId);
  const now = new Date();
  if (grant) {
    if (!['active', 'suspended'].includes(grant.status) || new Date(grant.ends_at) <= now) throw httpError('恢复套餐已到期，不能再次激活', 409);
    const current = await transaction.prepare('SELECT upstream_id,upstream_package_id FROM subscriptions WHERE id=?').get(grant.subscription_id);
    if (String(current?.upstream_id ?? '') !== String(site.upstream_account_id ?? '')
      || String(current?.upstream_package_id ?? '') !== String(site.upstream_package_id ?? '')) throw httpError('该域名属于其他上游，不能挂到当前恢复套餐', 409);
    return { subscriptionId: Number(grant.subscription_id), planId: Number(grant.plan_id), created: false };
  }
  const plan = await transaction.prepare('SELECT * FROM plans WHERE code=? FOR UPDATE').get(RECOVERY_PLAN_CODE);
  if (!plan || plan.activation_mode !== 'recovery' || Number(plan.enabled) !== 0) throw httpError('恢复套餐配置无效', 503);
  if (plan.upstream_id && String(plan.upstream_id) !== String(site.upstream_account_id)) throw httpError('恢复套餐上游不匹配', 409);
  if (plan.upstream_package_id && String(plan.upstream_package_id) !== String(site.upstream_package_id)) throw httpError('恢复套餐上游套餐不匹配', 409);
  const first = await billingInternals.checkPlanAcquisition(transaction, userId, plan.id);
  if (!first) throw httpError('该账号已经使用过恢复套餐', 409);
  const ends = billingInternals.addDays(now, Number(plan.duration_days));
  const subscriptionId = Number((await transaction.prepare(`INSERT INTO subscriptions
    (user_id,plan_id,status,starts_at,ends_at,auto_renew,upstream_id,upstream_package_id)
    VALUES (?,?, 'active', ?, ?, 0, ?, ?)`)
    .run(userId, plan.id, now.toISOString(), ends.toISOString(), site.upstream_account_id, site.upstream_package_id)).lastInsertRowid);
  await transaction.prepare(`INSERT INTO recovery_activation_grants (campaign_key,user_id,plan_id,subscription_id) VALUES (?,?,?,?)`)
    .run(campaignKey, userId, plan.id, subscriptionId);
  await billingInternals.recordPlanAcquisition(transaction, userId, plan.id);
  grant = { subscription_id: subscriptionId, plan_id: plan.id };
  return { subscriptionId, planId: Number(plan.id), created: true };
}

async function activateClaim({ db, billing, userId, claimId, campaignKey, expectedHash, verifiedDomains }) {
  let result;
  await db.transaction(async transaction => {
    const claim = await transaction.prepare(`SELECT c.* FROM recovery_claims c
      WHERE c.id=? AND c.user_id=? AND c.campaign_key=? FOR UPDATE`).get(claimId, userId, campaignKey);
    if (!claim) throw httpError('认领挑战不存在或已失效', 404);
    if (claim.verified_at || new Date(claim.expires_at) <= new Date() || claim.challenge_hash !== expectedHash) {
      throw httpError('认领挑战已过期或更新，请重新验证', 409);
    }
    const site = await transaction.prepare('SELECT * FROM recovery_sites WHERE id=? FOR UPDATE').get(claim.recovery_site_id);
    if (!site || site.status === 'revoked') throw httpError('恢复站点不可用', 404);
    if (JSON.stringify(domainList(site.domain).sort()) !== JSON.stringify(verifiedDomains)) throw httpError('站点域名已更新，请重新验证', 409);
    if (site.owner_id && Number(site.owner_id) !== Number(userId)) throw httpError('该站点已被其他账号认领', 409);
    await transaction.prepare('SELECT id FROM users WHERE id=? FOR UPDATE').get(userId);
    const subscription = await ensureSubscription(transaction, { userId, site, campaignKey });
    let local = await transaction.prepare('SELECT * FROM sites WHERE upstream_account_id=? AND upstream_id=? FOR UPDATE').get(site.upstream_account_id, site.upstream_site_id);
    if (local && Number(local.owner_id) !== Number(userId)) throw httpError('该站点已绑定其他账号', 409);
    if (!local) {
      const usage = await usageForSubscription(transaction, userId, subscription.subscriptionId);
      const domainAdd = billingInternals.domainCount(site.domain);
      const ports = sitePortList(JSON.parse(site.snapshot || '{}'));
      const plan = await transaction.prepare('SELECT domain_limit,port_limit FROM plans WHERE id=?').get(subscription.planId);
      if (plan.domain_limit !== null && usage.domains + domainAdd > Number(plan.domain_limit)) throw httpError('恢复套餐域名额度不足，最多认领 15 个域名', 409);
      if (plan.port_limit !== null && usage.ports + ports.length > Number(plan.port_limit)) throw httpError('恢复套餐端口额度不足，最多使用 15 个端口', 409);
      const localId = Number((await transaction.prepare(`INSERT INTO sites
        (owner_id,subscription_id,upstream_account_id,upstream_id,domain,origin,backend_protocol,backend_host,websocket,gzip,enabled,state,cname)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(userId, subscription.subscriptionId, site.upstream_account_id, site.upstream_site_id, site.domain, site.origin,
        site.backend_protocol, site.backend_host, site.websocket, site.gzip, site.enabled, site.enabled ? 'active' : 'inactive', site.cname)).lastInsertRowid);
      const insertPort = transaction.prepare('INSERT INTO site_custom_ports (site_id,port) VALUES (?,?) ON CONFLICT(site_id,port) DO NOTHING');
      for (const port of ports) await insertPort.run(localId, port);
      local = await transaction.prepare('SELECT * FROM sites WHERE id=?').get(localId);
    }
    await transaction.prepare(`UPDATE recovery_sites SET status='claimed',owner_id=?,subscription_id=?,claimed_at=COALESCE(claimed_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(userId, subscription.subscriptionId, site.id);
    await transaction.prepare('UPDATE recovery_claims SET verified_at=CURRENT_TIMESTAMP WHERE id=?').run(claimId);
    result = { siteId: Number(local.id), subscriptionId: subscription.subscriptionId, activated: subscription.created, domain: site.domain };
  });
  await billing.updateLegacySiteLimit(userId);
  return result;
}

async function resolveTxtDefault(name) {
  return dns.resolveTxt(name);
}

export async function handleRecoveryApi({ req, url, user, db, billing, upstreams, readBody, dnsResolveTxt = resolveTxtDefault }) {
  if (url.pathname.startsWith('/api/admin/recovery/')) {
    if (user.role !== 'admin') throw httpError('无管理员权限', 403);
    if (url.pathname === '/api/admin/recovery/sites/import' && req.method === 'POST') {
      const body = await readBody(req);
      return { status: 200, data: await importRecoverySites({ db, upstreams, upstreamId: Number(body.upstreamId), upstreamPackageId: body.upstreamPackageId, campaignKey: body.campaignKey || RECOVERY_CAMPAIGN }), action: 'recovery.sites.import' };
    }
    if (url.pathname === '/api/admin/recovery/sites' && req.method === 'GET') {
      const campaignKey = url.searchParams.get('campaign') || RECOVERY_CAMPAIGN;
      const rows = await db.prepare(`SELECT rs.*,u.username FROM recovery_sites rs LEFT JOIN users u ON u.id=rs.owner_id
        WHERE rs.campaign_key=? ORDER BY rs.id DESC`).all(campaignKey);
      return { status: 200, data: { sites: rows.map(row => ({ ...publicRecoverySite(row), upstreamId: Number(row.upstream_account_id), upstreamSiteId: row.upstream_site_id, username: row.username || null })) } };
    }
    return null;
  }
  if (!url.pathname.startsWith('/api/recovery/')) return null;
  if (!billing) throw httpError('计费服务未启用', 503);
  if (user.role !== 'user') throw httpError('管理员账号不能使用客户认领流程', 403);
  const campaignKey = url.searchParams.get('campaign') || RECOVERY_CAMPAIGN;
  if (url.pathname === '/api/recovery/status' && req.method === 'GET') {
    const grant = await db.prepare(`SELECT g.*,s.status,s.starts_at,s.ends_at,p.name AS plan_name FROM recovery_activation_grants g
      JOIN subscriptions s ON s.id=g.subscription_id JOIN plans p ON p.id=g.plan_id WHERE g.campaign_key=? AND g.user_id=?`).get(campaignKey, user.id);
    const sites = await db.prepare(`SELECT COUNT(rsd.id) AS count FROM recovery_site_domains rsd JOIN recovery_sites rs ON rs.id=rsd.recovery_site_id
      WHERE rs.campaign_key=? AND rs.owner_id=?`).get(campaignKey, user.id);
    return { status: 200, data: { activated: Boolean(grant), activation: grant ? { subscriptionId: Number(grant.subscription_id), planName: grant.plan_name, status: grant.status, startsAt: grant.starts_at, endsAt: grant.ends_at } : null, claimedDomains: Number(sites.count) } };
  }
  if (url.pathname === '/api/recovery/sites' && req.method === 'GET') {
    const domain = normalizeDomain(url.searchParams.get('domain'));
    const row = await db.prepare(`SELECT rs.id,rs.domain,rs.status,rs.owner_id,rs.claimed_at FROM recovery_site_domains rsd
      JOIN recovery_sites rs ON rs.id=rsd.recovery_site_id WHERE rsd.campaign_key=? AND rsd.normalized_domain=?`).get(campaignKey, domain);
    if (!row || row.status === 'revoked') throw httpError('未找到可恢复的站点', 404);
    if (row.owner_id && Number(row.owner_id) !== Number(user.id)) throw httpError('该站点已被其他账号认领', 409);
    return { status: 200, data: { site: publicRecoverySite({ ...row, domain }) } };
  }
  if (url.pathname === '/api/recovery/claims' && req.method === 'POST') {
    const body = await readBody(req); const domain = normalizeDomain(body.domain);
    const site = await db.prepare(`SELECT rs.*,rsd.domain AS matched_domain FROM recovery_site_domains rsd JOIN recovery_sites rs ON rs.id=rsd.recovery_site_id
      WHERE rsd.campaign_key=? AND rsd.normalized_domain=?`).get(campaignKey, domain);
    if (!site || site.status === 'revoked') throw httpError('未找到可恢复的站点', 404);
    if (site.owner_id && Number(site.owner_id) !== Number(user.id)) throw httpError('该站点已被其他账号认领', 409);
    if (site.owner_id && Number(site.owner_id) === Number(user.id) && site.status === 'claimed') {
      const local = await db.prepare('SELECT id,subscription_id FROM sites WHERE upstream_account_id=? AND upstream_id=?').get(site.upstream_account_id, site.upstream_site_id);
      return { status: 200, data: { claimed: true, siteId: local ? Number(local.id) : null, subscriptionId: local ? Number(local.subscription_id) : null, domain: site.matched_domain } };
    }
    const grant = await db.prepare(`SELECT g.*,s.status,s.ends_at FROM recovery_activation_grants g JOIN subscriptions s ON s.id=g.subscription_id
      WHERE g.campaign_key=? AND g.user_id=?`).get(campaignKey, user.id);
    if (grant && (!['active', 'suspended'].includes(grant.status) || new Date(grant.ends_at) <= new Date())) throw httpError('恢复套餐已到期，不能再次激活', 409);
    const raw = `arenode-${crypto.randomBytes(24).toString('base64url')}`;
    const recordName = claimRecordName(domain);
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
    let row;
    await db.transaction(async transaction => {
      const locked = await transaction.prepare('SELECT * FROM recovery_sites WHERE id=? FOR UPDATE').get(site.id);
      if (locked.owner_id && Number(locked.owner_id) !== Number(user.id)) throw httpError('该站点已被其他账号认领', 409);
      const existing = await transaction.prepare('SELECT id FROM recovery_claims WHERE recovery_site_id=? AND user_id=? AND verified_at IS NULL').get(site.id, user.id);
      if (existing) await transaction.prepare('UPDATE recovery_claims SET challenge_hash=?,record_name=?,expires_at=?,created_at=CURRENT_TIMESTAMP WHERE id=?').run(challengeHash(raw), recordName, expiresAt, existing.id);
      else await transaction.prepare(`INSERT INTO recovery_claims (campaign_key,recovery_site_id,user_id,challenge_hash,record_name,expires_at) VALUES (?,?,?,?,?,?)`)
        .run(campaignKey, site.id, user.id, challengeHash(raw), recordName, expiresAt);
      row = await transaction.prepare(`SELECT c.*,rs.domain,rsd.domain AS matched_domain FROM recovery_claims c JOIN recovery_sites rs ON rs.id=c.recovery_site_id
        LEFT JOIN recovery_site_domains rsd ON rsd.recovery_site_id=rs.id AND rsd.normalized_domain=? WHERE c.recovery_site_id=? AND c.user_id=? AND c.verified_at IS NULL`).get(domain, site.id, user.id);
    });
    return { status: 201, data: { claim: publicClaim(row, raw), instructions: '请添加该 TXT 记录后调用验证接口。' } };
  }
  const verify = url.pathname.match(/^\/api\/recovery\/claims\/(\d+)\/verify$/);
  if (verify && req.method === 'POST') {
    const claim = await db.prepare(`SELECT c.*,rs.domain,rs.status,rs.owner_id,rs.upstream_account_id,rs.upstream_package_id,rs.snapshot
      FROM recovery_claims c JOIN recovery_sites rs ON rs.id=c.recovery_site_id WHERE c.id=? AND c.user_id=? AND c.campaign_key=?`).get(Number(verify[1]), user.id, campaignKey);
    if (!claim || claim.verified_at || new Date(claim.expires_at) <= new Date()) throw httpError('认领挑战不存在或已过期', 409);
    let records;
    try { records = await dnsResolveTxt(claim.record_name); } catch (error) { throw httpError(`TXT 记录暂不可见，请稍后重试：${error.code || error.message}`, 409); }
    const values = (Array.isArray(records) ? records : [records]).flatMap(item => Array.isArray(item) ? [item.join('')] : [String(item)]).map(item => item.trim());
    if (!values.some(value => sameHash(challengeHash(value), claim.challenge_hash))) throw httpError('TXT 验证值不匹配', 409);
    // An upstream site can contain unrelated domains. Proving one name must
    // not transfer the other names; disclose aliases only after the first proof.
    const verifiedDomains = domainList(claim.domain).sort();
    const additionalRecordNames = [];
    for (const name of new Set(verifiedDomains.map(claimRecordName))) {
      if (name === claim.record_name) continue;
      try {
        const records = await dnsResolveTxt(name);
        const matches = records.some(parts => sameHash(challengeHash(Array.isArray(parts) ? parts.join('').trim() : String(parts).trim()), claim.challenge_hash));
        if (!matches) additionalRecordNames.push(name);
      } catch { additionalRecordNames.push(name); }
    }
    if (additionalRecordNames.length) return { status: 409, data: {
      error: '该站点包含多个域名，请为下列记录名添加相同 TXT 内容后再次验证', additionalRecordNames,
    } };
    const result = await activateClaim({ db, billing, userId: user.id, claimId: Number(claim.id), campaignKey, expectedHash: claim.challenge_hash, verifiedDomains });
    return { status: 200, data: result, action: 'recovery.claim.verify', resourceId: result.siteId };
  }
  return null;
}

export const recoveryInternals = {
  normalizeDomain, domainList, collectionItems, fetchAllRecoverySites, extractOrigin, sitePortList, sanitizeSnapshot, challengeHash,
};
