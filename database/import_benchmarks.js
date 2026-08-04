#!/usr/bin/env node
/**
 * StanceAI — Benchmark Importer
 * ================================
 * Reads benchmarks.csv and bulk-upserts all rows into Supabase
 * shot_benchmarks table using the supabase-js client.
 *
 * Usage (run from project root):
 *   node database/import_benchmarks.js
 *
 * Requirements:
 *   - frontend/.env must contain VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
 *   - schema.sql must have been run in Supabase SQL Editor first
 *   - node must be available (uses native fetch, Node 18+)
 *
 * The script uses ON CONFLICT (shot_type, joint_name) DO UPDATE
 * so it is safe to run multiple times — it won't create duplicates.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync }  from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ─── Resolve paths ────────────────────────────────────────────────────────────
const __dirname  = dirname(fileURLToPath(import.meta.url));
const CSV_PATH   = resolve(__dirname, 'benchmarks.csv');
const ENV_PATH   = resolve(__dirname, '../frontend/.env');

// ─── Load environment variables from frontend/.env ───────────────────────────
function loadEnv(envPath) {
  const raw = readFileSync(envPath, 'utf-8');
  const vars = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key   = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    vars[key] = value;
  }
  return vars;
}

// ─── Parse CSV ────────────────────────────────────────────────────────────────
function parseCSV(csvText) {
  const lines = csvText.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim());

  return lines.slice(1).map(line => {
    // Handle quoted fields containing commas
    const fields = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        fields.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    fields.push(current.trim());

    const row = {};
    headers.forEach((h, i) => {
      row[h] = fields[i] ?? '';
    });
    return row;
  });
}

// ─── Transform CSV row → Supabase row ─────────────────────────────────────────
function transformRow(csvRow) {
  return {
    shot_type:           csvRow.shot_type.trim().toUpperCase(),
    joint_name:          csvRow.joint_name.trim().toUpperCase(),
    landmark_a:          csvRow.landmark_a.trim().toUpperCase(),
    landmark_b:          csvRow.landmark_b.trim().toUpperCase(),
    landmark_c:          csvRow.landmark_c.trim().toUpperCase(),
    optimal_angle_min:   parseFloat(csvRow.optimal_angle_min),
    optimal_angle_max:   parseFloat(csvRow.optimal_angle_max),
    warning_tolerance:   parseFloat(csvRow.warning_tolerance),
    critical_tolerance:  parseFloat(csvRow.critical_tolerance),
    description:         csvRow.description.trim(),
    source_reference:    csvRow.source_reference.trim(),
    is_active:           true,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🏏 StanceAI Benchmark Importer\n' + '─'.repeat(40));

  // Load env
  let env;
  try {
    env = loadEnv(ENV_PATH);
    console.log(`✅ Loaded env from ${ENV_PATH}`);
  } catch (e) {
    console.error(`❌ Could not read frontend/.env:\n   ${e.message}`);
    process.exit(1);
  }

  const supabaseUrl = env.VITE_SUPABASE_URL;
  const supabaseKey = env.VITE_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('❌ VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY not found in frontend/.env');
    process.exit(1);
  }

  // Init Supabase
  const supabase = createClient(supabaseUrl, supabaseKey);
  console.log(`✅ Supabase client initialised → ${supabaseUrl}`);

  // Load CSV
  let rows;
  try {
    const csvText = readFileSync(CSV_PATH, 'utf-8');
    rows = parseCSV(csvText).map(transformRow);
    console.log(`✅ Parsed ${rows.length} benchmark rows from benchmarks.csv`);
  } catch (e) {
    console.error(`❌ Could not read benchmarks.csv:\n   ${e.message}`);
    process.exit(1);
  }

  // Preview
  console.log('\n📊 Shots covered:');
  const shotGroups = {};
  for (const row of rows) {
    shotGroups[row.shot_type] = (shotGroups[row.shot_type] || 0) + 1;
  }
  for (const [shot, count] of Object.entries(shotGroups)) {
    console.log(`   ${shot.padEnd(20)} ${count} joint(s)`);
  }

  // Upsert in batches of 10
  const BATCH_SIZE = 10;
  let inserted = 0;
  let failed   = 0;

  console.log('\n⬆️  Uploading to Supabase...');

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('shot_benchmarks')
      .upsert(batch, {
        onConflict:        'shot_type,joint_name',
        ignoreDuplicates:  false,  // update existing rows with new values
      });

    if (error) {
      console.error(`   ❌ Batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${error.message}`);
      if (error.message.includes('not found')) {
        console.error('\n   ⚠️  Table not found — did you run schema.sql in Supabase SQL Editor first?');
        process.exit(1);
      }
      failed += batch.length;
    } else {
      inserted += batch.length;
      process.stdout.write(`   ✓ Batch ${Math.floor(i / BATCH_SIZE) + 1} — ${inserted}/${rows.length} rows upserted\r`);
    }
  }

  console.log(`\n\n✅ Import complete: ${inserted} rows upserted, ${failed} failed.`);

  if (inserted > 0) {
    console.log('\n🎯 Next step: Open http://localhost:5173 and click Start Analysis.');
    console.log('   Benchmarks will now be loaded from Supabase for every shot type.\n');
  }
}

main().catch(err => {
  console.error('\n❌ Unexpected error:', err.message);
  process.exit(1);
});
