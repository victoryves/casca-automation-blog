#!/usr/bin/env tsx

import pg from 'pg';
import fs from 'fs';

const connectionString = `postgresql://postgres.mrlsngxobwpreqlwwemi:vBKqkTybmOxy28PH@aws-0-sa-east-1.pooler.supabase.com:6543/postgres`;

async function main() {
  // Try multiple regions
  const regions = ['sa-east-1', 'us-east-1', 'us-west-1', 'eu-west-1', 'eu-central-1', 'ap-southeast-1'];

  for (const region of regions) {
    const connStr = `postgresql://postgres.mrlsngxobwpreqlwwemi:vBKqkTybmOxy28PH@aws-0-${region}.pooler.supabase.com:6543/postgres`;
    console.log(`Trying region: ${region}...`);

    try {
      const client = new pg.Client({ connectionString: connStr, connectionTimeoutMillis: 10000 });
      await client.connect();
      console.log(`Connected via ${region}!`);

      const schema = fs.readFileSync('./supabase-schema.sql', 'utf-8');
      await client.query(schema);
      console.log('Tables created successfully!');

      // Verify
      const res = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
      console.log('Tables:', res.rows.map((r: any) => r.table_name));

      await client.end();
      return;
    } catch (err: any) {
      console.log(`  Failed: ${err.message}`);
    }
  }

  // Try direct connection
  console.log('\nTrying direct connection...');
  try {
    const client = new pg.Client({
      connectionString: `postgresql://postgres:vBKqkTybmOxy28PH@db.mrlsngxobwpreqlwwemi.supabase.co:5432/postgres`,
      connectionTimeoutMillis: 10000,
    });
    await client.connect();
    console.log('Connected directly!');

    const schema = fs.readFileSync('./supabase-schema.sql', 'utf-8');
    await client.query(schema);
    console.log('Tables created!');
    await client.end();
  } catch (err: any) {
    console.log(`Direct connection failed: ${err.message}`);
    console.log('\nPlease create tables manually via Supabase SQL Editor:');
    console.log('https://supabase.com/dashboard/project/mrlsngxobwpreqlwwemi/sql/new');
  }
}

main().catch(console.error);
