import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Logger,
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
import { CurrentUser, Roles, type AuthUser } from '../auth/auth.types.js';
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
  private readonly logger = new Logger(DocumentsController.name);

  constructor(@Inject(DocumentsService) private readonly docs: DocumentsService) {}

  @Get()
  async list(@CurrentUser() user: AuthUser | undefined) {
    return (await this.docs.list()).map((row) => toPublicDocument(row, user?.role));
  }

  @Get(':id')
  async get(@Param('id') id: string, @CurrentUser() user: AuthUser | undefined) {
    return toPublicDocument(await this.docs.resolve(id), user?.role);
  }

  @Get(':id/file')
  async file(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const doc = await this.docs.resolve(id);
    // Throws 404 for a missing file before any header is set.
    const { stream, size } = await this.docs.openFile(doc);
    const safeName = doc.slug.replace(/[^a-z0-9-]/g, '') || 'policy';
    res.setHeader('Cache-Control', 'private, max-age=3600');
    // A client that disconnects mid-download must not leave the file descriptor open.
    res.once('close', () => stream.destroy());
    return new StreamableFile(stream, {
      type: 'application/pdf',
      disposition: `inline; filename="${safeName}.pdf"`,
      length: size,
    }).setErrorHandler((err) => {
      // Nest's default handler would answer 400 with err.message (which contains the storage path).
      this.logger.error(`failed to stream document ${doc.id}: ${err.message}`);
      if (res.destroyed) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      for (const header of [
        'Content-Type',
        'Content-Disposition',
        'Content-Length',
        'Cache-Control',
      ]) {
        res.removeHeader(header);
      }
      res.status(500).json({ statusCode: 500, message: 'Internal server error' });
    });
  }

  @Roles('admin')
  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  async upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body(new ZodPipe(uploadBody)) body: z.infer<typeof uploadBody>,
    @CurrentUser() user: AuthUser | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!file) throw new BadRequestException('multipart field "file" is required');
    if (file.mimetype !== 'application/pdf') {
      throw new BadRequestException('file must be application/pdf');
    }
    const { doc, deduplicated } = await this.docs.upload(file.buffer, body);
    res.status(deduplicated ? 200 : 201);
    return { ...toPublicDocument(doc, user?.role), deduplicated };
  }

  @Roles('admin')
  @Post(':id/reingest')
  @HttpCode(202)
  async reingest(@Param('id') id: string, @CurrentUser() user: AuthUser | undefined) {
    return toPublicDocument(await this.docs.reingest(id), user?.role);
  }
}
