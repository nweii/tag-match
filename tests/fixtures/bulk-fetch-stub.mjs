// Delays mocked provider responses so subprocess cancellation exercises an unfinished batch.
import './fetch-stub.mjs';
const respond = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  await new Promise(resolve => setTimeout(resolve, 30));
  options?.signal?.throwIfAborted();
  return respond(url, options);
};
