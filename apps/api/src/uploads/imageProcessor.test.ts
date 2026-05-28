// Unit tests for the magic-bytes gate in imageProcessor.ts.
//
// Multer's fileFilter accepts based on the client-supplied Content-Type
// header, which is not authoritative — an attacker can claim
// `image/jpeg` while uploading any other format. The magic-bytes gate
// runs inside `processImage` (i.e. after multer accepted the upload but
// before sharp's decoder touches it) and rejects bytes that don't match
// one of the four allowed image headers.

import { describe, it, expect } from 'vitest';

import { hasAllowedImageMagic } from './imageProcessor';

function buf(bytes: number[]): Buffer {
  // Pad to ≥ 12 bytes; the WebP magic requires a 12-byte window so the
  // function returns false for anything shorter regardless of content.
  const padded = bytes.slice();
  while (padded.length < 16) padded.push(0);
  return Buffer.from(padded);
}

describe('hasAllowedImageMagic', () => {
  it('accepts JPEG (FF D8 FF)', () => {
    expect(hasAllowedImageMagic(buf([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(hasAllowedImageMagic(buf([0xff, 0xd8, 0xff, 0xe1]))).toBe(true); // EXIF
    expect(hasAllowedImageMagic(buf([0xff, 0xd8, 0xff, 0xdb]))).toBe(true); // baseline
  });

  it('accepts PNG (89 50 4E 47 0D 0A 1A 0A)', () => {
    expect(hasAllowedImageMagic(buf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
  });

  it('accepts GIF (GIF87a and GIF89a)', () => {
    expect(hasAllowedImageMagic(buf([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]))).toBe(true); // GIF87a
    expect(hasAllowedImageMagic(buf([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe(true); // GIF89a
  });

  it('accepts WebP (RIFF....WEBP)', () => {
    // RIFF size word at 4..7 is arbitrary
    const webp = Buffer.from([
      0x52, 0x49, 0x46, 0x46, // RIFF
      0x10, 0x20, 0x30, 0x40, // size (anything)
      0x57, 0x45, 0x42, 0x50, // WEBP
      0x56, 0x50, 0x38, 0x20, // VP8 chunk start
    ]);
    expect(hasAllowedImageMagic(webp)).toBe(true);
  });

  it('rejects SVG (XML-based, no fixed binary magic)', () => {
    const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" />');
    expect(hasAllowedImageMagic(svg)).toBe(false);
  });

  it('rejects HTML (an attacker claiming image/jpeg)', () => {
    const html = Buffer.from('<!doctype html><script>alert(1)</script>');
    expect(hasAllowedImageMagic(html)).toBe(false);
  });

  it('rejects PDF (%PDF-)', () => {
    const pdf = Buffer.from('%PDF-1.4\n...');
    expect(hasAllowedImageMagic(pdf)).toBe(false);
  });

  it('rejects BMP / TIFF / HEIC (not in allowlist even though they are images)', () => {
    expect(hasAllowedImageMagic(buf([0x42, 0x4d]))).toBe(false); // BMP 'BM'
    expect(hasAllowedImageMagic(buf([0x49, 0x49, 0x2a, 0x00]))).toBe(false); // TIFF little-endian
    expect(hasAllowedImageMagic(buf([0x4d, 0x4d, 0x00, 0x2a]))).toBe(false); // TIFF big-endian
    // HEIC: brand 'ftypheic' at offset 4
    const heic = Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
    expect(hasAllowedImageMagic(heic)).toBe(false);
  });

  it('rejects empty / short buffers (must be ≥ 12 bytes to even check WebP)', () => {
    expect(hasAllowedImageMagic(Buffer.alloc(0))).toBe(false);
    expect(hasAllowedImageMagic(Buffer.from([0xff, 0xd8]))).toBe(false); // truncated JPEG
    expect(hasAllowedImageMagic(Buffer.from([0xff, 0xd8, 0xff]))).toBe(false); // 3 bytes, below the 12-byte floor
  });

  it('rejects a polyglot whose first byte differs from the four allowed magics', () => {
    // A ZIP-prefixed polyglot (PK..) that an attacker labels `image/jpeg`.
    // Sharp would reject it later, but we want the rejection earlier.
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    expect(hasAllowedImageMagic(buf([...zip]))).toBe(false);
  });
});
