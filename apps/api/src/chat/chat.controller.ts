import { Body, Controller, Inject, Post, Res, UseGuards } from '@nestjs/common';
import { pipeUIMessageStreamToResponse } from 'ai';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../auth/auth.types.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { RateLimit } from '../limits/policies.js';
import { RateLimitGuard } from '../limits/rate-limit.guard.js';
import { ChatService } from './chat.service.js';

const chatBody = z.object({
  conversationId: z.uuid().optional(),
  message: z.string().trim().min(1).max(2000),
  documentIds: z.array(z.string().min(1)).max(20).optional(),
  mode: z
    .literal('quick', { message: 'only "quick" mode is available (deep mode arrives in Phase 2)' })
    .default('quick'),
});

@Controller('chat')
export class ChatController {
  constructor(@Inject(ChatService) private readonly chat: ChatService) {}

  @Post()
  @UseGuards(RateLimitGuard)
  @RateLimit('chat')
  async post(
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(chatBody)) body: z.infer<typeof chatBody>,
    @Res() res: Response,
  ) {
    const prepared = await this.chat.prepare(user, body);
    await pipeUIMessageStreamToResponse({
      response: res,
      stream: this.chat.stream(user, prepared),
    });
  }
}
