/** Creates the tradecore and tradecore_test databases if they don't exist. Never drops anything. */
import pg from 'pg';
import { pgConfig } from '@tradecore/shared/node';

const client = new pg.Client(pgConfig('postgres'));
await client.connect();
for (const db of ['tradecore', 'tradecore_test']) {
  const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [db]);
  if (rowCount) console.log(`✓ database ${db} already exists`);
  else {
    await client.query(`CREATE DATABASE ${db} ENCODING 'UTF8' TEMPLATE template0`);
    console.log(`+ created database ${db}`);
  }
}
await client.end();
