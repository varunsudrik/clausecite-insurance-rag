import { getEncoding, type Tiktoken } from 'js-tiktoken';

let encoder: Tiktoken | undefined;

export function countTokens(text: string): number {
  encoder ??= getEncoding('cl100k_base');
  // Special-token literals (e.g. "<|endoftext|>") in extracted PDF text are counted as plain text, not rejected.
  return encoder.encode(text, [], []).length;
}
