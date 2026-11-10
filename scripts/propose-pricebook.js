#!/usr/bin/env node
'use strict';
/**
 * Put reviewed provider readings in front of the owner as pending price changes.
 *
 * The weekly price book reads a provider's listing itself and proposes a change only when its own reading
 * differs from the live price. This script is the other door: it reads a JSON list of readings that a person
 * took from the provider's own page or keyless model list, and writes each one into `price_changes` as
 * pending. It never writes a price into a model row and never approves a change; the owner does that on the
 * operator console (ai.provider.manage).
 *
 *   node scripts/propose-pricebook.js [file.json] [--dry-run]
 *
 * The file is an array of readings:
 *
 *   {
 *     "provider_key": "parasail",
 *     "model_key": "parasail-deepseek-v4-flash",
 *     "in_per_mtok": 0.14, "cached_per_mtok": 0.07, "out_per_mtok": 0.28,
 *     "context_window": 1048576, "quantization": "fp8", "type": "chat",
 *     "source": "https://docs.parasail.io/parasail-docs/products/overview/models",
 *     "checked_at": "2026-11-10"
 *   }
 *
 * Run it on the AI host with the service environment (the recipe is in the ov-prod-db-read skill), or use
 * POST /api/v1/admin/console/pricebook/proposals with the same list. A model the registry does not know is
 * created switched off with no price, so there is a row to approve against; it is not marked price-book-owned
 * until the owner approves a price.
 */
const fs = require('fs');
const path = require('path');
const { load } = require('../server/config');
const { openDb } = require('../server/db');
const { createRegistry } = require('../server/registry');
const { createPriceStore } = require('../server/pricebook/store');
const { proposePriceChanges } = require('../server/pricebook/propose');

const DEFAULT_FILE = path.join(__dirname, 'pricebook-proposals-2026-11-10.json');

async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const file = args.find((a) => !a.startsWith('--')) || DEFAULT_FILE;
    let proposals;
    try {
        proposals = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        throw new Error(`cannot read ${file}: ${err.message}`);
    }
    const config = load(process.env);
    const db = await openDb(config);
    try {
        const registry = createRegistry(db, { env: process.env });
        const store = createPriceStore({ db });
        const out = await proposePriceChanges({ registry, store, proposals, actor: 'owner:pricebook-propose', dryRun });
        if (!dryRun) {
            await registry.audit('owner:pricebook-propose', 'price_changes.proposed', 'price_book', 'propose', {
                metadata: { proposed: out.proposed.length, unchanged: out.unchanged.length, models_created: out.models_created.length, file: path.basename(file) },
            });
        }
        console.log(JSON.stringify(out, null, 2));
        console.log(`${dryRun ? 'would propose' : 'proposed'} ${out.proposed.length}; ${out.unchanged.length} already at that price; ${out.models_created.length} model row(s) ${dryRun ? 'would be created' : 'created'}`);
    } finally {
        await db.close();
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error(`pricebook proposals: ${err.message}`);
        process.exitCode = 1;
    });
}

module.exports = { main, DEFAULT_FILE };
