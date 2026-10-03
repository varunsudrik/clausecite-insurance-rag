import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module.js';
import { ClausesController } from './clauses.controller.js';
import { RetrievalService } from './retrieval.service.js';
import { SearchController } from './search.controller.js';

@Module({
  imports: [DocumentsModule],
  controllers: [SearchController, ClausesController],
  providers: [RetrievalService],
  exports: [RetrievalService],
})
export class SearchModule {}
