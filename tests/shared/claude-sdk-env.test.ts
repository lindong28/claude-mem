import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import * as EnvManager from '../../src/shared/EnvManager.js';
import * as ProcessRegistry from '../../src/supervisor/process-registry.js';
import { sanitizeEnv } from '../../src/supervisor/env-sanitizer.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { logger } from '../../src/utils/logger.js';

const PROXY_ENABLED_KEY = 'CLAUDE_MEM_CLAUDE_SDK_PROXY_ENABLED';
const PROXY_URL_KEY = 'CLAUDE_MEM_CLAUDE_SDK_PROXY_URL';
const TRACKED_PROXY = 'http://tracked-proxy:59625';
const DECOY_PROXY = 'http://parent-decoy:8080';

const originalEnv = { ...process.env };
const tempDirs: string[] = [];

function makeSettings(settings: Record<string, unknown>): string {
  const dir = path.join(tmpdir(), `claude-mem-sdk-proxy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  tempDirs.push(dir);
  mkdirSync(dir, { recursive: true });
  const settingsPath = path.join(dir, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify(settings), 'utf-8');
  return settingsPath;
}

function installParentDecoys(): void {
  Object.assign(process.env, {
    HTTP_PROXY: DECOY_PROXY,
    HTTPS_PROXY: DECOY_PROXY,
    ALL_PROXY: 'socks5://parent-decoy:1080',
    NO_PROXY: 'decoy.invalid',
    http_proxy: DECOY_PROXY,
    https_proxy: DECOY_PROXY,
    all_proxy: 'socks5://parent-decoy:1080',
    no_proxy: 'decoy.invalid',
    [PROXY_ENABLED_KEY]: 'false',
    [PROXY_URL_KEY]: DECOY_PROXY,
  });
}

async function buildProxyEnvsForBaseUrl(baseUrl?: string): Promise<{
  sdkEnv: EnvManager.ClaudeSdkEnvironment;
  finalChildEnv: NodeJS.ProcessEnv;
}> {
  installParentDecoys();
  if (baseUrl === undefined) {
    delete process.env.ANTHROPIC_BASE_URL;
  } else {
    process.env.ANTHROPIC_BASE_URL = baseUrl;
  }

  const settingsPath = makeSettings({
    [PROXY_ENABLED_KEY]: 'true',
    [PROXY_URL_KEY]: TRACKED_PROXY,
  });
  const sdkEnv = await EnvManager.buildClaudeSdkEnv({
    settingsPath,
    includeCredentials: false,
  });

  return {
    sdkEnv,
    finalChildEnv: ProcessRegistry.buildSdkSpawnEnv(sdkEnv.env, sdkEnv.proxyEnv),
  };
}

function buildProxyEnvsWithCredentialBaseUrl(
  parentBaseUrl: string,
  credentialBaseUrl: string,
): {
  baseUrl: string | undefined;
  sdkNoProxy: string | undefined;
  proxyNoProxy: string | undefined;
  finalNoProxy: string | undefined;
} {
  const settingsPath = makeSettings({
    [PROXY_ENABLED_KEY]: 'true',
    [PROXY_URL_KEY]: TRACKED_PROXY,
  });
  const fixtureRoot = path.dirname(settingsPath);
  const dataDir = path.join(fixtureRoot, 'data');
  const claudeConfigDir = path.join(fixtureRoot, 'claude');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    path.join(dataDir, '.env'),
    `ANTHROPIC_BASE_URL=${credentialBaseUrl}\n`,
    'utf-8',
  );

  const childScript = `
    const EnvManager = await import('./src/shared/EnvManager.ts');
    const ProcessRegistry = await import('./src/supervisor/process-registry.ts');
    const sdkEnv = await EnvManager.buildClaudeSdkEnv({ settingsPath: ${JSON.stringify(settingsPath)} });
    const finalChildEnv = ProcessRegistry.buildSdkSpawnEnv(sdkEnv.env, sdkEnv.proxyEnv);
    console.log(JSON.stringify({
      baseUrl: sdkEnv.env.ANTHROPIC_BASE_URL,
      sdkNoProxy: sdkEnv.env.NO_PROXY,
      proxyNoProxy: sdkEnv.proxyEnv?.NO_PROXY,
      finalNoProxy: finalChildEnv.NO_PROXY,
    }));
  `;
  const child = Bun.spawnSync({
    cmd: [process.execPath, '--eval', childScript],
    cwd: new URL('../..', import.meta.url).pathname,
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: parentBaseUrl,
      CLAUDE_MEM_DATA_DIR: dataDir,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
    },
  });

  expect(child.exitCode).toBe(0);
  return JSON.parse(child.stdout.toString());
}

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('Claude SDK proxy env', () => {
  it('uses the tracked settings value instead of parent proxy and config-key decoys', async () => {
    installParentDecoys();
    const settingsPath = makeSettings({
      [PROXY_ENABLED_KEY]: 'true',
      [PROXY_URL_KEY]: TRACKED_PROXY,
    });

    const buildClaudeSdkEnv = (EnvManager as any).buildClaudeSdkEnv;
    expect(typeof buildClaudeSdkEnv).toBe('function');

    const result = await buildClaudeSdkEnv({ settingsPath, includeCredentials: false });

    expect(result.proxyEnv).toEqual({
      HTTP_PROXY: TRACKED_PROXY,
      HTTPS_PROXY: TRACKED_PROXY,
    });
    expect(result.env.HTTP_PROXY).toBe(TRACKED_PROXY);
    expect(result.env.HTTPS_PROXY).toBe(TRACKED_PROXY);
    expect(result.env.ALL_PROXY).toBeUndefined();
    expect(result.env.NO_PROXY).toBeUndefined();
  });

  it('keeps proxy stripping unchanged when the opt-in is disabled', async () => {
    installParentDecoys();
    const settingsPath = makeSettings({
      [PROXY_ENABLED_KEY]: 'false',
      [PROXY_URL_KEY]: TRACKED_PROXY,
    });

    const buildClaudeSdkEnv = (EnvManager as any).buildClaudeSdkEnv;
    expect(typeof buildClaudeSdkEnv).toBe('function');

    const result = await buildClaudeSdkEnv({ settingsPath, includeCredentials: false });

    expect(result.proxyEnv).toBeUndefined();
    expect(result.env.HTTP_PROXY).toBeUndefined();
    expect(result.env.HTTPS_PROXY).toBeUndefined();
  });

  it('fails loudly when proxying is enabled without a tracked proxy URL', async () => {
    installParentDecoys();
    const settingsPath = makeSettings({
      [PROXY_ENABLED_KEY]: 'true',
    });

    const buildClaudeSdkEnv = (EnvManager as any).buildClaudeSdkEnv;
    expect(typeof buildClaudeSdkEnv).toBe('function');

    await expect(buildClaudeSdkEnv({ settingsPath, includeCredentials: false }))
      .rejects.toThrow(PROXY_URL_KEY);
  });

  it('rejects proxy URLs with surrounding whitespace or an unsupported scheme', async () => {
    const buildClaudeSdkEnv = (EnvManager as any).buildClaudeSdkEnv;
    expect(typeof buildClaudeSdkEnv).toBe('function');

    for (const proxyUrl of [` ${TRACKED_PROXY} `, 'socks5://tracked-proxy:1080', 'not-a-url']) {
      const settingsPath = makeSettings({
        [PROXY_ENABLED_KEY]: 'true',
        [PROXY_URL_KEY]: proxyUrl,
      });

      await expect(buildClaudeSdkEnv({ settingsPath, includeCredentials: false }))
        .rejects.toThrow(PROXY_URL_KEY);
    }
  });

  it('rejects non-canonical opt-in values instead of silently treating them as disabled', async () => {
    const buildClaudeSdkEnv = (EnvManager as any).buildClaudeSdkEnv;
    expect(typeof buildClaudeSdkEnv).toBe('function');

    for (const enabled of ['TRUE', '1', 1]) {
      const settingsPath = makeSettings({
        [PROXY_ENABLED_KEY]: enabled,
        [PROXY_URL_KEY]: TRACKED_PROXY,
      });

      await expect(buildClaudeSdkEnv({ settingsPath, includeCredentials: false }))
        .rejects.toThrow(PROXY_ENABLED_KEY);
    }
  });

  it('supports the legacy nested settings shape with the same validation', async () => {
    const buildClaudeSdkEnv = (EnvManager as any).buildClaudeSdkEnv;
    expect(typeof buildClaudeSdkEnv).toBe('function');

    const validSettingsPath = makeSettings({
      env: {
        [PROXY_ENABLED_KEY]: 'true',
        [PROXY_URL_KEY]: TRACKED_PROXY,
      },
    });
    const validResult = await buildClaudeSdkEnv({
      settingsPath: validSettingsPath,
      includeCredentials: false,
    });
    expect(validResult.proxyEnv).toEqual({
      HTTP_PROXY: TRACKED_PROXY,
      HTTPS_PROXY: TRACKED_PROXY,
    });

    const invalidSettingsPath = makeSettings({
      env: {
        [PROXY_ENABLED_KEY]: 'true',
      },
    });
    await expect(buildClaudeSdkEnv({
      settingsPath: invalidSettingsPath,
      includeCredentials: false,
    })).rejects.toThrow(PROXY_URL_KEY);
  });

  it('reinjects the same verified proxy after the SDK spawn sanitization pass', async () => {
    installParentDecoys();
    const settingsPath = makeSettings({
      [PROXY_ENABLED_KEY]: 'true',
      [PROXY_URL_KEY]: TRACKED_PROXY,
    });

    const buildClaudeSdkEnv = (EnvManager as any).buildClaudeSdkEnv;
    const buildSdkSpawnEnv = (ProcessRegistry as any).buildSdkSpawnEnv;
    expect(typeof buildClaudeSdkEnv).toBe('function');
    expect(typeof buildSdkSpawnEnv).toBe('function');

    const sdkEnv = await buildClaudeSdkEnv({ settingsPath, includeCredentials: false });
    const brokenFinalChildEnv = sanitizeEnv(sdkEnv.env);
    expect(brokenFinalChildEnv.HTTP_PROXY).toBeUndefined();
    expect(brokenFinalChildEnv.HTTPS_PROXY).toBeUndefined();

    const finalChildEnv = buildSdkSpawnEnv(sdkEnv.env, sdkEnv.proxyEnv);
    expect(finalChildEnv.HTTP_PROXY).toBe(TRACKED_PROXY);
    expect(finalChildEnv.HTTPS_PROXY).toBe(TRACKED_PROXY);
  });

  it('does not add NO_PROXY without a loopback Anthropic base URL', async () => {
    for (const baseUrl of [undefined, 'https://api.anthropic.com']) {
      const { sdkEnv, finalChildEnv } = await buildProxyEnvsForBaseUrl(baseUrl);

      expect(sdkEnv.proxyEnv?.NO_PROXY).toBeUndefined();
      expect(sdkEnv.env.NO_PROXY).toBeUndefined();
      expect(finalChildEnv.NO_PROXY).toBeUndefined();
    }
  });

  it('adds only localhost to NO_PROXY for a localhost Anthropic base URL', async () => {
    const { sdkEnv, finalChildEnv } = await buildProxyEnvsForBaseUrl('http://localhost:4000');

    expect(sdkEnv.proxyEnv?.NO_PROXY).toBe('localhost');
    expect(sdkEnv.env.NO_PROXY).toBe('localhost');
    expect(finalChildEnv.NO_PROXY).toBe(sdkEnv.proxyEnv?.NO_PROXY);
    expect(finalChildEnv.NO_PROXY).not.toContain('::1');
  });

  it('adds only 127.0.0.1 to NO_PROXY for an IPv4 loopback Anthropic base URL', async () => {
    const { sdkEnv, finalChildEnv } = await buildProxyEnvsForBaseUrl('http://127.0.0.1:4000');

    expect(sdkEnv.proxyEnv?.NO_PROXY).toBe('127.0.0.1');
    expect(sdkEnv.env.NO_PROXY).toBe('127.0.0.1');
    expect(finalChildEnv.NO_PROXY).toBe(sdkEnv.proxyEnv?.NO_PROXY);
    expect(finalChildEnv.NO_PROXY).not.toContain('::1');
  });

  it('does not claim IPv6 loopback bypass support and logs the uncovered case', async () => {
    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});

    try {
      const { sdkEnv, finalChildEnv } = await buildProxyEnvsForBaseUrl('http://[::1]:4000');

      expect(sdkEnv.proxyEnv?.NO_PROXY).toBeUndefined();
      expect(sdkEnv.env.NO_PROXY).toBeUndefined();
      expect(finalChildEnv.NO_PROXY).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        'ENV',
        expect.stringContaining('IPv6 loopback'),
        expect.objectContaining({ hostname: '[::1]' }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('derives NO_PROXY from the final credential-file base URL instead of the parent value', () => {
    const localCredential = buildProxyEnvsWithCredentialBaseUrl(
      'https://api.anthropic.com',
      'http://localhost:4000',
    );
    expect(localCredential).toEqual({
      baseUrl: 'http://localhost:4000',
      sdkNoProxy: 'localhost',
      proxyNoProxy: 'localhost',
      finalNoProxy: 'localhost',
    });

    const externalCredential = buildProxyEnvsWithCredentialBaseUrl(
      'http://127.0.0.1:4000',
      'https://api.anthropic.com',
    );
    expect(externalCredential).toEqual({
      baseUrl: 'https://api.anthropic.com',
    });
  });

  it('keeps the opt-in keys in generated defaults without trusting env overrides', () => {
    installParentDecoys();
    const defaults = SettingsDefaultsManager.getAllDefaults() as Record<string, string>;
    const settingsPath = makeSettings({
      [PROXY_ENABLED_KEY]: 'true',
      [PROXY_URL_KEY]: TRACKED_PROXY,
    });
    const loaded = SettingsDefaultsManager.loadFromFile(settingsPath) as unknown as Record<string, string>;

    expect(defaults[PROXY_ENABLED_KEY]).toBe('false');
    expect(defaults[PROXY_URL_KEY]).toBe('');
    expect(loaded[PROXY_ENABLED_KEY]).toBe('true');
    expect(loaded[PROXY_URL_KEY]).toBe(TRACKED_PROXY);
    expect(SettingsDefaultsManager.get(PROXY_ENABLED_KEY as any)).toBe('false');
    expect(SettingsDefaultsManager.get(PROXY_URL_KEY as any)).toBe('');
  });

  it('limits proxy injection to the three Claude SDK paths', () => {
    const claudeProvider = readFileSync('src/services/worker/ClaudeProvider.ts', 'utf-8');
    const knowledgeAgent = readFileSync('src/services/worker/knowledge/KnowledgeAgent.ts', 'utf-8');
    const processRegistry = readFileSync('src/supervisor/process-registry.ts', 'utf-8');
    const localOnlySources = [
      'src/services/sync/ChromaMcpManager.ts',
      'src/services/worker-service.ts',
      'src/services/infrastructure/ProcessManager.ts',
    ].map(file => readFileSync(file, 'utf-8'));

    expect((claudeProvider.match(/buildClaudeSdkEnv\(/g) ?? [])).toHaveLength(1);
    expect((knowledgeAgent.match(/buildClaudeSdkEnv\(/g) ?? [])).toHaveLength(2);
    expect(claudeProvider).toContain('createSdkSpawnFactory(session.sessionDbId, proxyEnv)');
    expect(processRegistry).toContain('buildSdkSpawnEnv(options.env ?? process.env, proxyEnv)');

    for (const source of localOnlySources) {
      expect(source).toContain('sanitizeEnv(');
      expect(source).not.toContain('buildClaudeSdkEnv(');
      expect(source).not.toContain('injectProxy');
    }
  });
});
