// Every setting comes from the environment. See .env.example.
import path from 'node:path';

const env = process.env;

export const ROOT = path.resolve(import.meta.dirname, '..');
export const DATA_DIR = path.resolve(env.DATA_DIR || path.join(ROOT, 'data'));
export const API_KEY = env.API_KEY ?? '';
export const PORT = Number(env.PORT || 3000);
export const HOST = env.HOST || '127.0.0.1';
export const RENDER_RETENTION_DAYS = Number(env.RENDER_RETENTION_DAYS || 14);
export const RENDERS_PER_MIN = Number(env.RENDERS_PER_MIN || 30);
export const TEMPLATE_VERSIONS_KEEP = Number(env.TEMPLATE_VERSIONS_KEEP || 50);

export const CLAUDE_MONTHLY_CAP_GBP = Number(env.CLAUDE_MONTHLY_CAP_GBP || 20);
// OpenAI, only used when Claude is down or overloaded. Same monthly cap. Prices are US dollars per million tokens: check them on openai.com/api/pricing.
export const OPENAI_API_KEY = env.OPENAI_API_KEY ?? '';
export const OPENAI_BASE_URL = env.OPENAI_BASE_URL || 'https://api.openai.com';
export const OPENAI_MODEL = env.OPENAI_MODEL || 'gpt-5';
export const OPENAI_PRICE = { input: Number(env.OPENAI_INPUT_USD_PER_M || 1.25), output: Number(env.OPENAI_OUTPUT_USD_PER_M || 10) };
export const GBP_PER_USD = Number(env.GBP_PER_USD || 0.79); // update now and then: the API bills in US dollars

// Buffer. Images are handed to Buffer as links, so PUBLIC_URL must be the address the internet reaches this app on.
export const BUFFER_API_KEY = env.BUFFER_API_KEY ?? '';
export const BUFFER_API_URL = env.BUFFER_API_URL || 'https://api.buffer.com';
export const PUBLIC_URL = (env.PUBLIC_URL ?? '').replace(/\/$/, '');
export const AUTO_POST = env.AUTO_POST === 'true'; // off: every post waits for approval in the editor

// Articles. Published ones are written as files under PUBLISH_DIR, in a folder per category, for the static site.
export const PUBLISH_DIR = path.resolve(env.PUBLISH_DIR || path.join(DATA_DIR, 'site'));
// When set (owner/name), publishing commits to the website's GitHub repo. The token needs Contents read and write on that repo only.
export const SITE_REPO = env.SITE_REPO ?? '';
export const SITE_BRANCH = env.SITE_BRANCH || 'main';
export const SITE_GITHUB_TOKEN = env.SITE_GITHUB_TOKEN ?? '';
export const GITHUB_API_URL = env.GITHUB_API_URL || 'https://api.github.com'; // tests point this at a fake
export const SITE_URL = (env.SITE_URL || 'https://redcherryit.com').replace(/\/$/, '');

// Sales. Finding businesses uses Google Places (New) and Firecrawl search of UK directories. Either can be left unset.
export const GOOGLE_PLACES_API_KEY = env.GOOGLE_PLACES_API_KEY ?? '';
export const GOOGLE_PLACES_URL = env.GOOGLE_PLACES_URL || 'https://places.googleapis.com'; // tests point these at fakes
export const FIRECRAWL_API_KEY = env.FIRECRAWL_API_KEY ?? '';
export const FIRECRAWL_API_URL = env.FIRECRAWL_API_URL || 'https://api.firecrawl.dev';

// Lead analysis. PageSpeed uses GOOGLE_PLACES_API_KEY, which needs the PageSpeed Insights API turned on in Google Cloud.
export const PAGESPEED_URL = env.PAGESPEED_URL || 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
export const RDAP_URL = env.RDAP_URL || 'https://rdap.org';

// Outreach. Emails send from David's own mailbox over SMTP, after approval, within a daily cap and with a pause between sends.
export const SMTP_HOST = env.SMTP_HOST ?? '';
export const SMTP_PORT = Number(env.SMTP_PORT || 465);
export const SMTP_USER = env.SMTP_USER ?? '';
export const SMTP_PASS = env.SMTP_PASS ?? '';
export const SMTP_FROM = env.SMTP_FROM ?? ''; // e.g. David Hanmer <david@redcherryit.com>
export const OUTREACH_DAILY_CAP = Number(env.OUTREACH_DAILY_CAP || 40);
export const OUTREACH_DELAY_SECONDS = Number(env.OUTREACH_DELAY_SECONDS ?? 20);
// Replies and bounces are read from the same mailbox over IMAP. Blank IMAP_HOST turns it off.
export const IMAP_HOST = env.IMAP_HOST ?? '';
export const IMAP_PORT = Number(env.IMAP_PORT || 993);
export const IMAP_USER = env.IMAP_USER || SMTP_USER;
export const IMAP_PASS = env.IMAP_PASS || SMTP_PASS;

export const RENDERS_DIR = path.join(DATA_DIR, 'renders');
export const MAX_FIELD_CHARS = 300;

export const fail = (statusCode: number, message: string): never => {
  throw Object.assign(new Error(message), { statusCode });
};
