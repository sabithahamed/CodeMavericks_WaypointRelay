import { pool } from '../db.js';
import { seedAll } from './seed.js';

await seedAll();
console.log('Seed complete.');
await pool.end();
