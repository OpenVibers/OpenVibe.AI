'use strict';
/**
 * Streamed Chat Completions (POST /v1/chat/completions with stream: true): read an upstream's server-sent events and
 * put the answer back together, so a streamed run ends with the same completion, usage and record as one that was not.
 *
 *   sseEvents(body)       async iterator of the JSON objects in `data:` lines, until `data: [DONE]` (a web
 *                         ReadableStream or any async iterable of bytes)
 *   createAccumulator()   add(choiceDelta) for each chunk's choices; result() → the choices as a non-streamed answer
 *                         (content concatenated, tool calls assembled by index with their arguments joined)
 */

async function* sseEvents(body) {
    const dec = new TextDecoder();
    let buf = '';
    for await (const part of body) {
        buf += dec.decode(part, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).replace(/\r$/, '');
            buf = buf.slice(i + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') return;
            if (!data) continue;
            let obj;
            try { obj = JSON.parse(data); } catch { continue; }
            yield obj;
        }
    }
}

function createAccumulator() {
    const choices = new Map();
    return {
        add(c) {
            const i = Number(c.index) || 0;
            const cur = choices.get(i) || { index: i, message: { role: 'assistant', content: null }, finish_reason: null, tools: [] };
            const d = c.delta || {};
            if (d.role) cur.message.role = d.role;
            if (typeof d.content === 'string') cur.message.content = (cur.message.content || '') + d.content;
            if (Array.isArray(d.tool_calls)) {
                for (const t of d.tool_calls) {
                    const k = Number(t.index) || 0;
                    const slot = cur.tools[k] || (cur.tools[k] = { id: '', type: 'function', function: { name: '', arguments: '' } });
                    if (t.id) slot.id = t.id;
                    if (t.type) slot.type = t.type;
                    if (t.function) {
                        if (t.function.name) slot.function.name += t.function.name;
                        if (t.function.arguments) slot.function.arguments += t.function.arguments;
                    }
                }
            }
            if (c.finish_reason) cur.finish_reason = c.finish_reason;
            choices.set(i, cur);
        },
        result() {
            return [...choices.values()].sort((a, b) => a.index - b.index).map((c) => {
                const tools = c.tools.filter(Boolean);
                return { index: c.index, message: { ...c.message, ...(tools.length ? { tool_calls: tools } : {}) }, finish_reason: c.finish_reason || (tools.length ? 'tool_calls' : 'stop') };
            });
        },
    };
}

module.exports = { sseEvents, createAccumulator };
