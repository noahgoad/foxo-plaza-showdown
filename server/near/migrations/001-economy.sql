CREATE TABLE IF NOT EXISTS economy_schema_version (version INTEGER PRIMARY KEY);
INSERT OR IGNORE INTO economy_schema_version VALUES (1);
CREATE TABLE IF NOT EXISTS economy_funding_buckets (
  network TEXT NOT NULL CHECK(network = 'near-testnet'),
  bucket TEXT NOT NULL,
  amount_atomic TEXT NOT NULL CHECK(length(amount_atomic) BETWEEN 1 AND 39 AND amount_atomic NOT GLOB '*[^0-9]*' AND (amount_atomic = '0' OR substr(amount_atomic,1,1) <> '0') AND (length(amount_atomic) < 39 OR amount_atomic <= '340282366920938463463374607431768211455')),
  PRIMARY KEY(network,bucket)
);
CREATE TABLE IF NOT EXISTS economy_assets (
  network TEXT NOT NULL CHECK(network = 'near-testnet'),
  account_id TEXT NOT NULL CHECK(account_id NOT LIKE '0x%' AND length(account_id) BETWEEN 2 AND 64),
  collection_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  PRIMARY KEY(network,account_id,collection_id,token_id)
);
CREATE TABLE IF NOT EXISTS economy_practice_balances (
  namespace TEXT NOT NULL CHECK(namespace = 'practice'),
  account_id TEXT PRIMARY KEY,
  credits TEXT NOT NULL CHECK(length(credits) > 0 AND credits NOT GLOB '*[^0-9]*')
);
CREATE TABLE IF NOT EXISTS economy_operation_journal (
  operation_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL CHECK(json_valid(payload))
);
