import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { ConfigError } from '../src/errors.js';

const PROD_ENV = {
  NODE_ENV: 'production',
  IDENTITY_BASE_URL: 'https://identity.example.test',
  OFFICEPULSE_INSTANCE_ID: 'op-1',
  TRUSTED_SERVER_CIDRS: '10.0.0.0/24',
  ARI_URL: 'http://10.0.0.2:8088/ari',
  ARI_USERNAME: 'aida',
  ARI_PASSWORD: 'pw',
  PBX_DB_HOST: '10.0.0.2',
  MYSQL_USER: 'aida_integration',
  MYSQL_PASSWORD: 'pw',
  PBX_DB_NAME: 'asterisk',
  PBX_DB_INVENTORY_USER: 'inventory_ro',
  PBX_DB_INVENTORY_PASSWORD: 'ro-pw',
  PBX_DB_PROVISIONING_USER: 'pbx_writer',
  PBX_DB_PROVISIONING_PASSWORD: 'writer-password',
  DB_NAME: 'aidacalls_db',
  DB_HOST: 'runtime-db',
  DB_USER: 'aida_runtime',
  DB_PASSWORD: 'pw',
  NOCODB_BASE_URL: 'https://nocodb.test',
  NOCODB_API_TOKEN: 'token',
  LIVEKIT_URL: 'wss://acme.livekit.cloud',
  LIVEKIT_API_KEY: 'key',
  LIVEKIT_API_SECRET: 'secret',
  LIVEKIT_SIP_HOST: 'sip.livekit.cloud',
};

test('administration-only production requires real platform services but no voice credentials', () => {
  const env = {
    NODE_ENV: 'production', VOICE_ENABLED: 'false',
    IDENTITY_BASE_URL: PROD_ENV.IDENTITY_BASE_URL,
    OFFICEPULSE_INSTANCE_ID: PROD_ENV.OFFICEPULSE_INSTANCE_ID,
    TRUSTED_SERVER_CIDRS: PROD_ENV.TRUSTED_SERVER_CIDRS,
    DB_NAME: 'aidacalls_db',
    DB_HOST: 'runtime-db', DB_USER: 'runtime', DB_PASSWORD: 'pw',
    NOCODB_BASE_URL: PROD_ENV.NOCODB_BASE_URL, NOCODB_API_TOKEN: PROD_ENV.NOCODB_API_TOKEN,
    ...Object.fromEntries(Object.entries(PROD_ENV).filter(([key]) => key.startsWith('PBX_DB_'))),
  };
  const config = loadConfig(env);
  assert.equal(config.voiceEnabled, false);
  assert.equal(config.ari.password, '');
  assert.equal(config.livekit.apiSecret, '');
  assert.throws(() => loadConfig({ ...env, DB_HOST: '' }), ConfigError);
  assert.throws(() => loadConfig({ ...env, NOCODB_API_TOKEN: '' }), ConfigError);
  assert.throws(() => loadConfig({ ...env, VOICE_ENABLED: 'true' }), ConfigError);
  assert.throws(() => loadConfig({ ...PROD_ENV, VOICE_ENABLED: 'typo' }), ConfigError);
});

test('development config loads with defaults', () => {
  const config = loadConfig({ NODE_ENV: 'development' });
  assert.equal(config.fastAgi.port, 4573);
  assert.equal(config.http.port, 8085);
  assert.equal(config.takeover.drainTimeoutMs, 3000);
  assert.equal(config.takeover.announcementTimeoutMs, 3000);
});

test('production requires credentials and non-empty CIDR allowlist', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), ConfigError);
  const err = (() => {
    try {
      loadConfig({ NODE_ENV: 'production' });
      return undefined;
    } catch (e) {
      return e as ConfigError;
    }
  })();
  assert.ok(err?.problems.some((p) => p.includes('TRUSTED_SERVER_CIDRS')));
  assert.doesNotThrow(() => loadConfig(PROD_ENV));
});

test('invalid CIDRs and integers are reported together', () => {
  try {
    loadConfig({ ...PROD_ENV, TRUSTED_SERVER_CIDRS: 'garbage', FASTAGI_PORT: '99999' });
    assert.fail('should throw');
  } catch (err) {
    const problems = (err as ConfigError).problems;
    assert.ok(problems.some((p) => p.includes("invalid CIDR 'garbage'")));
    assert.ok(problems.some((p) => p.includes('FASTAGI_PORT')));
  }
});

