// Replaces the external Decisions API boundary for CLI subprocess tests.
globalThis.fetch = async (_url, options) => {
  const request = JSON.parse(String(options?.body ?? '{}'));
  const answers = Object.fromEntries(Object.keys(request.questions ?? {}).map((key, index) => [key, {
    type: 'noul', noul: index === 0 ? 0.9 : 0.2,
  }]));
  return new Response(JSON.stringify({ answers, model: request.model, usage: { input_tokens: 1, output_tokens: 1 } }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
};
