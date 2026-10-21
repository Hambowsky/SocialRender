// The one function every AI call goes through. It refuses a call that could take this month's
// spend over the cap, and logs tokens and cost for every call it makes. When Claude is down or
// overloaded, a call without web search goes to OpenAI instead, under the same cap.
import Anthropic from '@anthropic-ai/sdk';
import { db } from './db.ts';
import { CLAUDE_MONTHLY_CAP_GBP, fail, GBP_PER_USD, OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL, OPENAI_PRICE } from './config.ts';

// US dollars per million tokens. A model missing from here cannot be called, so every call is costed.
const PRICES: Record<string, { input: number; output: number }> = {
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-opus-5-5': { input: 4, output: 20 },
  [OPENAI_MODEL]: OPENAI_PRICE,
};

const costUsd = (model: string, input: number, output: number, searches = 0) =>
  (input * PRICES[model].input + output * PRICES[model].output) / 1_000_000 + searches * SEARCH_USD;
// Web search is billed per search on top of tokens, and its results come back as input tokens.
const SEARCH_USD = 0.01, SEARCH_TOKENS_GUESS = 15_000;

export function monthSpendGbp(): number {
  const row = db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM claude_usage
                          WHERE created_at >= datetime('now', 'start of month')`).get() as { usd: number };
  return row.usd * GBP_PER_USD;
}

export type Ask = {
  job: string;
  model: string;
  effort: 'low' | 'medium' | 'high';
  maxTokens: number;
  system: string;
  messages: Anthropic.MessageParam[];
  schema: Record<string, unknown>;
  webSearches?: number;  // allow up to this many web searches; the reply is then JSON in text, not a strict schema
};

let client: Anthropic | undefined;
let queue: Promise<unknown> = Promise.resolve();

// Calls run one at a time so two of them can never both squeeze under the cap.
export function ask(a: Ask): Promise<{ output: any; content: Anthropic.ContentBlock[]; cost_gbp: number }> {
  const job = queue.then(() => askNow(a));
  queue = job.catch(() => {});
  return job;
}

async function askNow(a: Ask) {
  if (!process.env.ANTHROPIC_API_KEY) fail(503, 'ANTHROPIC_API_KEY is not set, so Claude copywriting is off');
  if (!PRICES[a.model]) fail(400, `${a.model} has no price set in src/claude.ts, so it cannot be called`);

  // Worst case for this call: roughly 3 characters per input token, plus every output token allowed.
  const searches = a.webSearches ?? 0;
  const inputGuess = Math.ceil((a.system.length + JSON.stringify(a.messages).length) / 3) + searches * SEARCH_TOKENS_GUESS;
  const worstGbp = costUsd(a.model, inputGuess, a.maxTokens, searches) * GBP_PER_USD;
  checkCap(worstGbp);

  client ??= new Anthropic();
  // Search results carry citations, which strict JSON output does not allow, so a searching call asks for JSON in words.
  const messages: Anthropic.MessageParam[] = [...a.messages];
  // Search cannot be combined with structured output, so a searching call is told the shape instead.
  const system = searches ? `${a.system}\n\nReply with only a JSON object, no other text, matching this JSON schema:\n${JSON.stringify(a.schema)}` : a.system;
  let res: Anthropic.Message, cost = 0;
  // A long search can pause the turn; sending it back resumes it. Three rounds at most.
  for (let round = 0; ; round++) {
    try {
      // Streamed, since the API refuses long outputs without it; finalMessage() gives the same result as create().
      res = await client.messages.stream({
        model: a.model,
        max_tokens: a.maxTokens,
        system,
        messages,
        ...(searches
          ? { tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: searches, user_location: { type: 'approximate', country: 'GB' } }], output_config: { effort: a.effort } }
          : { output_config: { effort: a.effort, format: { type: 'json_schema', schema: a.schema } } }),
      } as Anthropic.MessageCreateParamsNonStreaming).finalMessage();
    } catch (err) {
      // The SDK has already retried twice. An outage or overload goes to OpenAI; anything else is a real problem to show.
      if (!OPENAI_API_KEY || searches || round > 0 || !outage(err)) throw err;
      return askOpenAI(a, (err as Error).message);
    }
    const used = res.usage.server_tool_use?.web_search_requests ?? 0;
    const c = costUsd(a.model, res.usage.input_tokens, res.usage.output_tokens, used);
    cost += c;
    db.prepare('INSERT INTO claude_usage (job, model, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?)')
      .run(a.job, a.model, res.usage.input_tokens, res.usage.output_tokens, c);
    if (res.stop_reason !== 'pause_turn' || round >= 2) break;
    messages.push({ role: 'assistant', content: res.content });
  }

  if (res.stop_reason === 'refusal') fail(502, `Claude declined to write this (${res.stop_details?.category ?? 'no reason given'})`);
  if (res.stop_reason === 'max_tokens') fail(502, `Claude ran out of room. Raise max_tokens in the ${a.job.split(':')[1]} prompt`);
  if (res.stop_reason === 'pause_turn') fail(502, 'Claude was still searching after three rounds. Try a narrower focus');
  const texts = res.content.filter(b => b.type === 'text').map(b => (b as Anthropic.TextBlock).text);
  if (!texts.length) return fail(502, 'Claude returned no text');
  return { output: searches ? jsonIn(texts.join('')) : JSON.parse(texts[0]), content: res.content, cost_gbp: cost * GBP_PER_USD };
}

function checkCap(worstGbp: number) {
  const spent = monthSpendGbp();
  if (spent + worstGbp > CLAUDE_MONTHLY_CAP_GBP)
    fail(402, `Monthly AI spend cap reached: £${spent.toFixed(2)} of £${CLAUDE_MONTHLY_CAP_GBP} used this month`);
}

const outage = (err: unknown) => err instanceof Anthropic.APIConnectionError
  || (err instanceof Anthropic.APIError && (err.status === 429 || (err.status ?? 0) >= 500));

// The same job on OpenAI's Chat Completions API. Its reasoning tokens count as output, so it gets extra room for them.
async function askOpenAI(a: Ask, why: string) {
  const text = (c: Anthropic.MessageParam['content']) => typeof c === 'string' ? c : c.map(b => b.type === 'text' ? b.text : '').join('\n');
  const messages = [
    { role: 'system', content: `${a.system}\n\nReply with only a JSON object matching this JSON schema:\n${JSON.stringify(a.schema)}` },
    ...a.messages.map(m => ({ role: m.role, content: text(m.content) })),
  ];
  const maxTokens = a.maxTokens + 4000;
  checkCap(costUsd(OPENAI_MODEL, Math.ceil(JSON.stringify(messages).length / 3), maxTokens) * GBP_PER_USD);
  const res = await fetch(`${OPENAI_BASE_URL}/v1/chat/completions`, { method: 'POST', signal: AbortSignal.timeout(300_000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: OPENAI_MODEL, messages, max_completion_tokens: maxTokens,
      ...(/^(gpt-5|o\d)/.test(OPENAI_MODEL) && { reasoning_effort: a.effort }), response_format: { type: 'json_object' } }) });
  const json = await res.json().catch(() => ({})) as { choices?: { message: { content: string | null }; finish_reason: string }[];
    usage?: { prompt_tokens: number; completion_tokens: number }; error?: { message: string } };
  if (!res.ok || !json.choices?.[0]) fail(502, `Claude is unavailable (${why}) and OpenAI failed too: ${json.error?.message ?? res.status}`);
  const usage = json.usage ?? { prompt_tokens: 0, completion_tokens: 0 };
  const cost = costUsd(OPENAI_MODEL, usage.prompt_tokens, usage.completion_tokens);
  db.prepare('INSERT INTO claude_usage (job, model, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?)')
    .run(a.job, OPENAI_MODEL, usage.prompt_tokens, usage.completion_tokens, cost);
  const choice = json.choices![0];
  if (choice.finish_reason === 'length') fail(502, `OpenAI ran out of room. Raise max_tokens in the ${a.job.split(':')[1]} prompt`);
  const out = choice.message.content ?? '';
  // Shaped like a Claude reply, so a follow up turn can carry it as history.
  return { output: jsonIn(out), content: [{ type: 'text', text: out, citations: null }] as Anthropic.ContentBlock[], cost_gbp: cost * GBP_PER_USD };
}

// The JSON object in a reply that may have words or a code fence around it.
export function jsonIn(text: string) {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return fail(502, 'Claude did not reply with valid JSON. Try again'); }
}