test('drain timeout is capped at the 10 second maximum', () => {
  assert.throws(() => loadConfig({ ...PROD_ENV, TAKEOVER_DRAIN_TIMEOUT_MS: '20000' }), ConfigError);
});

test('production requires the dependencies this service now orchestrates itself', () => {
  // Voice and scoped settings credentials are validated independently.
  for (const key of [
    'NOCODB_BASE_URL',
    'NOCODB_API_TOKEN',
    'LIVEKIT_URL',
    'LIVEKIT_API_KEY',
    'LIVEKIT_API_SECRET',
    'LIVEKIT_SIP_HOST',
    'DB_HOST',
    'DB_NAME',
    'DB_USER',
    'DB_PASSWORD',
  ]) {
    const env: Record<string, string> = { ...PROD_ENV };
    delete env[key];
    assert.throws(() => loadConfig(env), ConfigError, `${key} must be required in production`);
  }
});

test('no AidaControl configuration is read or required any more', () => {
  const config = loadConfig({ ...PROD_ENV, AIDACONTROL_BASE_URL: 'http://stale:9010' });
  assert.equal(JSON.stringify(config).includes('stale:9010'), false);
  assert.equal('baseName' in config.nocodb, false, 'the PlatformConfig base is found by its fixed name');
  assert.equal(config.livekit.agentName, 'aida-prime');
});

test('retired PBX writer credentials and rollback flag are ignored', () => {
  const config = loadConfig({ ...PROD_ENV, MYSQL_USER: 'retired', LEGACY_PBX_PROVISIONING_ENABLED: 'true' });
  assert.equal('asteriskMysql' in config, false);
  assert.equal('legacyPbxProvisioningEnabled' in config, false);
});

test('both PBX logins are always on in production and need their credentials; elsewhere each is on once its user is set', () => {
  const config = loadConfig(PROD_ENV);
  assert.equal(config.pbxInventoryMysql?.user, 'inventory_ro');
  assert.equal(config.pbxProvisioningMysql?.user, 'pbx_writer');
  assert.equal(config.pbxProvisioningMysql?.database, 'asterisk');
  // The retired switches change nothing.
  assert.equal(loadConfig({ ...PROD_ENV, PBX_INVENTORY_ENABLED: 'false', PBX_PROVISIONING_ENABLED: 'false' }).pbxProvisioningMysql?.user, 'pbx_writer');
  assert.throws(() => loadConfig({ ...PROD_ENV, PBX_DB_PROVISIONING_USER: undefined }), /PBX_DB_PROVISIONING_USER/);
  assert.throws(() => loadConfig({ ...PROD_ENV, PBX_DB_INVENTORY_PASSWORD: undefined }), /PBX_DB_INVENTORY_PASSWORD/);
  const dev = loadConfig({ NODE_ENV: 'development' });
  assert.equal(dev.pbxInventoryMysql, undefined);
  assert.equal(dev.pbxProvisioningMysql, undefined);
  assert.equal(loadConfig({ NODE_ENV: 'development', PBX_DB_PROVISIONING_USER: 'w', PBX_DB_PROVISIONING_PASSWORD: 'p' }).pbxProvisioningMysql?.user, 'w');
  assert.throws(() => loadConfig({ NODE_ENV: 'development', PBX_DB_PROVISIONING_USER: 'w' }), /PBX_DB_PROVISIONING_PASSWORD/);
});

test('proxies default to the trusted server networks; an explicit list replaces them', () => {
  assert.deepEqual(loadConfig(PROD_ENV).http.trustedProxyCidrs, ['10.0.0.0/24']);
  assert.deepEqual(loadConfig({ ...PROD_ENV, TRUSTED_PROXY_CIDRS: '172.18.0.0/16' }).http.trustedProxyCidrs, ['172.18.0.0/16']);
  assert.deepEqual(loadConfig({ ...PROD_ENV, TRUSTED_PROXY_CIDRS: '' }).http.trustedProxyCidrs, []);
});

test('the retired tenant map fails startup explicitly; the Asterisk context is the PBX scope', () => {
  assert.throws(() => loadConfig({ ...PROD_ENV, PBX_INVENTORY_TENANTS_JSON: '{"1":{"contexts":["one"],"queueNames":[]}}' }),
    (error: ConfigError) => error.problems.includes('PBX_INVENTORY_TENANTS_JSON is retired: PBX scope is the Asterisk context. See docs/PBX_SOURCE_OF_TRUTH.md (Migrating from tenant maps)'));
  assert.throws(() => loadConfig({ NODE_ENV: 'development', PBX_INVENTORY_TENANTS_JSON: '{}' }), /PBX_INVENTORY_TENANTS_JSON is retired/);
  const config = loadConfig({ ...PROD_ENV, PBX_INVENTORY_TENANTS_JSON: '  ' });
  assert.equal('pbxInventoryScopes' in config, false);
});

