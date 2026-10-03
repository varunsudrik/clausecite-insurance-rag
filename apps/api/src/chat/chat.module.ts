import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module.js';
import { SearchModule } from '../search/search.module.js';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';
import { ConversationsController } from './conversations.controller.js';

@Module({
  imports: [DocumentsModule, SearchModule],
  controllers: [ChatController, ConversationsController],
  providers: [ChatService],
})
export class ChatModule {}
