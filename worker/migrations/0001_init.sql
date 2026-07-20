-- Port of server/app/db.py SCHEMA (SQLite → D1), including the columns that
-- were added by runtime migrations in the Python app (extracted_via, status_hint).

CREATE TABLE IF NOT EXISTS flights (
    flight_number INTEGER PRIMARY KEY,
    name TEXT,
    launch_date TEXT,
    net_date TEXT,
    booster TEXT,
    ship TEXT,
    block INTEGER,
    pad TEXT,
    outcome TEXT,
    booster_outcome TEXT,
    ship_outcome TEXT,
    milestones_json TEXT,
    investigation_json TEXT,
    ll2_id TEXT,
    ll2_status TEXT,
    ll2_raw_json TEXT,
    status_hint TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS net_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    flight_number INTEGER NOT NULL,
    net_date TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'll2',
    UNIQUE(flight_number, net_date, source)
);

CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    title TEXT,
    summary TEXT,
    news_site TEXT,
    published_at TEXT,
    image_url TEXT,
    fetched_at TEXT NOT NULL,
    extracted INTEGER NOT NULL DEFAULT 0,
    extracted_via TEXT
);

CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id INTEGER,
    article_url TEXT,
    signal_type TEXT NOT NULL,
    flight_number INTEGER,
    payload_json TEXT NOT NULL,
    confidence REAL,
    quote TEXT,
    extracted_at TEXT NOT NULL,
    FOREIGN KEY(article_id) REFERENCES articles(id)
);

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_net_history_flight ON net_history(flight_number, observed_at);
CREATE INDEX IF NOT EXISTS idx_signals_extracted_at ON signals(extracted_at);
CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at);
