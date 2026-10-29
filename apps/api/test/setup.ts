import { existsSync } from 'node:fs';
import path from 'node:path';

const envFile = path.resolve(import.meta.dirname, '../../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
// Integration tests ALWAYS use the test database.
process.env.DB_NAME = 'tradecore_test';
process.env.NODE_ENV = 'test';
