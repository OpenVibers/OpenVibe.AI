#!/usr/bin/env node
/**
 * Runs every test in test/ — the files named *.test.js — each in its own process, and fails
 * if any of them fails. They use temp SQLite databases, a generated signing key, the deterministic
 * stub provider and local HTTP servers on random ports; none of them needs the network, a paid
 * key or a running OpenVibe.Network.
 *
 *   npm test                     # everything
 *   npm test -- quota cache      # only files whose name contains one of the words
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const files = fs.readdirSync(__dirname)
    .filter((f) => f.endsWith('.test.js'))
    .filter((f) => !filters.length || filters.some((w) => f.includes(w)))
    .sort();
const TIMEOUT_MS = 60000;

function runOne(file) {
    return new Promise((resolve) => {
        const started = Date.now();
        const child = spawn(process.execPath, [path.join(__dirname, file)], {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, NODE_ENV: 'test' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', (c) => { output += c; });
        child.stderr.on('data', (c) => { output += c; });
        const timer = setTimeout(() => { output += `\n[run] timed out after ${TIMEOUT_MS}ms`; child.kill('SIGKILL'); }, TIMEOUT_MS);
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            resolve({ file, ok: code === 0, code: code ?? signal, ms: Date.now() - started, output });
        });
    });
}

(async () => {
    if (!files.length) { console.error('no test files matched'); process.exit(1); }
    const results = [];
    for (const f of files) {
        const r = await runOne(f);
        results.push(r);
        console.log(`${r.ok ? '✓' : '✗'} ${r.file.padEnd(32)} ${String(r.ms).padStart(6)}ms`);
    }
    const failed = results.filter((r) => !r.ok);
    for (const r of failed) {
        console.log(`\n── ${r.file} (exit ${r.code}) ──`);
        console.log(r.output.split('\n').slice(-60).join('\n'));
    }
    console.log(`\n${results.length - failed.length}/${results.length} test files passed`);
    process.exit(failed.length ? 1 : 0);
})();
