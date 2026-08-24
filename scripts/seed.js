import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { one, query, pool } from '../src/db/index.js';
import { generatePrompts } from '../src/lib/prompts.js';
import { hasAnthropic } from '../src/lib/anthropic.js';

/**
 * Seeds the first account and the Sandstorm Digital project.
 * Edit the CONFIG block to point at any other domain.
 */

const CONFIG = {
  orgName: 'Sandstorm Digital',
  email: process.env.SEED_EMAIL || 'you@sandstormdigital.com',
  password: process.env.SEED_PASSWORD || 'changeme123',

  project: {
    name: 'Sandstorm Digital',
    domain: 'sandstormdigital.com',
    brand: 'Sandstorm Digital',
    aliases: ['Sandstorm', 'Sandstorm Digital Ltd'],
    market: 'GB',
    language: 'en',
    category: 'SEO and digital marketing agency',
    qualifier: 'UK small and mid-sized business',
    runsPerCycle: 1
  },

  // Swap these for the businesses you actually lose deals to.
  competitors: []
};

async function main() {
  let org = await one('SELECT * FROM orgs WHERE name = $1', [CONFIG.orgName]);
  if (!org) org = await one('INSERT INTO orgs (name) VALUES ($1) RETURNING *', [CONFIG.orgName]);

  let user = await one('SELECT * FROM users WHERE email = $1', [CONFIG.email.toLowerCase()]);
  if (!user) {
    const hash = await bcrypt.hash(CONFIG.password, 10);
    // Verified on creation: a fresh install must be able to run a cycle
    // straight after seeding, and there is nobody to click a link.
    user = await one(
      `INSERT INTO users (org_id, email, password_hash, email_verified_at)
       VALUES ($1,$2,$3,now()) RETURNING *`,
      [
        org.id,
        CONFIG.email.toLowerCase(),
        hash
      ]
    );
    console.log(`Created login: ${CONFIG.email} / ${CONFIG.password}`);
  } else {
    console.log(`Login already exists: ${CONFIG.email}`);
  }

  let project = await one('SELECT * FROM projects WHERE org_id = $1 AND domain = $2', [org.id, CONFIG.project.domain]);
  if (!project) {
    project = await one(
      `INSERT INTO projects (org_id, name, domain, brand_name, aliases, market, language, runs_per_cycle)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        org.id,
        CONFIG.project.name,
        CONFIG.project.domain,
        CONFIG.project.brand,
        CONFIG.project.aliases,
        CONFIG.project.market,
        CONFIG.project.language,
        CONFIG.project.runsPerCycle
      ]
    );
    console.log(`Created project ${project.name} (#${project.id})`);
  }

  await query(
    `INSERT INTO entities (project_id, name, domain, kind, aliases)
     VALUES ($1,$2,$3,'owned',$4) ON CONFLICT (project_id, name) DO NOTHING`,
    [project.id, CONFIG.project.brand, CONFIG.project.domain, CONFIG.project.aliases]
  );

  for (const c of CONFIG.competitors) {
    await query(
      `INSERT INTO entities (project_id, name, domain, kind)
       VALUES ($1,$2,$3,'competitor') ON CONFLICT (project_id, name) DO NOTHING`,
      [project.id, c.name, c.domain]
    );
  }

  const existing = await one('SELECT COUNT(*)::int AS n FROM prompts WHERE project_id = $1', [project.id]);
  if (existing.n === 0) {
    console.log(hasAnthropic ? 'Generating prompt set with Claude...' : 'No ANTHROPIC_API_KEY, using template prompts.');
    const prompts = await generatePrompts({
      brand: CONFIG.project.brand,
      domain: CONFIG.project.domain,
      category: CONFIG.project.category,
      market: 'the UK',
      qualifier: CONFIG.project.qualifier,
      count: 20
    });
    for (const p of prompts) {
      await query(
        `INSERT INTO prompts (project_id, text, cluster, intent, ai_search_volume)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (project_id, text) DO NOTHING`,
        [project.id, p.text, p.cluster, p.intent, p.ai_search_volume]
      );
    }
    console.log(`Added ${prompts.length} prompts.`);
  } else {
    console.log(`${existing.n} prompts already present.`);
  }

  console.log('\nSeed complete. Next: npm run cycle');
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
