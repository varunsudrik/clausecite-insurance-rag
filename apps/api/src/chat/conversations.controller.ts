import { Controller, Get, Inject, Param, ParseUUIDPipe } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../auth/auth.types.js';
import { ChatService } from './chat.service.js';

@Controller('conversations')
export class ConversationsController {
  constructor(@Inject(ChatService) private readonly chat: ChatService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.chat.listConversations(user);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.chat.getConversation(user, id);
  }
}
