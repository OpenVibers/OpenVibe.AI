-- phase: expand
-- OpenVibe Memory M2c: dedupe by meaning, conflicts and the profile builder (spec
-- research-2026-10-30/memory-m2-spec.md, stage M2c). Expand only: every column below is nullable, so the rows
-- M2a wrote keep working and no row is rewritten.
--   embedding_enc   the item's embedding, sealed like the text: AES-256-GCM (AES-256-GCM, `m1:` + iv + tag +
--                   body) with the AAD `memory|<owner>|<id>|<scope>|emb`. An embedding leaks meaning (a nearest
--                   neighbour inverts it), so it is sealed like the text it came from and is only ever opened
--                   inside AI, on rows this owner owns.
--   embedding_model the embedding model that produced the vector. Two vector spaces are never compared: an item
--                   whose model differs from the current one is embedded again before it is compared.
--   merged_into     the item this one was merged into. The older item of a same-meaning pair keeps its row and
--                   its id here, and is archived: the person can split them again.
--   conflict_with   the item this one conflicts with. Both are `status = 'conflict'`, so neither reaches an
--                   agent, until the person settles the pair.
--   source_own      the item's own sources before a merge added another one, so a split restores exactly what
--                   the item had, not the union of two items.
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS embedding_enc text;
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS embedding_model text;
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS merged_into text;
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS conflict_with text;
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS source_own text;
CREATE INDEX IF NOT EXISTS memory_items_owner_merged_into ON memory_items (owner, merged_into);
CREATE INDEX IF NOT EXISTS memory_items_owner_conflict_with ON memory_items (owner, conflict_with);
