import { describe, expect, it } from 'vitest';
import { clientIpKey } from './client-ip.js';

describe('clientIpKey', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['2001:db8:abcd:12:1:2:3:4', '2001:db8:abcd:12::/64'],
    ['2001:db8:abcd:12::99', '2001:db8:abcd:12::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    [undefined, 'unknown'],
    ['not-an-ip', 'unknown'],
  ])('%s → %s', (ip, key) => {
    expect(clientIpKey(ip)).toBe(key);
  });

  it('puts two addresses from the same /64 in one bucket and different /64s apart', () => {
    expect(clientIpKey('2001:db8:1:2::a')).toBe(clientIpKey('2001:db8:1:2:ffff::b'));
    expect(clientIpKey('2001:db8:1:2::a')).not.toBe(clientIpKey('2001:db8:1:3::a'));
  });

  it('is case- and zero-padding-insensitive', () => {
    expect(clientIpKey('2001:DB8:0001:0002:0:0:0:1')).toBe('2001:db8:1:2::/64');
    expect(clientIpKey('2001:0db8:0001:0002::1')).toBe(clientIpKey('2001:db8:1:2::ff'));
  });

  it('ignores an IPv6 zone suffix', () => {
    expect(clientIpKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  it('expands :: at the start and the end of the address', () => {
    expect(clientIpKey('::')).toBe('0:0:0:0::/64');
    expect(clientIpKey('2001:db8:1:2:3:4:5::')).toBe('2001:db8:1:2::/64');
    expect(clientIpKey('::1:2:3:4:5:6:7')).toBe('0:1:2:3::/64');
  });

  it('treats the ::ffff: prefix as IPv4 whatever its case', () => {
    expect(clientIpKey('::FFFF:10.0.0.9')).toBe('10.0.0.9');
  });

  it('never returns an IPv6 range for an IPv4-embedded address that is not IPv4-mapped', () => {
    expect(clientIpKey('64:ff9b::192.0.2.1')).toBe('64:ff9b:0:0::/64');
  });

  it('unmaps the hex spelling of an IPv4-mapped address too', () => {
    expect(clientIpKey('::ffff:cb00:7107')).toBe('203.0.113.7');
    expect(clientIpKey('0:0:0:0:0:ffff:0a00:0009')).toBe('10.0.0.9');
  });

  it('counts an IPv4 tail as two hextets when expanding ::', () => {
    expect(clientIpKey('a::b:c:d:1.2.3.4')).toBe('a:0:0:b::/64');
  });

  it('returns unknown for empty and malformed input', () => {
    expect(clientIpKey('')).toBe('unknown');
    expect(clientIpKey('999.1.1.1')).toBe('unknown');
    expect(clientIpKey('::ffff:999.1.1.1')).toBe('unknown');
    expect(clientIpKey('1:2:3:4:5:6:7:8:9')).toBe('unknown');
    expect(clientIpKey('2001:db8::/64')).toBe('unknown');
  });
});
