// The one function every Claude call goes through. It refuses a call that could take this month's
// spend over the cap, and logs tokens and cost for every call it makes.
import Anthropic from '@anthropic-ai/sdk';
import { db } from './db.ts';
import { CLAUDE_MONTHLY_CAP_GBP, fail, GBP_PER_USD } from './config.ts';

// US dollars per million tokens. A model missing from here cannot be called, so every call is costed.
const PRICES: Record<string, { input: number; output: number }> = {
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-opus-5-5': { input: 4, output: 20 },
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
  const spent = monthSpendGbp();
  if (spent + worstGbp > CLAUDE_MONTHLY_CAP_GBP)
    fail(402, `Monthly Claude spend cap reached: £${spent.toFixed(2)} of £${CLAUDE_MONTHLY_CAP_GBP} used this month`);

  client ??= new Anthropic();
  // Search results carry citations, which strict JSON output does not allow, so a searching call asks for JSON in words.
  const messages: Anthropic.MessageParam[] = [...a.messages];
  // Search cannot be combined with structured output, so a searching call is told the shape instead.
  const system = searches ? `${a.system}\n\nReply with only a JSON object, no other text, matching this JSON schema:\n${JSON.stringify(a.schema)}` : a.system;
  let res: Anthropic.Message, cost = 0;
  // A long search can pause the turn; sending it back resumes it. Three rounds at most.
  for (let round = 0; ; round++) {
    res = await client.messages.create({
      model: a.model,
      max_tokens: a.maxTokens,
      system,
      messages,
      ...(searches
        ? { tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: searches, user_location: { type: 'approximate', country: 'GB' } }], output_config: { effort: a.effort } }
        : { output_config: { effort: a.effort, format: { type: 'json_schema', schema: a.schema } } }),
    } as Anthropic.MessageCreateParamsNonStreaming);
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

// The JSON object in a reply that may have words or a code fence around it.
export function jsonIn(text: string) {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return fail(502, 'Claude did not reply with valid JSON. Try again'); }
}
