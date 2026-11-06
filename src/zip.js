// Just enough ZIP to read and write .xlsx, with no dependencies.
//
// Deflate comes from the platform — CompressionStream / DecompressionStream are
// in every current browser and in Node 18+ — so there is no vendored library
// here. That matters beyond file size: a tool whose selling point is "nothing
// leaves your computer" is easier to believe when there is no third-party code
// in it at all.

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function through(bytes, stream) {
  const piped = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

const inflateRaw = (bytes) => through(bytes, new DecompressionStream("deflate-raw"));
const deflateRaw = (bytes) => through(bytes, new CompressionStream("deflate-raw"));

// ------------------------------------------------------------------ reading

/**
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {Promise<Map<string, Uint8Array>>} entry name -> bytes
 */
export async function unzip(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // The end-of-central-directory record sits at the end, after a comment of
  // unknown length, so it has to be found by scanning backwards.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 0xffff; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file (no end-of-central-directory record)");

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);

  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== CENTRAL_SIG) throw new Error("corrupt central directory");
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localAt = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));

    if (view.getUint32(localAt, true) !== LOCAL_SIG) throw new Error(`corrupt entry: ${name}`);
    const lNameLen = view.getUint16(localAt + 26, true);
    const lExtraLen = view.getUint16(localAt + 28, true);
    const start = localAt + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(start, start + compSize);

    out.set(name, method === 0 ? raw : await inflateRaw(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ------------------------------------------------------------------ writing

/**
 * @param {{name: string, data: Uint8Array}[]} files
 * @returns {Promise<Uint8Array>}
 */
export async function zip(files) {
  const encoder = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const crc = crc32(file.data);
    const deflated = await deflateRaw(file.data);
    // Deflate can inflate tiny payloads; store them instead.
    const useDeflate = deflated.length < file.data.length;
    const body = useDeflate ? deflated : file.data;
    const method = useDeflate ? 8 : 0;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL_SIG, true);
    lv.setUint16(4, 20, true);          // version needed
    lv.setUint16(6, 0, true);           // flags
    lv.setUint16(8, method, true);
    lv.setUint16(10, 0, true);          // time
    lv.setUint16(12, 0x21, true);       // date: 1980-01-01, so output is byte-stable
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, file.data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    parts.push(local, body);

    const entry = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(entry.buffer);
    cv.setUint32(0, CENTRAL_SIG, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, file.data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    entry.set(nameBytes, 46);
    central.push(entry);

    offset += local.length + body.length;
  }

  const centralSize = central.reduce((n, e) => n + e.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, EOCD_SIG, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const all = [...parts, ...central, eocd];
  const total = all.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}
