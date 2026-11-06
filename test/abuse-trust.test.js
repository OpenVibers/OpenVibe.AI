'use strict';
// Plan E5: the allowance tiers and the IP-to-ASN table (server/abuse/trust.js, server/abuse/asn.js), with no
// database and no network. The HTTP side is test/abuse.test.js and test/abuse-runs.test.js.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { suite, tmpDir, silent } = require('./helpers');
const { tierFor, rateFor, TIERS } = require('../server/abuse/trust');
const asn = require('../server/abuse/asn');
const { normalize } = require('../server/abuse/network');

const t = suite('abuse-trust');

t.test('the tier is the plan\'s: new quarter, established half, verified full, kudos on top', () => {
    assert.strictEqual(TIERS.new.factor, 0.25);
    assert.strictEqual(TIERS.established.factor, 0.5);
    assert.strictEqual(TIERS.verified.factor, 1);
    assert.deepStrictEqual(pick(tierFor({ signals: { available: true, account_age_hours: 2, verified: false }, base: 1000 })), { tier: 'new', allowance: 250 });
    assert.deepStrictEqual(pick(tierFor({ signals: { available: true, account_age_hours: 8 * 24, verified: false }, base: 1000 })), { tier: 'established', allowance: 500 });
    assert.deepStrictEqual(pick(tierFor({ signals: { available: true, account_age_hours: 2, verified: true, verified_by: ['passkey'] }, base: 1000 })), { tier: 'verified', allowance: 1000 });
});

t.test('a volunteer\'s kudos add at most one more base, and only on the full tier', () => {
    const v = tierFor({ signals: { available: true, verified: true }, kudos: 400, base: 1000 });
    assert.strictEqual(v.allowance, 1400);
    assert.ok(v.reasons.some((r) => /kudos add 400/.test(r)));
    const capped = tierFor({ signals: { available: true, verified: true }, kudos: 5000, base: 1000 });
    assert.strictEqual(capped.allowance, 2000, 'never more than one extra base');
    const unverified = tierFor({ signals: { available: true, verified: false, account_age_hours: 1 }, kudos: 5000, base: 1000 });
    assert.strictEqual(unverified.allowance, 250, 'kudos do not lift an unverified account');
});

t.test('a hosting ASN is the new tier whatever the account says; no Network answer is the conservative side', () => {
    const hosted = tierFor({ signals: { available: true, verified: true }, hosting: true, base: 1000 });
    assert.strictEqual(hosted.tier, 'new');
    assert.strictEqual(hosted.allowance, 250);
    assert.ok(hosted.reasons.some((r) => /hosting/.test(r)));
    const unknown = tierFor({ signals: { available: false }, base: 1000 });
    assert.strictEqual(unknown.tier, 'new');
    assert.strictEqual(unknown.allowance, 250);
    assert.strictEqual(tierFor({ signals: null, base: 0 }).allowance, 0);
});

t.test('the hosting rate is lower than the ordinary one', () => {
    assert.strictEqual(rateFor({ hosting: false, normal: 60, hostingRate: 20 }), 60);
    assert.strictEqual(rateFor({ hosting: true, normal: 60, hostingRate: 20 }), 20);
    assert.strictEqual(rateFor({ hosting: true, normal: 60, hostingRate: 0 }), 1);
});

t.test('IPv4 /24 and IPv6 /48 prefixes, including a v4-mapped v6 address', () => {
    assert.deepStrictEqual(asn.prefixOf('192.0.2.123'), { family: 'v4', prefix: '192.0.2.0/24' });
    assert.deepStrictEqual(asn.prefixOf('2001:db8:1:2:3:4:5:6'), { family: 'v6', prefix: '2001:db8:1::/48' });
    assert.deepStrictEqual(asn.prefixOf('::ffff:192.0.2.9'), { family: 'v4', prefix: '192.0.2.0/24' });
    assert.strictEqual(asn.prefixOf('not an address'), null);
    assert.strictEqual(asn.ipv6Text(0n), '::');
    assert.strictEqual(asn.ipv6Text(1n), '::1');
});

t.test('a local table answers the ASN and marks an org-name hosting provider', () => {
    const dir = tmpDir();
    const v4 = path.join(dir, 'ip2asn-v4.tsv');
    const v6 = path.join(dir, 'ip2asn-v6.tsv');
    fs.writeFileSync(v4, [
        '1.0.0.0\t1.0.0.255\t13335\tUS\tCloudflare, Inc.',
        '5.0.0.0\t5.255.255.255\t64500\tDE\tExample Hosting GmbH',
        '9.9.9.0\t9.9.9.255\t19281\tUS\tQuad9',
    ].join('\n'));
    fs.writeFileSync(v6, '2001:db8::\t2001:db8:ffff:ffff:ffff:ffff:ffff:ffff\t396982\tUS\tGoogle Cloud\n');
    const table = asn.createAsnTable({ v4File: v4, v6File: v6, hostingAsns: [19281], log: silent });
    assert.deepStrictEqual(table.lookup('1.0.0.42'), { asn: 13335, country: 'US', org: 'Cloudflare, Inc.', hosting: true });
    assert.strictEqual(table.lookup('5.4.3.2').hosting, true, 'the organisation name says hosting');
    assert.strictEqual(table.lookup('9.9.9.9').hosting, true, 'an operator-named hosting ASN');
    assert.strictEqual(table.lookup('2001:db8::1').asn, 396982);
    assert.deepStrictEqual(table.lookup('8.8.8.8'), { asn: null, country: null, org: null, hosting: false });
    assert.deepStrictEqual(table.status(), { v4_ranges: 3, v6_ranges: 1, hosting_asns: 1 });
});

t.test('a missing dataset is empty, not a crash', () => {
    const table = asn.createAsnTable({ v4File: path.join(tmpDir(), 'nope.tsv'), log: silent });
    assert.deepStrictEqual(table.lookup('1.0.0.42'), { asn: null, country: null, org: null, hosting: false });
});

t.test('Network trust is normalised and never carries a private fact', () => {
    const n = normalize({ account_age_hours: 200, account_age_days: 8, verified: true, verified_by: ['passkey', 7], passkey: true, linked_accounts: 2, active_30d: false, email: 'x@example.com' });
    assert.deepStrictEqual(n, { account_age_hours: 200, account_age_days: 8, verified: true, verified_by: ['passkey'], passkey: true, linked_accounts: 2, active_30d: false });
    assert.strictEqual(normalize(null), null);
    assert.strictEqual(normalize({ account_age_hours: -5 }).account_age_hours, 0);
});

function pick(out) { return { tier: out.tier, allowance: out.allowance }; }

t.run();
