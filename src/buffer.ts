// Buffer's GraphQL API: list channels and create posts. Docs: https://developers.buffer.com
import { BUFFER_API_KEY, BUFFER_API_URL, fail } from './config.ts';

// A request that may or may not have reached Buffer (network error, timeout, server error).
// Sending it again could post twice, so the caller must not retry it automatically.
export class BufferUnsure extends Error {}

// Values are written inline, as in Buffer's own examples, so no input type names have to be guessed.
// Strings go through JSON.stringify, which gives valid GraphQL string literals.
class Enum { v: string; constructor(v: string) { this.v = v; } }
function lit(v: unknown): string {
  if (v instanceof Enum) return v.v;
  if (Array.isArray(v)) return `[${v.map(lit).join(', ')}]`;
  if (v && typeof v === 'object') return `{ ${Object.entries(v).map(([k, x]) => `${k}: ${lit(x)}`).join(', ')} }`;
  return JSON.stringify(v);
}

async function gql(query: string) {
  if (!BUFFER_API_KEY) fail(503, 'BUFFER_API_KEY is not set, so posting to Buffer is off');
  let res: Response;
  try {
    res = await fetch(BUFFER_API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${BUFFER_API_KEY}` },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new BufferUnsure(`Could not reach Buffer: ${(err as Error).message}`);
  }
  if (res.status >= 500) throw new BufferUnsure(`Buffer returned ${res.status}`);
  const body = await res.json().catch(() => ({})) as { data?: any; errors?: { message: string }[] };
  if (!res.ok || body.errors?.length) throw new Error(`Buffer: ${body.errors?.map(e => e.message).join('; ') || res.status}`);
  return body.data;
}

export async function channels() {
  const data = await gql('query { account { organizations { id name } } }');
  const out: { id: string; name: string; service: string; organization: string }[] = [];
  for (const org of data.account.organizations) {
    const d = await gql(`query { channels(input: ${lit({ organizationId: org.id })}) { id name displayName service } }`);
    for (const c of d.channels) out.push({ id: c.id, name: c.displayName || c.name, service: c.service, organization: org.name });
  }
  return out;
}

export type NewPost = { channelId: string; text: string; imageUrl: string; mode: 'queue' | 'scheduled' | 'draft'; dueAt?: string };

export async function createPost(p: NewPost): Promise<string> {
  const input: Record<string, unknown> = {
    channelId: p.channelId,
    text: p.text,
    schedulingType: new Enum('automatic'),
    mode: new Enum(p.mode === 'scheduled' ? 'customScheduled' : 'addToQueue'),
    assets: [{ image: { url: p.imageUrl } }],
  };
  if (p.mode === 'scheduled') input.dueAt = p.dueAt;
  if (p.mode === 'draft') input.saveToDraft = true;
  const data = await gql(`mutation {
    createPost(input: ${lit(input)}) {
      ... on PostActionSuccess { post { id } }
      ... on MutationError { message }
    }
  }`);
  const r = data.createPost;
  if (!r?.post?.id) throw new Error(`Buffer: ${r?.message ?? 'no post returned'}`);
  return r.post.id;
}
