/** npm run check:invariants — verifies the ledger in the database (DB_NAME, default tradecore). */
import { createPool } from '@tradecore/shared/node';
import { checkInvariants } from '../apps/api/src/trading/invariants';

const pool = createPool(process.env.DB_NAME);
const report = await checkInvariants(pool);
for (const r of report.results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name.padEnd(30)} ${r.explain}`);
  if (!r.ok) console.log('   violations:', JSON.stringify(r.violations.slice(0, 5)));
}
console.log(report.ok ? '\nAll invariants hold.' : '\nINVARIANT VIOLATIONS FOUND');
await pool.end();
process.exit(report.ok ? 0 : 1);
