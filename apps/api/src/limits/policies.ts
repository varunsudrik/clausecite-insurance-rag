import { SetMetadata } from '@nestjs/common';

export type RatePolicyName = 'chat' | 'search' | 'guestToken' | 'login';

export interface Window {
  limit: number;
  windowSeconds: number;
}

export const RATE_POLICIES = {
  chat: {
    guestUser: { limit: 10, windowSeconds: 60 },
    ip: { limit: 30, windowSeconds: 60 },
    adminUser: { limit: 60, windowSeconds: 60 },
  },
  search: {
    guestUser: { limit: 10, windowSeconds: 60 },
    ip: { limit: 30, windowSeconds: 60 },
    adminUser: { limit: 60, windowSeconds: 60 },
  },
  guestToken: { ip: { limit: 5, windowSeconds: 3600 } },
  login: { ip: { limit: 10, windowSeconds: 900 } },
} as const;

export const RATE_POLICY_KEY = 'clausecite:ratePolicy';
export const RateLimit = (policy: RatePolicyName) => SetMetadata(RATE_POLICY_KEY, policy);
