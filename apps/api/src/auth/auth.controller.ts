import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { Public } from '../common/public.decorator.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { AuthService } from './auth.service.js';
import { CurrentUser, type AuthUser } from './auth.types.js';

const loginBody = z.object({ email: z.email(), password: z.string().min(1).max(200) });

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Public()
  @Post('guest')
  guest() {
    return this.auth.issueGuest();
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body(new ZodPipe(loginBody)) body: z.infer<typeof loginBody>) {
    return this.auth.login(body.email, body.password);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }
}
