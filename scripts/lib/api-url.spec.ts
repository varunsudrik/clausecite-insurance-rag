import { describe, expect, it } from 'vitest';
import { apiUrlProblem } from './api-url.ts';

describe('apiUrlProblem', () => {
  it('accepts https for any host', () => {
    expect(apiUrlProblem('https://clausecite.example.com/api')).toBeUndefined();
    expect(apiUrlProblem('https://203.0.113.7:8443')).toBeUndefined();
    expect(apiUrlProblem('HTTPS://Clausecite.Example.com/api')).toBeUndefined();
  });

  it('accepts plain http for localhost, 127.0.0.1 and [::1], with or without a port or path', () => {
    for (const url of [
      'http://localhost',
      'http://localhost:3001',
      'http://LOCALHOST:3001/api',
      'http://127.0.0.1:3001',
      'http://[::1]:3001',
      'http://[::1]',
    ]) {
      expect(apiUrlProblem(url), url).toBeUndefined();
    }
  });

  it('refuses plain http to a remote host and names the host', () => {
    for (const [url, host] of [
      ['http://clausecite.example.com/api', 'clausecite.example.com'],
      ['http://203.0.113.7:3001', '203.0.113.7'],
      ['http://10.0.0.5', '10.0.0.5'],
      ['http://[2001:db8::1]:3001', '[2001:db8::1]'],
    ] as const) {
      const problem = apiUrlProblem(url);
      expect(problem, url).toMatch(/Refusing to send/);
      expect(problem, url).toContain(host);
    }
  });

  it('is not fooled by hosts that merely start with, or embed, a local name', () => {
    for (const url of [
      'http://localhost.evil.example',
      'http://127.0.0.1.evil.example',
      'http://localhost:3001@evil.example/api',
      'http://evil.example/localhost',
      'http://evil.example?h=127.0.0.1',
      'http://127.0.0.2:3001',
    ]) {
      expect(apiUrlProblem(url), url).toMatch(/Refusing to send/);
    }
  });

  it('refuses anything that is not http(s) or not a URL', () => {
    expect(apiUrlProblem('ftp://localhost/api')).toMatch(/http\(s\)/);
    expect(apiUrlProblem('localhost:3001')).toBeDefined();
    expect(apiUrlProblem('not a url')).toMatch(/not a valid URL/);
    expect(apiUrlProblem('')).toMatch(/not a valid URL/);
  });

  it('never echoes the URL, which may carry credentials in its userinfo', () => {
    const problem = apiUrlProblem('http://admin:hunter2@evil.example/api') ?? '';
    expect(problem).toMatch(/Refusing to send/);
    expect(problem).not.toContain('hunter2');
    expect(apiUrlProblem('://hunter2')).not.toContain('hunter2');
  });
});
