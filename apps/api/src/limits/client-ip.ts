import { isIPv4, isIPv6 } from 'node:net';

/** The 8 hextets of a syntactically valid IPv6 address (`::` expanded, an embedded IPv4 tail converted). */
function hextets(address: string): number[] {
  let text = address;
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number) as [number, number, number, number];
    text = `${address.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', rest = ''] = text.split('::');
  const before = head ? head.split(':') : [];
  const after = rest ? rest.split(':') : [];
  const fill = text.includes('::')
    ? Array.from({ length: 8 - before.length - after.length }, () => '0')
    : [];
  return [...before, ...fill, ...after].map((part) => parseInt(part, 16));
}

/**
 * Rate-limit bucket key: IPv4 as-is, IPv4-mapped IPv6 as the IPv4 address, any other IPv6 address by
 * its /64 (one subscriber typically owns a whole /64, so per-address keys are free to rotate).
 */
export function clientIpKey(ip: string | undefined): string {
  if (!ip) return 'unknown';
  if (isIPv4(ip)) return ip;
  const address = ip.split('%')[0] as string; // drop a zone suffix such as fe80::1%eth0
  if (!isIPv6(address)) return 'unknown';
  const h = hextets(address) as [number, number, number, number, number, number, number, number];
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) {
    return `${h[6] >> 8}.${h[6] & 0xff}.${h[7] >> 8}.${h[7] & 0xff}`;
  }
  return `${h
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(':')}::/64`;
}
