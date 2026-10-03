import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ZodPipe } from './zod.pipe.js';

const pipe = new ZodPipe(z.object({ page: z.coerce.number().int().min(1).default(1) }));

describe('ZodPipe', () => {
  it('returns the parsed (coerced, defaulted) data for valid input', () => {
    expect(pipe.transform({ page: '3' })).toEqual({ page: 3 });
    expect(pipe.transform({})).toEqual({ page: 1 });
  });

  it('throws BadRequestException carrying the zod issues for invalid input', () => {
    let thrown: unknown;
    try {
      pipe.transform({ page: 0 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    const body = (thrown as BadRequestException).getResponse() as {
      message: string;
      issues: { path: unknown[] }[];
    };
    expect(body.message).toBe('Validation failed');
    expect(body.issues).toHaveLength(1);
    expect(body.issues[0]?.path).toEqual(['page']);
  });
});
