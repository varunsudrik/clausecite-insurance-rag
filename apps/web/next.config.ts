import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  reactStrictMode: true,
  poweredByHeader: false,
  // `next dev` would otherwise write AGENTS.md / CLAUDE.md into apps/web when it detects an AI agent.
  agentRules: false,
};
export default config;
