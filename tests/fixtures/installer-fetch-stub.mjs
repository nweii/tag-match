// Replaces GitHub release downloads for the companion installer subprocess tests.
globalThis.fetch = async url => process.env.FAIL_DOWNLOAD
  ? new Response('missing', { status: 404 })
  : new Response(String(url).endsWith('tag-match.mjs') ? 'cli fixture' : 'guide fixture');
