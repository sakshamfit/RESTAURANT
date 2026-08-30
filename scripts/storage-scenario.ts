/**
 * One storage scenario, executed in a freshly-spawned process.
 *
 * The store reads its configuration from `process.env` at module load and is a
 * module-level singleton, so every scenario has to run in its own process.
 * `scripts/storage-contract.test.mjs` spawns this file with the right env and
 * asserts on the JSON printed on the `__RESULT__ ` line.
 *
 * Run a single scenario by hand:
 *   SCENARIO=prod-db-down npx tsx scripts/storage-scenario.ts
 */
import fs from 'fs';
import path from 'path';

type Result = Record<string, unknown>;

function emit(result: Result) {
  console.log(`__RESULT__ ${JSON.stringify(result)}`);
}

/** Path of the local JSON file for a given DATA_DIR. */
function dataFileFor(dataDir: string) {
  return path.join(dataDir, 'restaurant.json');
}

/**
 * Production + unreachable database must fail loudly and must never touch the
 * local file.
 */
async function scenarioProdDbDown(): Promise<Result> {
  const dataDir = String(process.env.DATA_DIR);
  const { store, PostgresUnavailableError } = await import('../src/server/store.js');
  const { createApp } = await import('../src/server/app.js');

  await store.waitUntilReady();

  const diagnostics = store.getDiagnostics();

  // 1. Reads must throw, not silently return a local-file menu.
  let readError: { name: string; code: string; message: string; hint?: string } | null = null;
  try {
    await store.list('products');
  } catch (error) {
    readError = {
      name: (error as Error).name,
      code: (error as { code?: string }).code || '',
      message: (error as Error).message,
      hint: (error as { hint?: string }).hint,
    };
  }

  // 2. Writes must throw too — a failed write must never look like a success.
  let writeError: string | null = null;
  try {
    await store.put('orders', { id: 'order-should-not-persist' } as never);
  } catch (error) {
    writeError = (error as { code?: string }).code || (error as Error).name;
  }

  // 3. No local file may be created (that is the per-instance data trap).
  const fileCreated = fs.existsSync(dataFileFor(dataDir));

  // 4. The HTTP layer must answer 503 with the actionable hint, not 500 and
  //    not 200 with phantom local data. This walks the real deployed request
  //    path: bootstrap admin auth, log in, then hit an admin route.
  const { initAdminAuth } = await import('../src/server/auth.js');
  await initAdminAuth();

  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  let httpStatus = 0;
  let httpCode: string | null = null;
  let httpHint: string | null = null;
  let publicStatus = 0;
  let publicCode: string | null = null;
  try {
    const login = await fetch(`${base}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: process.env.ADMIN_PASSWORD }),
    });
    const loginBody = (await login.json()) as { token?: string };

    const res = await fetch(`${base}/api/admin/products`, {
      headers: { authorization: `Bearer ${loginBody.token}` },
    });
    httpStatus = res.status;
    const body = (await res.json()) as Record<string, unknown>;
    httpCode = (body.code as string) ?? null;
    httpHint = (body.hint as string) ?? null;

    // The public menu route is what customers hit — it must fail the same way
    // rather than serving a stale local menu.
    const publicRes = await fetch(`${base}/api/public/tables`);
    publicStatus = publicRes.status;
    publicCode = ((await publicRes.json()) as Record<string, unknown>).code as string ?? null;
  } finally {
    server.close();
  }

  return {
    storageMode: diagnostics.storageMode,
    provider: diagnostics.provider,
    failingLoudly: diagnostics.failingLoudly,
    localFileFallbackActive: diagnostics.localFileFallbackActive,
    postgresStatus: diagnostics.postgresStatus,
    readThrew: Boolean(readError),
    readErrorName: readError?.name || null,
    readErrorCode: readError?.code || null,
    readErrorIsPostgresUnavailable: readError ? readError.name === PostgresUnavailableError.name : false,
    readErrorHasHint: Boolean(readError?.hint),
    writeThrew: Boolean(writeError),
    writeErrorCode: writeError,
    fileCreated,
    httpStatus,
    httpCode,
    httpHasHint: Boolean(httpHint),
    publicStatus,
    publicCode,
  };
}

/** Production with no DATABASE_URL at all must also fail loudly. */
async function scenarioProdNoDatabaseUrl(): Promise<Result> {
  const dataDir = String(process.env.DATA_DIR);
  const { store, PostgresUnavailableError } = await import('../src/server/store.js');
  await store.waitUntilReady();

  let readError: { name: string; message: string } | null = null;
  try {
    await store.list('products');
  } catch (error) {
    readError = { name: (error as Error).name, message: (error as Error).message };
  }

  return {
    storageMode: store.getDiagnostics().storageMode,
    provider: store.getDiagnostics().provider,
    failingLoudly: store.getDiagnostics().failingLoudly,
    readThrew: Boolean(readError),
    readErrorIsPostgresUnavailable: readError?.name === PostgresUnavailableError.name,
    readErrorMessage: readError?.message || null,
    fileCreated: fs.existsSync(dataFileFor(dataDir)),
  };
}

/** Development fallback: allowed, but it must be LOUD (console.error). */
async function scenarioDevFallbackLoud(): Promise<Result> {
  const dataDir = String(process.env.DATA_DIR);
  const errorLines: string[] = [];
  const logLines: string[] = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...args: unknown[]) => {
    errorLines.push(args.map(String).join(' '));
  };
  console.log = (...args: unknown[]) => {
    logLines.push(args.map(String).join(' '));
  };

  try {
    const { store } = await import('../src/server/store.js');
    await store.waitUntilReady();
    const products = await store.list('products');
    const diagnostics = store.getDiagnostics();
    return {
      storageMode: diagnostics.storageMode,
      provider: diagnostics.provider,
      localFileFallbackActive: diagnostics.localFileFallbackActive,
      fallingBackLoggedAsError: errorLines.some((line) => line.includes('FALLING BACK TO THE LOCAL FILE')),
      fallingBackLoggedAsPlainLog: logLines.some((line) => line.includes('local file')),
      productCount: products.length,
      fileCreated: fs.existsSync(dataFileFor(dataDir)),
    };
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
}

/** Local development with no DATABASE_URL: plain file store, no drama. */
async function scenarioDevFileStore(): Promise<Result> {
  const dataDir = String(process.env.DATA_DIR);
  const { store } = await import('../src/server/store.js');
  await store.waitUntilReady();
  const products = await store.list('products');
  const diagnostics = store.getDiagnostics();
  return {
    storageMode: diagnostics.storageMode,
    provider: diagnostics.provider,
    failingLoudly: diagnostics.failingLoudly,
    localFileFallbackActive: diagnostics.localFileFallbackActive,
    productCount: products.length,
    fileCreated: fs.existsSync(dataFileFor(dataDir)),
  };
}

/**
 * Against a real database: write through the store, delete a *seeded* menu
 * item, and confirm nothing is written to a local file.
 */
async function scenarioPgWrite(): Promise<Result> {
  const dataDir = String(process.env.DATA_DIR);
  const { store } = await import('../src/server/store.js');
  await store.waitUntilReady();
  const diagnostics = store.getDiagnostics();

  const seededIds: string[] = (await store.list('products')).map((product) => product.id);
  const hadSeededSamosa = seededIds.includes('prod-samosa');

  // Delete a seeded item — this is what used to be resurrected on cold start.
  if (hadSeededSamosa) await store.remove('products', 'prod-samosa');

  const { newId } = await import('../src/server/store.js');
  const productId = newId('prod');
  await store.put('products', {
    id: productId,
    name: 'Contract Test Lassi',
    description: 'Written by the storage contract test.',
    category: 'Cold Drinks & Water',
    image: '',
    isAvailable: true,
    isVeg: true,
    hasVariants: false,
    basePrice: 42,
    displayOrder: 999,
  } as never);

  const orderNumber = await store.nextOrderNumber();

  return {
    provider: diagnostics.provider,
    storageMode: diagnostics.storageMode,
    postgresStatus: diagnostics.postgresStatus,
    hadSeededSamosa,
    productId,
    orderNumber,
    // The whole point: with Postgres configured the local file is never used.
    dataDirContents: fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : [],
  };
}

/**
 * A second process against the same database — i.e. a different serverless
 * instance / a cold start. Everything written by `pg-write` must still be
 * there, and the deleted seeded item must STAY deleted.
 */
async function scenarioPgVerify(expected: { productId: string; deletedSeededId: string }) {
  const dataDir = String(process.env.DATA_DIR);
  const { store } = await import('../src/server/store.js');
  await store.waitUntilReady();
  const diagnostics = store.getDiagnostics();

  const products = await store.list('products');
  const orderNumber = await store.nextOrderNumber();

  return {
    provider: diagnostics.provider,
    postgresStatus: diagnostics.postgresStatus,
    productCount: products.length,
    wroteProductVisible: products.some((product) => product.id === expected.productId),
    // THE regression: this was `true` before, because every cold start re-ran
    // the starter seed and put deleted menu items back.
    deletedSeededItemResurrected: products.some((product) => product.id === expected.deletedSeededId),
    orderNumber,
    dataDirContents: fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : [],
  };
}

const scenarios: Record<string, (arg?: never) => Promise<Result>> = {
  'prod-db-down': scenarioProdDbDown,
  'prod-no-database-url': scenarioProdNoDatabaseUrl,
  'dev-fallback-loud': scenarioDevFallbackLoud,
  'dev-file-store': scenarioDevFileStore,
  'pg-write': scenarioPgWrite,
};

async function main() {
  const name = process.env.SCENARIO || '';
  if (name === 'pg-verify') {
    emit(await scenarioPgVerify(JSON.parse(process.env.SCENARIO_ARG || '{}')));
    return;
  }
  const scenario = scenarios[name];
  if (!scenario) {
    emit({ error: `Unknown scenario "${name}"` });
    process.exitCode = 1;
    return;
  }
  emit(await scenario());
}

main().catch((error) => {
  emit({ error: (error as Error)?.message || String(error) });
  process.exitCode = 1;
});
