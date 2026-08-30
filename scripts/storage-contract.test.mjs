/**
 * Storage contract tests.
 *
 * These pin down the behaviour that broke on Vercel:
 *
 *   1. Postgres is the single source of truth for menu items and orders.
 *   2. An unreachable database makes the app FAIL LOUDLY (503 + actionable
 *      hint) instead of silently serving a per-instance local JSON file — the
 *      bug that made data "disappear and reappear".
 *   3. Deleting a menu item stays deleted across cold starts (the starter seed
 *      runs once per database, not once per boot).
 *
 * Each scenario runs in its own process (the store reads env at module load and
 * is a singleton). Postgres scenarios run against a real, throwaway Postgres
 * started by `embedded-postgres`.
 *
 *   npm run test:storage
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scenarioFile = path.join(repoRoot, 'scripts', 'storage-scenario.ts');

/** Port nothing else in this sandbox uses. */
const PG_PORT = 55432;
const PG_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/restaurant`;
/** Guaranteed to refuse connections instantly. */
const DEAD_PG_URL = 'postgresql://user:pass@127.0.0.1:55999/none';

let pg = null;

/** Starts one throwaway Postgres for the whole file. */
async function startPostgres() {
  if (pg) return pg;
  pg = new EmbeddedPostgres({
    databaseDir: path.join(os.tmpdir(), `nagori-pgdata-${process.pid}`),
    user: 'postgres',
    password: 'postgres',
    port: PG_PORT,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('restaurant');
  return pg;
}

/**
 * Store data files, ignoring `admin.json` — admin credentials are deliberately
 * local (see data/README.md) and are not part of the app-data store.
 */
function storeFilesIn(dataDir) {
  return fs.readdirSync(dataDir).filter((entry) => entry !== 'admin.json');
}

/** Runs a scenario in a child process and returns its JSON result. */
function runScenario({ scenario, env = {}, arg, timeoutMs = 90_000 }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagori-store-'));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', scenarioFile], {
      cwd: repoRoot,
      env: {
        ...process.env,
        // Start from a clean slate: no VERCEL, no NODE_ENV, no DATABASE_URL.
        VERCEL: '',
        NODE_ENV: '',
        DATABASE_URL: '',
        DIRECT_URL: '',
        ALLOW_LOCAL_FILE_FALLBACK: '',
        DATA_DIR: dataDir,
        SCENARIO: scenario,
        SCENARIO_ARG: arg ? JSON.stringify(arg) : '',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));

    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      const line = stdout.split('\n').find((entry) => entry.startsWith('__RESULT__ '));
      if (!line) {
        reject(new Error(`Scenario "${scenario}" produced no result (exit ${code}).\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
        return;
      }
      try {
        resolve({ result: JSON.parse(line.slice('__RESULT__ '.length)), stdout, stderr, dataDir });
      } catch (error) {
        reject(new Error(`Scenario "${scenario}" returned invalid JSON: ${error.message}\n${line}`));
      }
    });
  });
}

test('production + unreachable database fails loudly and never touches a local file', async () => {
  const { result, dataDir } = await runScenario({
    scenario: 'prod-db-down',
    env: {
      VERCEL: '1',
      DATABASE_URL: DEAD_PG_URL,
      ADMIN_PASSWORD: 'contract-test-password',
      ADMIN_SESSION_SECRET: 'contract-test-session-secret',
    },
  });

  assert.equal(result.storageMode, 'postgres', 'Postgres must be the only allowed store in production');
  assert.equal(result.failingLoudly, true);
  assert.equal(result.localFileFallbackActive, false);
  assert.equal(result.postgresStatus, 'unavailable');

  // The core regression: reads and writes throw instead of silently using a
  // per-instance /tmp file that makes data appear and disappear.
  assert.equal(result.readThrew, true, 'a read must throw when the required database is down');
  assert.equal(result.readErrorIsPostgresUnavailable, true);
  assert.equal(result.readErrorCode, 'POSTGRES_UNAVAILABLE');
  assert.equal(result.readErrorHasHint, true, 'the error must carry an actionable fix hint');
  assert.equal(result.writeThrew, true, 'a write must throw rather than pretend to succeed');

  // No local JSON file may ever be created in production.
  assert.equal(result.fileCreated, false, 'no local data file may be created when Postgres is required');
  assert.deepEqual(storeFilesIn(dataDir), [], 'no store data may be written to the local data directory');

  // The HTTP layer must surface this as 503 + hint, not 500 and not 200.
  assert.equal(result.httpStatus, 503, 'an unreachable database must answer 503, never 200 with stale local data');
  assert.equal(result.httpCode, 'POSTGRES_UNAVAILABLE');
  assert.equal(result.httpHasHint, true, 'the 503 body must carry the actionable fix hint');
  assert.equal(result.publicStatus, 503, 'the public customer menu must fail loudly too');
  assert.equal(result.publicCode, 'POSTGRES_UNAVAILABLE');
});

