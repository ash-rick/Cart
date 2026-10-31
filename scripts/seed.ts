import 'dotenv/config';
import { redact, requireDatabaseUrl, seed } from './dbtools';

const url = requireDatabaseUrl();
await seed(url);
console.log(`Seeded ${redact(url)}`);
