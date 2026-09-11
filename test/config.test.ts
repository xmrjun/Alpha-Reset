import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const moduleUrl = new URL('../src/config.js', import.meta.url).href;

function runConfig(env: NodeJS.ProcessEnv = {}, file?: string) {
  const cwd = mkdtempSync(join(tmpdir(), 'alpha-config-'));
  try {
    if (file !== undefined) writeFileSync(join(cwd, '.env'), file, { mode: 0o600 });
    return spawnSync(process.execPath, ['--input-type=module', '-e',
      `try {
        const { config } = await import(${JSON.stringify(moduleUrl)});
        console.log(JSON.stringify({ dryRun: config.dryRun, base: config.erwaApiBase,
          fromEnvironment: config.erwaApiToken === 'environment-fake' }));
      } catch (error) {
        console.error(error.code + ': ' + error.message);
        process.exitCode = 1;
      }`,
    ], { cwd, env, encoding: 'utf8' });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test('缺失必填配置时退出，并指出字段名', () => {
  const result = runConfig();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CONFIG_INVALID.*ERWA_API_TOKEN/);
});

test('读取 .env，环境变量优先，允许暂未配置 Telegram', () => {
  const result = runConfig({ ERWA_API_TOKEN: 'environment-fake' },
    'ERWA_API_TOKEN=file-fake\nDRY_RUN=1\n');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    dryRun: true, base: 'https://juhequn.com', fromEnvironment: true,
  });
});

test('配置错误不回显机密或非法 URL', () => {
  const result = runConfig({ ERWA_API_TOKEN: 'environment-fake',
    ERWA_API_BASE: 'https://private-user:private-password@example.com',
    TG_BOT_TOKEN: 'telegram-fake', DRY_RUN: 'true' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ERWA_API_BASE/);
  assert.match(result.stderr, /DRY_RUN/);
  assert.doesNotMatch(result.stderr, /environment-fake|telegram-fake|private-user|private-password/);
});

test('Telegram 配置须成对提供', () => {
  const result = runConfig({ ERWA_API_TOKEN: 'environment-fake', TG_CHAT_ID: '123' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TG_BOT_TOKEN/);
  assert.match(result.stderr, /TG_CHAT_ID/);
});
