// Encodes tag questions for each decision API and validates OpenAI's named predicate answers.
import { record } from './config.ts';
import type { ProviderName } from './provider.ts';

export interface TagQuestion {
  instructions: { question: string; tag: string; definition: string };
  criteria: { true: string; false: string };
}
export interface SystemOneRequest {
  model: string;
  state: unknown;
  questions: Record<string, TagQuestion & { type: 'noul' }>;
}
export interface OpenAiRequest {
  model: string;
  input: string;
  questions: { type: 'predicate'; name: string; instructions: string }[];
}
export type EvaluationRequest = SystemOneRequest | OpenAiRequest;

export function decisionRequest(provider: ProviderName, model: string, state: unknown, questions: TagQuestion[]): EvaluationRequest {
  if (provider === 'openai') return {
    model, input: JSON.stringify(state),
    questions: questions.map((question, index) => ({
      type: 'predicate', name: `tag_${index}`,
      instructions: `${question.instructions.question}\nTag: ${JSON.stringify(question.instructions.tag)}\nDefinition: ${question.instructions.definition}\nTrue: ${question.criteria.true}\nFalse: ${question.criteria.false}`,
    })),
  };
  return { model, state, questions: Object.fromEntries(questions.map((question, index) => [
    `tag_${index}`, { type: 'noul', ...question },
  ])) };
}

export function parseOpenAiJudgments(response: unknown, tags: string[]): { tag: string; probability: number }[] {
  if (!record(response) || !Array.isArray(response.answers)) throw new Error('OpenAI returned no answers. Try analyzing this note again.');
  if (response.answers.length !== tags.length) throw new Error('OpenAI returned an unexpected number of answers. Try analyzing this note again.');
  const answers = new Map<string, Record<string, unknown>>();
  const expected = new Set(tags.map((_, index) => `tag_${index}`));
  for (const answer of response.answers) {
    if (!record(answer) || typeof answer.name !== 'string' || !expected.has(answer.name) || answers.has(answer.name)) {
      throw new Error('OpenAI returned unexpected answer names. Try analyzing this note again.');
    }
    answers.set(answer.name, answer);
  }
  return tags.map((tag, index) => {
    const answer = answers.get(`tag_${index}`)!;
    if (answer.type === 'refusal') throw new Error(`OpenAI declined to evaluate #${tag}. No tags were added for this note.`);
    if (answer.type !== 'predicate' || typeof answer.probability !== 'number'
      || !Number.isFinite(answer.probability) || answer.probability < 0 || answer.probability > 1) {
      throw new Error(`OpenAI returned an invalid probability for #${tag}. Try analyzing this note again.`);
    }
    return { tag, probability: answer.probability };
  });
}
