import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sql = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');

await pool.query(sql);
await pool.query(fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'conversion.sql'), 'utf8'));
console.log('Schema applied.');
await pool.end();
