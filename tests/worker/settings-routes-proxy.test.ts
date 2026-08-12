import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import express from 'express';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import type { Server } from 'http';
import { tmpdir } from 'os';
import path from 'path';
import { SettingsRoutes } from '../../src/services/worker/http/routes/SettingsRoutes.js';

const PROXY_ENABLED_KEY = 'CLAUDE_MEM_CLAUDE_SDK_PROXY_ENABLED';
const PROXY_URL_KEY = 'CLAUDE_MEM_CLAUDE_SDK_PROXY_URL';
const TRACKED_PROXY = 'http://tracked-proxy:59625';
const originalProxyEnabled = process.env[PROXY_ENABLED_KEY];
const originalProxyUrl = process.env[PROXY_URL_KEY];

describe('SettingsRoutes Claude SDK proxy settings', () => {
  let server: Server | undefined;
  let baseUrl: string;
  let settingsPath: string;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(tmpdir(), `claude-mem-settings-route-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    settingsPath = path.join(tempDir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({
      env: {
        CLAUDE_MEM_MODEL: 'claude-haiku-4-5-20251001',
        [PROXY_ENABLED_KEY]: 'false',
        [PROXY_URL_KEY]: 'http://legacy-proxy:8080',
      },
    }), 'utf-8');

    const app = express();
    app.use(express.json());
    new SettingsRoutes({} as any, () => settingsPath).setupRoutes(app);

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close(error => error ? reject(error) : resolve());
      });
    }
    if (originalProxyEnabled === undefined) delete process.env[PROXY_ENABLED_KEY];
    else process.env[PROXY_ENABLED_KEY] = originalProxyEnabled;
    if (originalProxyUrl === undefined) delete process.env[PROXY_URL_KEY];
    else process.env[PROXY_URL_KEY] = originalProxyUrl;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects an invalid merged proxy configuration without changing the tracked file', async () => {
    const before = readFileSync(settingsPath, 'utf-8');
    const response = await fetch(`${baseUrl}/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        [PROXY_ENABLED_KEY]: 'true',
        [PROXY_URL_KEY]: 'socks5://invalid-proxy:1080',
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ success: false });
    expect(readFileSync(settingsPath, 'utf-8')).toBe(before);
  });

  it('flattens legacy settings and persists the validated file-only proxy values', async () => {
    process.env[PROXY_ENABLED_KEY] = 'false';
    process.env[PROXY_URL_KEY] = 'http://parent-decoy:8080';

    const response = await fetch(`${baseUrl}/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        [PROXY_ENABLED_KEY]: 'true',
        [PROXY_URL_KEY]: TRACKED_PROXY,
      }),
    });

    expect(response.status).toBe(200);
    const persisted = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(persisted.env).toBeUndefined();
    expect(persisted.CLAUDE_MEM_MODEL).toBe('claude-haiku-4-5-20251001');
    expect(persisted[PROXY_ENABLED_KEY]).toBe('true');
    expect(persisted[PROXY_URL_KEY]).toBe(TRACKED_PROXY);

    // No GET assertion here on purpose. GET goes through
    // SettingsDefaultsManager.loadFromFile, and tests/hooks/file-context.test.ts
    // installs a module-level mock for that module. bun runs every test file in
    // one process and mock.module survives into later files, so a GET assertion
    // passes when this file runs alone and fails in the full suite -- it would be
    // measuring which file ran first, not the route. What this test uniquely owns
    // is POST validation plus file-only persistence, asserted above; that the
    // built SDK env takes its proxy from the tracked file is covered by
    // tests/shared/claude-sdk-env.test.ts.
  });

  it('validates the merged file so an existing tracked URL can be enabled separately', async () => {
    const response = await fetch(`${baseUrl}/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        [PROXY_ENABLED_KEY]: 'true',
      }),
    });

    expect(response.status).toBe(200);
    const persisted = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(persisted[PROXY_ENABLED_KEY]).toBe('true');
    expect(persisted[PROXY_URL_KEY]).toBe('http://legacy-proxy:8080');
  });
});
