import 'dotenv/config';
import { migrate, redact, requireDatabaseUrl } from './dbtools';

const url = requireDatabaseUrl();
const applied = await migrate(url);
console.log(`Migrated ${redact(url)}: ${applied.length ? applied.join(', ') : 'already up to date'}`);
