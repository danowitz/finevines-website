export const MAX_REVIEWER_IMAGE_BYTES = 10 * 1024 * 1024;

export class ReviewerImageError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function startsWith(bytes, signature) {
  return signature.every((value, index) => bytes[index] === value);
}

const readUint32BE = (bytes, offset) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
const readUint32LE = (bytes, offset) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);

function validPNG(bytes) {
  if (!startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return false;
  let offset = 8;
  let sawHeader = false;
  let sawData = false;
  while (offset + 12 <= bytes.length) {
    const length = readUint32BE(bytes, offset);
    if (length > bytes.length - offset - 12) return false;
    const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
    const dataOffset = offset + 8;
    if (!sawHeader) {
      if (type !== 'IHDR' || length !== 13) return false;
      if (readUint32BE(bytes, dataOffset) === 0 || readUint32BE(bytes, dataOffset + 4) === 0) return false;
      sawHeader = true;
    } else if (type === 'IHDR') {
      return false;
    }
    if (type === 'IDAT' && length > 0) sawData = true;
    offset += 12 + length;
    if (type === 'IEND') return length === 0 && sawData && offset === bytes.length;
  }
  return false;
}

const isStandaloneJPEGMarker = (marker) => marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
const isJPEGStartOfFrame = (marker) => (marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker);

function validJPEG(bytes) {
  if (!startsWith(bytes, [0xff, 0xd8, 0xff])) return false;
  let offset = 2;
  let sawFrame = false;
  let sawScan = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) return false;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return false;
    const marker = bytes[offset++];
    if (marker === 0xd9) return sawFrame && sawScan && offset === bytes.length;
    if (marker === 0xd8 || isStandaloneJPEGMarker(marker)) continue;
    if (offset + 2 > bytes.length) return false;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return false;
    if (isJPEGStartOfFrame(marker)) {
      if (length < 8 || ((bytes[offset + 3] << 8) | bytes[offset + 4]) === 0 || ((bytes[offset + 5] << 8) | bytes[offset + 6]) === 0) return false;
      sawFrame = true;
    }
    offset += length;
    if (marker !== 0xda) continue;
    sawScan = true;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 0xff) continue;
      while (offset < bytes.length && bytes[offset] === 0xff) offset++;
      if (offset >= bytes.length) return false;
      const scanMarker = bytes[offset];
      if (scanMarker === 0x00 || (scanMarker >= 0xd0 && scanMarker <= 0xd7)) {
        offset++;
        continue;
      }
      offset--;
      break;
    }
  }
  return false;
}

function validWebP(bytes) {
  if (bytes.length < 20 || String.fromCharCode(...bytes.slice(0, 4)) !== 'RIFF' || String.fromCharCode(...bytes.slice(8, 12)) !== 'WEBP') return false;
  if (readUint32LE(bytes, 4) !== bytes.length - 8) return false;
  let offset = 12;
  let sawImage = false;
  while (offset + 8 <= bytes.length) {
    const type = String.fromCharCode(...bytes.slice(offset, offset + 4));
    const length = readUint32LE(bytes, offset + 4);
    const dataOffset = offset + 8;
    if (length > bytes.length - dataOffset) return false;
    if (type === 'VP8 ') {
      if (length < 10 || !startsWith(bytes.slice(dataOffset + 3), [0x9d, 0x01, 0x2a])) return false;
      const width = (bytes[dataOffset + 6] | (bytes[dataOffset + 7] << 8)) & 0x3fff;
      const height = (bytes[dataOffset + 8] | (bytes[dataOffset + 9] << 8)) & 0x3fff;
      if (!width || !height) return false;
      sawImage = true;
    } else if (type === 'VP8L') {
      if (length < 5 || bytes[dataOffset] !== 0x2f) return false;
      sawImage = true;
    } else if (type === 'VP8X') {
      if (length !== 10) return false;
      sawImage = true;
    }
    offset = dataOffset + length + (length % 2);
  }
  return sawImage && offset === bytes.length;
}

function imageFormat(bytes) {
  if (validPNG(bytes)) return { mime: 'image/png', extension: 'png' };
  if (validJPEG(bytes)) return { mime: 'image/jpeg', extension: 'jpg' };
  if (validWebP(bytes)) return { mime: 'image/webp', extension: 'webp' };
  throw new ReviewerImageError('Paste a JPEG, PNG, or WebP image.', 415);
}

function hex(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function inspectReviewerImage(file) {
  if (!file || typeof file.arrayBuffer !== 'function' || !Number.isInteger(file.size) || file.size <= 0) {
    throw new ReviewerImageError('Paste a JPEG, PNG, or WebP image.', 415);
  }
  if (file.size > MAX_REVIEWER_IMAGE_BYTES) throw new ReviewerImageError('The pasted image must be 10 MB or smaller.', 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const format = imageFormat(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return { bytes, bytesLength: bytes.byteLength, sha256: hex(digest), ...format };
}
