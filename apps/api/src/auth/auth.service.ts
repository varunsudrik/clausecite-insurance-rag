import { and, eq, users, type DbHandle, type UserRole } from '@clausecite/core';
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import argon2 from 'argon2';
import { API_ENV, DATABASE, type ApiConfig } from '../infra/tokens.js';
import type { AuthUser } from './auth.types.js';

const GUEST_TTL_S = 24 * 60 * 60;
const ADMIN_TTL_S = 12 * 60 * 60;

export interface IssuedToken {
  token: string;
  user: AuthUser;
  expiresAt: string;
}

@Injectable()
export class AuthService implements OnApplicationBootstrap {
  constructor(
    @Inject(DATABASE) private readonly database: DbHandle,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(API_ENV) private readonly env: ApiConfig,
  ) {}

  async onApplicationBootstrap() {
    if (this.env.ADMIN_EMAIL && this.env.ADMIN_PASSWORD) {
      await this.ensureAdmin(this.env.ADMIN_EMAIL, this.env.ADMIN_PASSWORD);
    }
  }

  async ensureAdmin(email: string, password: string): Promise<void> {
    await this.database.db
      .insert(users)
      .values({ email, passwordHash: await argon2.hash(password), role: 'admin' })
      .onConflictDoNothing({ target: users.email });
  }

  async issueGuest(): Promise<IssuedToken> {
    const [user] = await this.database.db.insert(users).values({ role: 'guest' }).returning();
    return this.sign({ id: user.id, role: user.role }, GUEST_TTL_S);
  }

  async login(email: string, password: string): Promise<IssuedToken> {
    const [user] = await this.database.db
      .select()
      .from(users)
      .where(and(eq(users.email, email), eq(users.role, 'admin')))
      .limit(1);
    const valid = user?.passwordHash ? await argon2.verify(user.passwordHash, password) : false;
    if (!user || !valid) throw new UnauthorizedException('Invalid credentials');
    return this.sign({ id: user.id, role: user.role }, ADMIN_TTL_S);
  }

  async verify(token: string): Promise<AuthUser> {
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; role: UserRole }>(token);
      return { id: payload.sub, role: payload.role };
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  private async sign(user: AuthUser, ttlSeconds: number): Promise<IssuedToken> {
    const token = await this.jwt.signAsync(
      { sub: user.id, role: user.role },
      { expiresIn: ttlSeconds },
    );
    return { token, user, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() };
  }
}
