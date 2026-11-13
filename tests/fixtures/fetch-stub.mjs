// Replaces the external Decisions API boundary for CLI subprocess tests.
globalThis.fetch = async (url, options) => {
  const request = JSON.parse(String(options?.body ?? '{}'));
  if (String(url) === 'https://api.openai.com/v1/decisions') {
    if (typeof request.input !== 'string' || !Array.isArray(request.questions)
      || request.questions.some(question => question.type !== 'predicate')) throw new Error('Invalid OpenAI request');
    return new Response(JSON.stringify({ answers: request.questions.map((question, index) => ({
      type: 'predicate', name: question.name, probability: index === 0 ? 0.9 : 0.2,
    })), model: request.model, usage: { input_tokens: 1, output_tokens: 0 } }), { status: 200 });
  }
  if (String(url) === 'https://generativelanguage.googleapis.com/v1beta/decisions') {
    if (options?.headers?.['x-goog-api-key'] !== 'synthetic-key' || options.headers.Authorization
      || typeof request.input !== 'string' || Object.values(request.questions).some(question => typeof question.instructions !== 'string')) {
      return new Response(JSON.stringify({ error: { code: 'invalid', message: 'Invalid Gemini request' } }), { status: 400 });
    }
  }
  const answers = Object.fromEntries(Object.keys(request.questions ?? {}).map((key, index) => [key, {
    type: 'noul', noul: index === 0 ? 0.9 : 0.2,
  }]));
  return new Response(JSON.stringify({ answers, model: request.model, usage: { input_tokens: 1, output_tokens: 1 } }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
};
