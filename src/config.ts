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

export const RENDERS_DIR = path.join(DATA_DIR, 'renders');
export const MAX_FIELD_CHARS = 300;

export const fail = (statusCode: number, message: string): never => {
  throw Object.assign(new Error(message), { statusCode });
};
