import { generateText, type LanguageModel } from 'ai';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

const REWRITE_SYSTEM =
  "Rewrite the user's latest message as a standalone question about insurance policy wording. " +
  'Resolve pronouns and references using the conversation. Keep policy names, ages, durations and amounts. ' +
  'Output only the rewritten question.';

const LABEL_RE = /^standalone question\s*:\s*/i;
const QUOTE_PAIRS: Record<string, string> = { '"': '"', "'": "'", '“': '”' };

/** Removes a "Standalone question:" label and one surrounding quote pair, only when the pair matches. */
function cleanRewrite(raw: string): string {
  let q = raw.trim().replace(LABEL_RE, '').trim();
  if (q.length >= 2 && QUOTE_PAIRS[q[0]] === q[q.length - 1]) q = q.slice(1, -1).trim();
  return q.slice(0, 500);
}

export async function rewriteQuestion(
  model: LanguageModel,
  history: ChatTurn[],
  latest: string,
): Promise<{ question: string; rewritten: boolean; inputTokens: number; outputTokens: number }> {
  const fallback = { question: latest, rewritten: false, inputTokens: 0, outputTokens: 0 };
  if (history.length === 0) return fallback;
  const transcript = history
    .slice(-6)
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content.slice(0, 1000)}`)
    .join('\n');
  try {
    const res = await generateText({
      model,
      system: REWRITE_SYSTEM,
      prompt: `Conversation:\n${transcript}\n\nLatest user message: ${latest.slice(0, 2000)}\n\nStandalone question:`,
      maxOutputTokens: 200,
      temperature: 0,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(5000),
    });
    const inputTokens = res.usage.inputTokens ?? 0;
    const outputTokens = res.usage.outputTokens ?? 0;
    const question = cleanRewrite(res.text);
    // The model call happened and was billed, so report its usage even when the output is unusable.
    if (!question) return { ...fallback, inputTokens, outputTokens };
    return { question, rewritten: true, inputTokens, outputTokens };
  } catch {
    return fallback;
  }
}
