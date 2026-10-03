import { createReadStream } from 'node:fs';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';
import { Roles } from '../auth/auth.types.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { DocumentsService, toPublicDocument } from './documents.service.js';

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const uploadBody = z.object({
  slug: z.string().regex(/^[a-z0-9-]{3,80}$/),
  title: z.string().min(1).max(200),
  insurer: z.string().min(1).max(200),
  product: z.string().min(1).max(200),
  policy_type: z.string().min(1).max(50).default('health'),
});

@Controller('documents')
export class DocumentsController {
  constructor(@Inject(DocumentsService) private readonly docs: DocumentsService) {}

  @Get()
  async list() {
    return (await this.docs.list()).map(toPublicDocument);
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return toPublicDocument(await this.docs.resolve(id));
  }

  @Get(':id/file')
  async file(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const doc = await this.docs.resolve(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${doc.slug}.pdf"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return new StreamableFile(createReadStream(this.docs.filePath(doc)));
  }

  @Roles('admin')
  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  async upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body(new ZodPipe(uploadBody)) body: z.infer<typeof uploadBody>,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!file) throw new BadRequestException('multipart field "file" is required');
    const { doc, deduplicated } = await this.docs.upload(file.buffer, body);
    res.status(deduplicated ? 200 : 201);
    return { ...toPublicDocument(doc), deduplicated };
  }

  @Roles('admin')
  @Post(':id/reingest')
  @HttpCode(202)
  async reingest(@Param('id') id: string) {
    return toPublicDocument(await this.docs.reingest(id));
  }
}
