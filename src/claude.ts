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

const costUsd = (model: string, input: number, output: number) =>
  (input * PRICES[model].input + output * PRICES[model].output) / 1_000_000;

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
  const inputGuess = Math.ceil((a.system.length + JSON.stringify(a.messages).length) / 3);
  const worstGbp = costUsd(a.model, inputGuess, a.maxTokens) * GBP_PER_USD;
  const spent = monthSpendGbp();
  if (spent + worstGbp > CLAUDE_MONTHLY_CAP_GBP)
    fail(402, `Monthly Claude spend cap reached: £${spent.toFixed(2)} of £${CLAUDE_MONTHLY_CAP_GBP} used this month`);

  client ??= new Anthropic();
  const res = await client.messages.create({
    model: a.model,
    max_tokens: a.maxTokens,
    system: a.system,
    messages: a.messages,
    output_config: { effort: a.effort, format: { type: 'json_schema', schema: a.schema } },
  });

  const cost = costUsd(a.model, res.usage.input_tokens, res.usage.output_tokens);
  db.prepare('INSERT INTO claude_usage (job, model, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?)')
    .run(a.job, a.model, res.usage.input_tokens, res.usage.output_tokens, cost);

  if (res.stop_reason === 'refusal') fail(502, `Claude declined to write this (${res.stop_details?.category ?? 'no reason given'})`);
  if (res.stop_reason === 'max_tokens') fail(502, `Claude ran out of room. Raise max_tokens in the ${a.job.split(':')[1]} prompt`);
  const text = res.content.find(b => b.type === 'text');
  if (!text || text.type !== 'text') return fail(502, 'Claude returned no text');
  return { output: JSON.parse(text.text), content: res.content, cost_gbp: cost * GBP_PER_USD };
}
