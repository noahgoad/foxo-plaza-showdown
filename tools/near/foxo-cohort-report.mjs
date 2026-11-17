import { DatabaseSync } from 'node:sqlite';
import { productCohortReport } from '../../server/near/product-telemetry.mjs';

const file = process.argv[2] ?? 'outputs/near-economy.sqlite';
const database = new DatabaseSync(file, { readOnly: true });
try {
  console.log(JSON.stringify(productCohortReport(database), null, 2));
} finally {
  database.close();
}
