'use strict';
/**
 * The living price book (plan E1, 2026-10-30 §8): the weekly job that reads every catalogued provider's own
 * price listing, the change log it writes and the listings it reads.
 *
 * The job is created once, in the service boot (server/index.js), and handed to the operator console so the owner
 * can approve the changes the job may not make on its own.
 */
const { createPriceBook } = require('./job');
const { createPriceStore } = require('./store');
const { SOURCES } = require('./sources');
const { readListing } = require('./read');

module.exports = { createPriceBook, createPriceStore, SOURCES, readListing };
