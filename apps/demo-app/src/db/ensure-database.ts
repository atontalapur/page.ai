import pg from 'pg';

/**
 * Creates the database named in `url` if it is missing, so the demo app can share the
 * local Postgres server with the orchestrator without sharing its tables.
 * Returns true when it created one.
 */
export async function ensureDatabase(url: string): Promise<boolean> {
  try {
    const probe = new pg.Client({ connectionString: url });
    await probe.connect();
    await probe.end();
    return false;
  } catch (err) {
    // 3D000: invalid_catalog_name, the database does not exist.
    if ((err as { code?: string }).code !== '3D000') throw err;
  }

  const admin = new URL(url);
  const name = decodeURIComponent(admin.pathname.slice(1));
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    await client.query(`create database ${client.escapeIdentifier(name)}`);
    return true;
  } finally {
    await client.end();
  }
}
