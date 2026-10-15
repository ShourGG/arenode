import { BlockList, isIP } from 'node:net';

function normalizeIp(value) {
  if (typeof value !== 'string') return null;
  const ip = value.trim();
  if (!isIP(ip)) return null;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return mapped ? mapped[1] : ip.toLowerCase();
}

// Walk from the TCP peer toward the visitor. Stop at the first untrusted hop;
// taking the leftmost header value would let visitors choose their own IP.
export function createClientIpResolver(trustedProxyCidrs = []) {
  const trusted = new BlockList();
  for (const entry of trustedProxyCidrs) {
    const parts = String(entry).trim().split('/');
    const ip = normalizeIp(parts[0]);
    const version = ip && isIP(ip);
    const family = version === 4 ? 'ipv4' : 'ipv6';
    if (!version || parts.length > 2) throw new Error('TRUSTED_PROXY_CIDRS 配置无效');
    if (parts.length === 1) trusted.addAddress(ip, family);
    else {
      const bits = Number(parts[1]);
      if (!/^\d+$/.test(parts[1]) || !Number.isInteger(bits) || bits < 0 || bits > (version === 4 ? 32 : 128)) {
        throw new Error('TRUSTED_PROXY_CIDRS 配置无效');
      }
      trusted.addSubnet(ip, bits, family);
    }
  }
  return req => {
    let ip = normalizeIp(req.socket?.remoteAddress);
    const forwarded = req.headers?.['x-forwarded-for'];
    if (!ip || typeof forwarded !== 'string') return ip;
    const hops = forwarded.split(',');
    for (let index = hops.length - 1; index >= 0; index -= 1) {
      if (!trusted.check(ip, isIP(ip) === 4 ? 'ipv4' : 'ipv6')) break;
      const previous = normalizeIp(hops[index]);
      if (!previous) break;
      ip = previous;
    }
    return ip;
  };
}
