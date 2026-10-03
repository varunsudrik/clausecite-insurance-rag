import { generateText, type LanguageModel } from 'ai';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

const REWRITE_SYSTEM =
  "Rewrite the user's latest message as a standalone question about insurance policy wording. " +
  'Resolve pronouns and references using the conversation. Keep policy names, ages, durations and amounts. ' +
  'Output only the rewritten question.';

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
      prompt: `Conversation:\n${transcript}\n\nLatest user message: ${latest}\n\nStandalone question:`,
      maxOutputTokens: 200,
      temperature: 0,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(5000),
    });
    const question = res.text
      .trim()
      .replace(/^["']+|["']+$/g, '')
      .slice(0, 500);
    if (!question) return fallback;
    return {
      question,
      rewritten: true,
      inputTokens: res.usage.inputTokens ?? 0,
      outputTokens: res.usage.outputTokens ?? 0,
    };
  } catch {
    return fallback;
  }
}
