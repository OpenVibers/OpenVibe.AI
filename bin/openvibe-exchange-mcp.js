#!/usr/bin/env node
'use strict';
/**
 * OpenVibe.Exchange MCP server over stdio (design EXCHANGE-REMAKE-2026-11-06, "For builders", item 7).
 *
 *   OPENVIBE_EXCHANGE_TOKEN=... npx openvibe-exchange-mcp
 *   OPENVIBE_EXCHANGE_URL=https://api.openvibe.exchange   (a test or an alternate deployment)
 *
 * Add it to an MCP client's config as a stdio server with the token in the environment. The server writes one
 * JSON-RPC message per line to stdout and nothing else; logs go to stderr. A tool call without a token is refused
 * before any request, and a 401 from the Exchange is refused back as the tool's error.
 */
const readline = require('node:readline');
const { createExchangeMcp } = require('../server/mcp/exchange');

async function main() {
    const mcp = createExchangeMcp({
        token: process.env.OPENVIBE_EXCHANGE_TOKEN || process.env.OPENVIBE_DEVELOPER_KEY || '',
        baseUrl: process.env.OPENVIBE_EXCHANGE_URL || 'https://api.openvibe.exchange',
    });
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    const write = (value) => { process.stdout.write(`${JSON.stringify(value)}\n`); };
    for await (const line of rl) {
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch {
            write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
            continue;
        }
        try {
            const out = await mcp.handle(message);
            if (out) write(out);
        } catch (err) {
            // A protocol-level failure never takes the server down; the client sees a JSON-RPC internal error.
            write({ jsonrpc: '2.0', id: message && message.id !== undefined ? message.id : null, error: { code: -32603, message: String((err && err.message) || err).slice(0, 300) } });
        }
    }
}

main().catch((err) => {
    process.stderr.write(`openvibe-exchange-mcp: ${(err && err.stack) || err}\n`);
    process.exit(1);
});
