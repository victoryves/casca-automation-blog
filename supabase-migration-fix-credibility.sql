-- Fix credibility_score column type
-- Run this in Supabase SQL Editor to fix the type mismatch

-- Change credibility_score from INTEGER to NUMERIC(3,1)
-- This allows values like 0.7, 0.9, 5.0, etc.
ALTER TABLE sources
ALTER COLUMN credibility_score TYPE NUMERIC(3,1)
USING credibility_score::numeric;

-- Update default value
ALTER TABLE sources
ALTER COLUMN credibility_score SET DEFAULT 5.0;

-- Verify the change
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'sources' AND column_name = 'credibility_score';
