import { deflateSync } from 'node:zlib';

/** A real, decoded PNG fixture with deterministic RGB pixels and dimensions. */
export function representativePng(width = 128, height = 96): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const offset = 1 + x * 3;
      row[offset] = (x * 17 + y * 3) & 0xff;
      row[offset + 1] = (y * 19 + x * 5) & 0xff;
      row[offset + 2] = (x * 7 + y * 23) & 0xff;
    }
    rows.push(row);
  }

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.concat(rows);
  return Buffer.concat([
    signature,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(name: string, value: Buffer): Buffer {
  const nameBytes = Buffer.from(name, 'ascii');
  const body = Buffer.concat([nameBytes, value]);
  const result = Buffer.alloc(8 + value.length + 4);
  result.writeUInt32BE(value.length, 0);
  nameBytes.copy(result, 4);
  value.copy(result, 8);
  result.writeUInt32BE(crc32(body), 8 + value.length);
  return result;
}

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
