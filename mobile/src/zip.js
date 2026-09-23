/*
 * Minimal ZIP read/write + java.util.Properties read/write, so a backup made on the phone is the
 * same shape as the PC version's /api/admin/backup zip (freshmart.db + store.properties) and
 * either side can restore the other's backup.
 *
 * - FMZip.create([{name, data}]) -> Promise<Uint8Array>   (deflate via CompressionStream when
 *   available, else stored; sizes and CRC go in the local header - no data descriptor - so
 *   Java's ZipInputStream reads it either way)
 * - FMZip.read(bytes) -> Promise<Map<name, Uint8Array>>  (walks the central directory, so it
 *   handles Java's ZipOutputStream output, which puts sizes in trailing data descriptors)
 * - FMProps.parse(text) / FMProps.serialize(map, comment)
 *
 * Plain script: attaches to globalThis, and to module.exports under Node (tests).
 */
(function (root) {
    "use strict";

    const CRC_TABLE = (() => {
        const t = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            t[n] = c >>> 0;
        }
        return t;
    })();

    function crc32(bytes) {
        let c = 0xFFFFFFFF;
        for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    }

    async function pipeThrough(bytes, stream) {
        const out = new Blob([bytes]).stream().pipeThrough(stream);
        return new Uint8Array(await new Response(out).arrayBuffer());
    }

    const canDeflate = typeof CompressionStream === "function";

    async function deflateRaw(bytes) {
        return pipeThrough(bytes, new CompressionStream("deflate-raw"));
    }

    async function inflateRaw(bytes) {
        if (typeof DecompressionStream !== "function") {
            throw new Error("This device cannot unpack compressed backups (no DecompressionStream).");
        }
        return pipeThrough(bytes, new DecompressionStream("deflate-raw"));
    }

    /** DOS date/time for the zip headers (local wall clock - informational only). */
    function dosStamp(d) {
        const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
        const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
        return { time, date };
    }

    async function create(entries) {
        const enc = new TextEncoder();
        const now = dosStamp(new Date());
        const locals = [];
        const centrals = [];
        let offset = 0;
        for (const e of entries) {
            const nameBytes = enc.encode(e.name);
            const data = e.data;
            const crc = crc32(data);
            let method = 0;
            let payload = data;
            if (canDeflate) {
                const packed = await deflateRaw(data);
                if (packed.length < data.length) { method = 8; payload = packed; }
            }
            const lh = new DataView(new ArrayBuffer(30));
            lh.setUint32(0, 0x04034b50, true);
            lh.setUint16(4, 20, true);          // version needed
            lh.setUint16(6, 0x0800, true);      // flags: UTF-8 names
            lh.setUint16(8, method, true);
            lh.setUint16(10, now.time, true);
            lh.setUint16(12, now.date, true);
            lh.setUint32(14, crc, true);
            lh.setUint32(18, payload.length, true);
            lh.setUint32(22, data.length, true);
            lh.setUint16(26, nameBytes.length, true);
            lh.setUint16(28, 0, true);
            locals.push(new Uint8Array(lh.buffer), nameBytes, payload);

            const ch = new DataView(new ArrayBuffer(46));
            ch.setUint32(0, 0x02014b50, true);
            ch.setUint16(4, 20, true);          // version made by
            ch.setUint16(6, 20, true);
            ch.setUint16(8, 0x0800, true);
            ch.setUint16(10, method, true);
            ch.setUint16(12, now.time, true);
            ch.setUint16(14, now.date, true);
            ch.setUint32(16, crc, true);
            ch.setUint32(20, payload.length, true);
            ch.setUint32(24, data.length, true);
            ch.setUint16(28, nameBytes.length, true);
            ch.setUint32(42, offset, true);
            centrals.push(new Uint8Array(ch.buffer), nameBytes);
            offset += 30 + nameBytes.length + payload.length;
        }
        const cdSize = centrals.reduce((n, b) => n + b.length, 0);
        const end = new DataView(new ArrayBuffer(22));
        end.setUint32(0, 0x06054b50, true);
        end.setUint16(8, entries.length, true);
        end.setUint16(10, entries.length, true);
        end.setUint32(12, cdSize, true);
        end.setUint32(16, offset, true);
        const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
        const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
        let p = 0;
        for (const b of parts) { out.set(b, p); p += b.length; }
        return out;
    }

    async function read(bytes) {
        const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        let eocd = -1;
        for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
            if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
        }
        if (eocd < 0) throw new Error("That file is not a zip archive.");
        const count = dv.getUint16(eocd + 10, true);
        let p = dv.getUint32(eocd + 16, true);
        const dec = new TextDecoder();
        const out = new Map();
        for (let i = 0; i < count; i++) {
            if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("Corrupt zip (bad central directory).");
            const method = dv.getUint16(p + 10, true);
            const compSize = dv.getUint32(p + 20, true);
            const nameLen = dv.getUint16(p + 28, true);
            const extraLen = dv.getUint16(p + 30, true);
            const commentLen = dv.getUint16(p + 32, true);
            const localOff = dv.getUint32(p + 42, true);
            const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
            p += 46 + nameLen + extraLen + commentLen;
            if (dv.getUint32(localOff, true) !== 0x04034b50) throw new Error("Corrupt zip (bad local header).");
            const lName = dv.getUint16(localOff + 26, true);
            const lExtra = dv.getUint16(localOff + 28, true);
            const start = localOff + 30 + lName + lExtra;
            const raw = u8.subarray(start, start + compSize);
            if (method === 0) out.set(name, raw.slice());
            else if (method === 8) out.set(name, await inflateRaw(raw));
            else throw new Error("Unsupported zip compression method " + method + ".");
        }
        return out;
    }

    // ---------------- java.util.Properties ----------------

    function parseProps(text) {
        const out = new Map();
        const lines = String(text).split(/\r\n|\r|\n/);
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].replace(/^[ \t\f]+/, "");
            if (!line || line[0] === "#" || line[0] === "!") continue;
            // Line continuation: an odd number of trailing backslashes joins the next line.
            while (/(^|[^\\])(\\\\)*\\$/.test(line) && i + 1 < lines.length) {
                line = line.slice(0, -1) + lines[++i].replace(/^[ \t\f]+/, "");
            }
            let k = 0;
            let key = "";
            while (k < line.length) {
                const c = line[k];
                if (c === "\\") { key += line.slice(k, k + 2); k += 2; continue; }
                if (c === "=" || c === ":" || c === " " || c === "\t" || c === "\f") break;
                key += c; k++;
            }
            while (k < line.length && (line[k] === " " || line[k] === "\t" || line[k] === "\f")) k++;
            if (k < line.length && (line[k] === "=" || line[k] === ":")) k++;
            while (k < line.length && (line[k] === " " || line[k] === "\t" || line[k] === "\f")) k++;
            out.set(unescapeProp(key), unescapeProp(line.slice(k)));
        }
        return out;
    }

    function unescapeProp(s) {
        let out = "";
        for (let i = 0; i < s.length; i++) {
            const c = s[i];
            if (c !== "\\") { out += c; continue; }
            const n = s[++i];
            if (n === undefined) break;
            if (n === "t") out += "\t";
            else if (n === "n") out += "\n";
            else if (n === "r") out += "\r";
            else if (n === "f") out += "\f";
            else if (n === "u") { out += String.fromCharCode(parseInt(s.substr(i + 1, 4), 16)); i += 4; }
            else out += n;
        }
        return out;
    }

    function escapeProp(s, isKey) {
        let out = "";
        for (let i = 0; i < s.length; i++) {
            const c = s[i];
            const code = s.charCodeAt(i);
            if (c === " ") out += (i === 0 || isKey) ? "\\ " : " ";
            else if (c === "\\") out += "\\\\";
            else if (c === "\t") out += "\\t";
            else if (c === "\n") out += "\\n";
            else if (c === "\r") out += "\\r";
            else if (c === "\f") out += "\\f";
            else if ("=:#!".includes(c)) out += "\\" + c;
            else if (code < 0x20 || code > 0x7e) out += "\\u" + code.toString(16).toUpperCase().padStart(4, "0");
            else out += c;
        }
        return out;
    }

    function serializeProps(map, comment) {
        let out = comment ? "#" + comment + "\n" : "";
        out += "#" + new Date().toString() + "\n";
        for (const [k, v] of map) out += escapeProp(k, true) + "=" + escapeProp(v == null ? "" : String(v), false) + "\n";
        return out;
    }

    const FMZip = { create, read, crc32 };
    const FMProps = { parse: parseProps, serialize: serializeProps };
    root.FMZip = FMZip;
    root.FMProps = FMProps;
    if (typeof module !== "undefined" && module.exports) module.exports = { FMZip, FMProps };
})(typeof globalThis !== "undefined" ? globalThis : this);
