// Reads Markdown frontmatter and appends tags while retaining YAML comments and existing metadata.
import { parseDocument, isMap, isNode, isSeq } from 'yaml';
import { normalizeTag, tagKey } from './core.ts';

export function splitDocument(content: string) {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(content);
  if (!match) return { frontmatter: null, body: content, prefix: '', newline: content.includes('\r\n') ? '\r\n' : '\n' };
  return { frontmatter: match[1]!, body: content.slice(match[0].length), prefix: match[0],
    newline: content.includes('\r\n') ? '\r\n' : '\n' };
}

function yamlDocument(text: string) {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new Error('The note has invalid YAML frontmatter. Fix it before tagging.');
  if (doc.contents !== null && !isMap(doc.contents)) throw new Error('Frontmatter must be a property map. Use named properties such as “tags: [research]”, then try again.');
  return doc;
}

function tagValues(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return value.split(/[,\s]+/).filter(Boolean);
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value;
  throw new Error('The note’s tags property must contain text tags. Change it to text or a list of tag names, then try again.');
}

function nodeValue(value: unknown): unknown {
  return isNode(value) ? value.toJSON() : value;
}

export function noteMetadata(content: string): { body: string; tags: string[]; description: string } {
  const parts = splitDocument(content);
  if (parts.frontmatter === null) return { body: parts.body, tags: [], description: '' };
  const doc = yamlDocument(parts.frontmatter);
  const description = doc.get('description');
  return { body: parts.body, tags: tagValues(nodeValue(doc.get('tags', true))),
    description: typeof description === 'string' ? description : '' };
}

export function addTags(content: string, expectedContent: string, tags: string[], knownExisting: string[]): string {
  if (content !== expectedContent) throw new Error('The note changed after analysis. Run tagging again before applying.');
  const parts = splitDocument(content);
  const doc = yamlDocument(parts.frontmatter ?? '');
  const node = doc.get('tags', true);
  const previous = tagValues(nodeValue(node));
  const seen = new Set([...previous, ...knownExisting].map(tagKey));
  const additions = tags.map(normalizeTag).filter(tag => {
    if (!tag || seen.has(tagKey(tag))) return false;
    seen.add(tagKey(tag)); return true;
  });
  if (!additions.length) return content;
  if (isSeq(node)) for (const tag of additions) node.add(tag);
  else doc.set('tags', [...previous, ...additions]);
  const yaml = doc.toString({ lineWidth: 0 }).replace(/\n/g, parts.newline);
  const bom = content.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = parts.frontmatter === null ? parts.body.replace(/^\uFEFF/, '') : parts.body;
  return `${bom}---${parts.newline}${yaml}---${parts.newline}${body}`;
}
