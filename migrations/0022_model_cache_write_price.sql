-- phase: expand
-- L40: the price table gains the cache prices a person types. cost_cached_per_mtok (the cache read) is the column
-- migrations/0001 already had; this one adds the cache WRITE (the tokens written to a provider's cache). Both are
-- optional: a NULL means nobody typed that price, and the record then says 'no cache price' and prices those tokens
-- at the plain input price. No existing row is rewritten.

ALTER TABLE models ADD COLUMN cost_cache_write_per_mtok double precision;
