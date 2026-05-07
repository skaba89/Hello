#!/usr/bin/env node
/**
 * add-prospect.js – Import de prospects depuis un CSV ou en ligne de commande
 * Usage :
 *   node scripts/add-prospect.js --csv prospects.csv
 *   node scripts/add-prospect.js --json '{"first_name":"Marie","company":"TechCorp","linkedin_url":"..."}'
 */

'use strict';

const { Client } = require('pg');
const fs = require('fs');
const readline = require('readline');
const path = require('path');

// Charger .env
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [key, ...rest] = line.split('=');
    if (key && rest.length) process.env[key.trim()] = rest.join('=').trim().replace(/^"|"$/g, '');
  });
}

const dbConfig = {
  host: 'localhost',
  port: 5432,
  database: process.env.POSTGRES_DB || 'automation_db',
  user: process.env.POSTGRES_USER || 'automation',
  password: process.env.POSTGRES_PASSWORD,
};

async function importProspect(client, prospect) {
  const {
    first_name, last_name = null, company = null, title = null,
    linkedin_url = null, instagram_username = null, platform = 'linkedin',
    source = 'manual', profile_score = 0, public_fact = null,
  } = prospect;

  if (!first_name) throw new Error('first_name est obligatoire');

  const result = await client.query(
    `INSERT INTO prospects
       (first_name, last_name, company, title, linkedin_url, instagram_username, platform, source, profile_score, public_fact)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (linkedin_url) DO UPDATE SET
       updated_at = NOW(),
       company = EXCLUDED.company,
       title = EXCLUDED.title
     RETURNING id, first_name, last_name`,
    [first_name, last_name, company, title, linkedin_url, instagram_username, platform, source, profile_score, public_fact]
  );

  return result.rows[0];
}

async function processCsv(client, csvFile) {
  const fileStream = fs.createReadStream(csvFile);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let headers = null;
  let imported = 0;
  let errors = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;

    const values = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));

    if (!headers) {
      headers = values;
      console.log('Colonnes détectées:', headers.join(', '));
      continue;
    }

    const prospect = {};
    headers.forEach((h, i) => { prospect[h] = values[i] || null; });

    try {
      const result = await importProspect(client, prospect);
      imported++;
      console.log(`✓ Importé : ${result.first_name} ${result.last_name || ''} (ID: ${result.id})`);
    } catch (e) {
      errors++;
      console.error(`✗ Erreur ligne ${imported + errors}: ${e.message}`);
    }
  }

  console.log(`\nImport terminé : ${imported} succès, ${errors} erreurs`);
}

async function main() {
  const args = process.argv.slice(2);
  const client = new Client(dbConfig);

  try {
    await client.connect();
    console.log('Connecté à PostgreSQL');

    const csvIdx = args.indexOf('--csv');
    const jsonIdx = args.indexOf('--json');

    if (csvIdx !== -1 && args[csvIdx + 1]) {
      await processCsv(client, args[csvIdx + 1]);
    } else if (jsonIdx !== -1 && args[jsonIdx + 1]) {
      const prospect = JSON.parse(args[jsonIdx + 1]);
      const result = await importProspect(client, prospect);
      console.log('Prospect ajouté:', result);
    } else {
      console.log('Usage:');
      console.log('  node scripts/add-prospect.js --csv prospects.csv');
      console.log('  node scripts/add-prospect.js --json \'{"first_name":"Marie","company":"TechCorp","linkedin_url":"..."}\' ');
      process.exit(1);
    }
  } catch (err) {
    console.error('Erreur:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
