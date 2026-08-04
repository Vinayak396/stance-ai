-- ================================================================
-- StanceAI — RLS Patch for shot_benchmarks
-- ================================================================
-- Run this in Supabase SQL Editor to allow the importer to insert
-- benchmark rows using the anon key.
--
-- After the import is done you can DROP this policy if you want
-- to make benchmarks read-only again (recommended for production).
-- ================================================================

CREATE POLICY "Allow anon insert shot_benchmarks"
    ON shot_benchmarks FOR INSERT
    WITH CHECK (true);

-- Also allow updates (needed for upsert ON CONFLICT DO UPDATE)
CREATE POLICY "Allow anon update shot_benchmarks"
    ON shot_benchmarks FOR UPDATE
    USING (true);