test('production with no DATABASE_URL at all fails loudly', async () => {
  const { result, dataDir } = await runScenario({
    scenario: 'prod-no-database-url',
    env: { VERCEL: '1' },
  });

  assert.equal(result.storageMode, 'postgres');
  assert.equal(result.failingLoudly, true);
  assert.equal(result.readThrew, true);
  assert.equal(result.readErrorIsPostgresUnavailable, true);
  assert.match(String(result.readErrorMessage), /DATABASE_URL/i);
  assert.equal(result.fileCreated, false, 'no local file fallback in production, ever');
  assert.deepEqual(storeFilesIn(dataDir), []);
});

test('development fallback still works but is logged as an error, not silently', async () => {
  const { result } = await runScenario({
    scenario: 'dev-fallback-loud',
    env: { ALLOW_LOCAL_FILE_FALLBACK: 'true', DATABASE_URL: DEAD_PG_URL },
  });

  assert.equal(result.storageMode, 'postgres-with-file-fallback');
  assert.equal(result.provider, 'file');
  assert.equal(result.localFileFallbackActive, true);
  assert.equal(result.fallingBackLoggedAsError, true, 'the fallback must be logged at error level');
  assert.equal(result.fallingBackLoggedAsPlainLog, false, 'the fallback must not be a quiet console.log');
  assert.ok(result.productCount > 0);
  assert.equal(result.fileCreated, true);
});

test('local development without DATABASE_URL uses the file store quietly', async () => {
  const { result } = await runScenario({ scenario: 'dev-file-store' });

  assert.equal(result.storageMode, 'file');
  assert.equal(result.provider, 'file');
  assert.equal(result.failingLoudly, false);
  assert.equal(result.localFileFallbackActive, false);
  assert.ok(result.productCount > 0);
});

test('menu items and orders persist through one Postgres store across instances', async () => {
  await startPostgres();

  // Instance A: write a product, place an order, delete a seeded menu item.
  const write = await runScenario({
    scenario: 'pg-write',
    env: { DATABASE_URL: PG_URL, VERCEL: '1' },
  });
  assert.equal(write.result.error, undefined, JSON.stringify(write.result));
  assert.equal(write.result.provider, 'postgres');
  assert.equal(write.result.postgresStatus, 'connected');
  assert.equal(write.result.hadSeededSamosa, true, 'the starter seed should have run on the fresh database');
  assert.ok(write.result.orderNumber > 1040, 'order numbers must come from the database counter');
  assert.deepEqual(
    write.result.dataDirContents,
    [],
    'Postgres mode must not write anything to the local data directory'
  );

  // Instance B: a different process (a cold start on another Vercel instance).
  const verify = await runScenario({
    scenario: 'pg-verify',
    env: { DATABASE_URL: PG_URL, VERCEL: '1' },
    arg: { productId: write.result.productId, deletedSeededId: 'prod-samosa' },
  });
  assert.equal(verify.result.error, undefined, JSON.stringify(verify.result));
  assert.equal(verify.result.provider, 'postgres');
  assert.equal(verify.result.postgresStatus, 'connected');

  // Reads and writes really are shared, not per-instance.
  assert.equal(verify.result.wroteProductVisible, true, 'a product written by another instance must be readable');

  // THE regression test: the starter seed used to re-run on every cold start
  // and resurrect deleted menu items.
  assert.equal(
    verify.result.deletedSeededItemResurrected,
    false,
    'a deleted seeded menu item must stay deleted across cold starts'
  );

  // The order counter is shared too, so it keeps increasing across instances.
  assert.ok(
    verify.result.orderNumber > write.result.orderNumber,
    'the order counter must be shared through the database, not per instance'
  );
  assert.deepEqual(verify.result.dataDirContents, [], 'no local file may be used when Postgres is configured');
});

test.after(async () => {
  if (pg) await pg.stop();
});
