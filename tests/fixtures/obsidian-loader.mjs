// Redirects the Obsidian runtime import to the settings test adapter.
const stub = new URL('./obsidian-runtime.mjs', import.meta.url).href;
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'obsidian') return { url: stub, shortCircuit: true };
  return nextResolve(specifier, context);
}
