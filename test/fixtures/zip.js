'use strict';
/**
 * A tiny ZIP writer for the memory-import tests. The fixtures are synthetic (no real exports in the repo); this
 * makes one in memory so a test can hand the service the same bytes a browser would upload.
 *
 * Standard local headers, deflate entries, a central directory and an end record. The reader does not verify the
 * CRC, so the writer leaves it zero; the sizes and offsets are real.
 */
const zlib = require('zlib');

function makeZip(files) {
    const locals = [];
    const central = [];
    let offset = 0;
    for (const [name, content] of Object.entries(files)) {
        const body = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
        const data = zlib.deflateRawSync(body);
        const nameBuf = Buffer.from(name, 'utf8');
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x800, 6);
        local.writeUInt16LE(8, 8);
        local.writeUInt32LE(0, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(body.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);
        locals.push(local, nameBuf, data);

        const cent = Buffer.alloc(46);
        cent.writeUInt32LE(0x02014b50, 0);
        cent.writeUInt16LE(20, 4);
        cent.writeUInt16LE(20, 6);
        cent.writeUInt16LE(0x800, 8);
        cent.writeUInt16LE(8, 10);
        cent.writeUInt32LE(0, 16);
        cent.writeUInt32LE(data.length, 20);
        cent.writeUInt32LE(body.length, 24);
        cent.writeUInt16LE(nameBuf.length, 28);
        cent.writeUInt16LE(0, 30);
        cent.writeUInt16LE(0, 32);
        cent.writeUInt16LE(0, 34);
        cent.writeUInt16LE(0, 36);
        cent.writeUInt32LE(0, 38);
        cent.writeUInt32LE(offset, 42);
        central.push(cent, nameBuf);
        offset += local.length + nameBuf.length + data.length;
    }
    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(Object.keys(files).length, 8);
    end.writeUInt16LE(Object.keys(files).length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);
    return Buffer.concat([...locals, directory, end]);
}

module.exports = { makeZip };