test('OFFICEPULSE_INSTANCE_ID is the PBX instance wire name and must fit its grammar', () => {
  assert.equal(loadConfig({ NODE_ENV: 'development' }).officePulseInstanceId, 'officepulse-dev');
  assert.equal(loadConfig({ ...PROD_ENV, OFFICEPULSE_INSTANCE_ID: 'pbx.site-1_A' }).officePulseInstanceId, 'pbx.site-1_A');
  for (const id of ['bad id', 'x'.repeat(81), 'op/1', 'op:1']) assert.throws(() => loadConfig({ ...PROD_ENV, OFFICEPULSE_INSTANCE_ID: id }), /OFFICEPULSE_INSTANCE_ID must match/, id);
  assert.throws(() => loadConfig({ ...PROD_ENV, OFFICEPULSE_INSTANCE_ID: '' }), /OFFICEPULSE_INSTANCE_ID is required/);
});

test('the former PBX database setting names still work, and the PBX_DB_* names win', () => {
  const former = { ...PROD_ENV, PBX_DB_HOST: undefined, PBX_DB_NAME: undefined, MYSQL_HOST: 'old-pbx', MYSQL_PORT: '3307', MYSQL_DATABASE: 'asterisk_old',
    PBX_DB_INVENTORY_USER: undefined, PBX_DB_INVENTORY_PASSWORD: undefined, PBX_DB_PROVISIONING_USER: undefined, PBX_DB_PROVISIONING_PASSWORD: undefined,
    PBX_INVENTORY_MYSQL_USER: 'old_ro', PBX_INVENTORY_MYSQL_PASSWORD: 'old-ro-pw',
    PBX_PROVISIONING_MYSQL_USER: 'old_writer', PBX_PROVISIONING_MYSQL_PASSWORD: 'old-writer-pw' };
  const config = loadConfig(former);
  assert.deepEqual(config.pbxInventoryMysql, { host: 'old-pbx', port: 3307, database: 'asterisk_old', user: 'old_ro', password: 'old-ro-pw' });
  assert.deepEqual(config.pbxProvisioningMysql, { host: 'old-pbx', port: 3307, database: 'asterisk_old', user: 'old_writer', password: 'old-writer-pw' });
  const both = loadConfig({ ...former, PBX_DB_HOST: 'new-pbx', PBX_DB_INVENTORY_USER: 'new_ro' });
  assert.equal(both.pbxInventoryMysql?.host, 'new-pbx');
  assert.equal(both.pbxInventoryMysql?.user, 'new_ro');
  assert.equal(both.pbxProvisioningMysql?.user, 'old_writer');
});

test('PBX writer cannot reuse inventory or runtime account names', () => {
  for (const user of ['aida_runtime', 'inventory_ro']) {
    assert.throws(() => loadConfig({ ...PROD_ENV, PBX_DB_PROVISIONING_USER: user }), /dedicated account/);
  }
});

test('environment naming accepts permanent matching names and refuses mismatches or temporary names', () => {
  for (const name of ['dev', 'staging', 'prod']) assert.equal(loadConfig({ ENVIRONMENT_NAME: name, OFFICEPULSE_INSTANCE_ID: `officepulse-${name}` }).environmentName, name);
  for (const id of ['dockerappvm01-dev-preview', 'officepulse-prod', 'COPY-dev', 'temp-dev', 'tmp-dev', 'backup-dev', 'test-dev']) {
    assert.throws(() => loadConfig({ ENVIRONMENT_NAME: 'dev', OFFICEPULSE_INSTANCE_ID: id }), new RegExp(`OFFICEPULSE_INSTANCE_ID '${id}'.*ENVIRONMENT_NAME 'dev'`));
  }
  assert.equal(loadConfig({ OFFICEPULSE_INSTANCE_ID: 'legacy-preview' }).environmentName, undefined);
  assert.throws(() => loadConfig({ ENVIRONMENT_NAME: 'unknown' }), /ENVIRONMENT_NAME must/);
  assert.equal(loadConfig({}).handset.requirePublicIpMatch, true);
  assert.equal(loadConfig({}).handset.tokenTtlSeconds, 86400);
  assert.throws(() => loadConfig({ HANDSET_TOKEN_TTL_SECONDS: '999999' }), /HANDSET_TOKEN_TTL_SECONDS/);
});
