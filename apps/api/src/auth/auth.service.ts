import { randomBytes } from 'node:crypto';
import { and, eq, USER_ROLES, users, type DbHandle, type UserRole } from '@clausecite/core';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import argon2 from 'argon2';
import { API_ENV, DATABASE, type ApiConfig } from '../infra/tokens.js';
import type { AuthUser } from './auth.types.js';

const GUEST_TTL_S = 24 * 60 * 60;
const ADMIN_TTL_S = 12 * 60 * 60;

const MIN_ADMIN_PASSWORD_LENGTH = 12;
const PLACEHOLDER_ADMIN_PASSWORD = 'change-me';

const normalizeEmail = (email: string) => email.trim().toLowerCase();
const isUserRole = (value: unknown): value is UserRole =>
  (USER_ROLES as readonly unknown[]).includes(value);

export interface IssuedToken {
  token: string;
  user: AuthUser;
  expiresAt: string;
}

@Injectable()
export class AuthService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AuthService.name);
  private dummyHash?: Promise<string>;

  constructor(
    @Inject(DATABASE) private readonly database: DbHandle,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(API_ENV) private readonly env: ApiConfig,
  ) {}

  async onApplicationBootstrap() {
    const { ADMIN_EMAIL: email, ADMIN_PASSWORD: password } = this.env;
    if (!email && !password) {
      this.logger.log('ADMIN_EMAIL / ADMIN_PASSWORD not set: admin seeding skipped');
      return;
    }
    // Never crash boot over seeding, and never put the password in a log line.
    if (!email || !password) {
      this.logger.warn(
        'Admin seeding skipped: ADMIN_EMAIL and ADMIN_PASSWORD must be set together',
      );
      return;
    }
    if (password === PLACEHOLDER_ADMIN_PASSWORD || password.length < MIN_ADMIN_PASSWORD_LENGTH) {
      this.logger.warn(
        `Admin seeding skipped: ADMIN_PASSWORD must not be the "${PLACEHOLDER_ADMIN_PASSWORD}" placeholder and must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters`,
      );
      return;
    }
    const created = await this.ensureAdmin(email, password);
    this.logger.log(created ? 'Admin user created' : 'Admin user already exists: nothing to do');
  }

  /** Creates the admin if its (lowercased) email is not taken yet. Resolves to whether a row was inserted. */
  async ensureAdmin(email: string, password: string): Promise<boolean> {
    const inserted = await this.database.db
      .insert(users)
      .values({
        email: normalizeEmail(email),
        passwordHash: await argon2.hash(password),
        role: 'admin',
      })
      .onConflictDoNothing({ target: users.email })
      .returning({ id: users.id });
    return inserted.length > 0;
  }

  async issueGuest(): Promise<IssuedToken> {
    const [user] = await this.database.db.insert(users).values({ role: 'guest' }).returning();
    return this.sign({ id: user.id, role: user.role }, GUEST_TTL_S);
  }

  async login(email: string, password: string): Promise<IssuedToken> {
    const [user] = await this.database.db
      .select()
      .from(users)
      .where(and(eq(users.email, normalizeEmail(email)), eq(users.role, 'admin')))
      .limit(1);
    // Always run one argon2.verify (against a dummy hash when there is no usable row), so an
    // unknown email and a wrong password cost the same and cannot be told apart by timing.
    const hash = user?.passwordHash ?? (await this.getDummyHash());
    const valid = await argon2.verify(hash, password);
    if (!user?.passwordHash || !valid) throw new UnauthorizedException('Invalid credentials');
    return this.sign({ id: user.id, role: user.role }, ADMIN_TTL_S);
  }

  async verify(token: string): Promise<AuthUser> {
    // jsonwebtoken may hand back a string or null for odd payloads, hence the defensive shape below.
    let claims: Record<string, unknown> | null | undefined;
    try {
      claims = await this.jwt.verifyAsync<Record<string, unknown>>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    // A valid signature only proves we issued *some* token: still check it has the shape we issue.
    if (typeof claims?.sub !== 'string' || claims.sub === '' || !isUserRole(claims.role)) {
      throw new UnauthorizedException('Invalid token claims');
    }
    return { id: claims.sub, role: claims.role };
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= argon2.hash(randomBytes(16).toString('hex'));
    return this.dummyHash;
  }

  private async sign(user: AuthUser, ttlSeconds: number): Promise<IssuedToken> {
    const token = await this.jwt.signAsync(
      { sub: user.id, role: user.role },
      { expiresIn: ttlSeconds },
    );
    return { token, user, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() };
  }
}
