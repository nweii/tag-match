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
  const answers = Object.fromEntries(Object.keys(request.questions ?? {}).map((key, index) => [key, {
    type: 'noul', noul: index === 0 ? 0.9 : 0.2,
  }]));
  return new Response(JSON.stringify({ answers, model: request.model, usage: { input_tokens: 1, output_tokens: 1 } }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
};
