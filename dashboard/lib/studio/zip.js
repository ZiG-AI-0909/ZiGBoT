/**
 * Minimal ZIP writer for project export (deflate, CRC-32, UTF-8 names).
 * No dependency; output opens in every standard unzip tool.
 */
const zlib = require('node:zlib');

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buffer) {
    let crc = 0xffffffff;
    for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

/** files: [{ path, content }] → Buffer of a .zip, all inside `folder/`. */
function createZip(files, { folder = '' } = {}) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    const date = 0x5961; // 2024-11-01, fixed so the same project gives the same zip
    const time = 0;
    for (const file of files) {
        const name = Buffer.from(`${folder ? `${folder}/` : ''}${file.path}`, 'utf8');
        const data = Buffer.from(file.content, 'utf8');
        const compressed = zlib.deflateRawSync(data);
        const crc = crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6); // UTF-8 names
        local.writeUInt16LE(8, 8); // deflate
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        locals.push(local, name, compressed);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(8, 10);
        central.writeUInt16LE(time, 12);
        central.writeUInt16LE(date, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(compressed.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, name);
        offset += local.length + name.length + compressed.length;
    }
    const centralSize = centrals.reduce((n, b) => n + b.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, ...centrals, end]);
}

/** Reads a zip made by createZip back (tests). */
function readZip(buffer) {
    const files = [];
    let i = 0;
    while (buffer.readUInt32LE(i) === 0x04034b50) {
        const size = buffer.readUInt32LE(i + 18);
        const nameLength = buffer.readUInt16LE(i + 26);
        const extra = buffer.readUInt16LE(i + 28);
        const name = buffer.subarray(i + 30, i + 30 + nameLength).toString('utf8');
        const start = i + 30 + nameLength + extra;
        const content = zlib.inflateRawSync(buffer.subarray(start, start + size)).toString('utf8');
        files.push({ path: name, content, crc: buffer.readUInt32LE(i + 14) });
        i = start + size;
    }
    return files;
}

module.exports = { createZip, readZip, crc32 };
