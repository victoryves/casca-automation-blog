-- CASCA Archive Database Schema for Supabase (PostgreSQL)

-- Artists table
CREATE TABLE IF NOT EXISTS artists (
  id SERIAL PRIMARY KEY,
  full_name TEXT NOT NULL,
  birthplace_city TEXT,
  birthplace_state TEXT,
  visual_practice TEXT,
  status TEXT DEFAULT 'discovered' CHECK (status IN ('discovered', 'verified', 'published')),
  discovered_at TIMESTAMP DEFAULT NOW(),
  published_at TIMESTAMP
);

-- Sources table
CREATE TABLE IF NOT EXISTS sources (
  id SERIAL PRIMARY KEY,
  artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  institution TEXT,
  credibility_score INTEGER DEFAULT 5,
  content_summary TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Drafts table
CREATE TABLE IF NOT EXISTS drafts (
  id SERIAL PRIMARY KEY,
  artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  subtitle TEXT,
  content TEXT NOT NULL,
  images JSONB,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'approved', 'rejected')),
  created_at TIMESTAMP DEFAULT NOW(),
  sent_at TIMESTAMP
);

-- Publishing log table
CREATE TABLE IF NOT EXISTS publishing_log (
  id SERIAL PRIMARY KEY,
  draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  medium_url TEXT,
  published_at TIMESTAMP DEFAULT NOW(),
  error_message TEXT
);

-- Indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_artists_status ON artists(status);
CREATE INDEX IF NOT EXISTS idx_sources_artist_id ON sources(artist_id);
CREATE INDEX IF NOT EXISTS idx_drafts_artist_id ON drafts(artist_id);
CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);
CREATE INDEX IF NOT EXISTS idx_publishing_log_draft_id ON publishing_log(draft_id);

-- Enable Row Level Security (RLS) - opcional, mas recomendado
ALTER TABLE artists ENABLE ROW LEVEL SECURITY;
ALTER TABLE sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE publishing_log ENABLE ROW LEVEL SECURITY;

-- Create policies to allow service role full access
CREATE POLICY "Allow service role full access to artists" ON artists FOR ALL USING (true);
CREATE POLICY "Allow service role full access to sources" ON sources FOR ALL USING (true);
CREATE POLICY "Allow service role full access to drafts" ON drafts FOR ALL USING (true);
CREATE POLICY "Allow service role full access to publishing_log" ON publishing_log FOR ALL USING (true);
