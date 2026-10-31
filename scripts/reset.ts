import 'dotenv/config';
import { redact, requireDatabaseUrl, reset } from './dbtools';

const url = requireDatabaseUrl();
await reset(url);
console.log(`Reset ${redact(url)}: schema dropped, migrated, seeded`);
