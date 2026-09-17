import { loadEnvFile } from 'node:process';
import { z } from 'zod';

const httpUrl = z.url().refine((value) => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
});

const schema = z.object({
  ERWA_API_BASE: httpUrl.default('https://juhequn.com'),
  ERWA_API_TOKEN: z.string().trim().min(1),
  TG_BOT_TOKEN: z.string().trim().default(''),
  TG_CHAT_ID: z.string().trim().default(''),
  PUBLIC_SITE: httpUrl.default('https://alpha.0xdydx.top'),
  DATABASE_PATH: z.string().trim().min(1).default('data/alpha-reset.sqlite'),
  DRY_RUN: z.enum(['0', '1']).default('0'),
  QUOTA_TIMEZONE: z.string().default('UTC').refine((value) => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
  }),
  WEB_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
}).superRefine((value, ctx) => {
  if (Boolean(value.TG_BOT_TOKEN) !== Boolean(value.TG_CHAT_ID)) {
    ctx.addIssue({ code: 'custom', path: ['TG_BOT_TOKEN', 'TG_CHAT_ID'], message: '必须同时配置' });
  }
});

export class ConfigError extends Error {
  readonly code = 'CONFIG_INVALID';
}

export function loadConfig() {
  try {
    // 允许按进程指定凭据文件：web 只需要 XAPI_KEY，不该持有 Telegram bot token、
    // GMGN key 和二娃 token —— 而它恰好是唯一直接暴露在公网请求面前的进程。
    const envFile = process.env.ENV_FILE;
    if (envFile) loadEnvFile(envFile); else loadEnvFile();
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw new ConfigError('无法读取 .env 配置文件');
    }
  }

  const result = schema.safeParse({
    ERWA_API_BASE: process.env.ERWA_API_BASE,
    ERWA_API_TOKEN: process.env.ERWA_API_TOKEN,
    TG_BOT_TOKEN: process.env.TG_BOT_TOKEN,
    TG_CHAT_ID: process.env.TG_CHAT_ID,
    PUBLIC_SITE: process.env.PUBLIC_SITE,
    DATABASE_PATH: process.env.DATABASE_PATH,
    DRY_RUN: process.env.DRY_RUN,
    QUOTA_TIMEZONE: process.env.QUOTA_TIMEZONE,
    WEB_PORT: process.env.WEB_PORT,
  });
  if (!result.success) {
    // 只输出字段名，zod 的输入、issue message 和底层错误均可能含机密。
    const fields = [...new Set(result.error.issues.flatMap((issue) => issue.path))];
    throw new ConfigError(`配置缺失或格式无效：${fields.join('、')}`);
  }

  return {
    erwaApiBase: result.data.ERWA_API_BASE,
    erwaApiToken: result.data.ERWA_API_TOKEN,
    telegramBotToken: result.data.TG_BOT_TOKEN,
    telegramChatId: result.data.TG_CHAT_ID,
    publicSite: result.data.PUBLIC_SITE,
    databasePath: result.data.DATABASE_PATH,
    dryRun: result.data.DRY_RUN === '1',
    quotaTimezone: result.data.QUOTA_TIMEZONE,
    webPort: result.data.WEB_PORT,
  };
}

export type Config = ReturnType<typeof loadConfig>;
export const config = loadConfig();
