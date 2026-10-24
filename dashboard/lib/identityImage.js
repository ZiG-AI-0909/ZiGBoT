/**
 * Custom bot identity: turn an uploaded picture into the avatar we store and
 * send to Discord. Server-side only (dashboard API routes); CommonJS so the
 * root test suite can exercise it.
 *
 *  - The real type comes from the file's own bytes: PNG, JPEG or WebP only
 *    (no GIF / animation). The name and MIME type the browser sent are ignored.
 *  - Size and dimension limits are checked before decoding, and the decoder
 *    has a pixel cap, so a "decompression bomb" is refused cheaply.
 *  - Re-encoding to a 512x512 PNG drops EXIF/GPS/XMP/ICC metadata (sharp
 *    keeps none unless asked) and turns WebP into a type Discord accepts
 *    (Discord's image data takes JPG, GIF and PNG).
 */
const crypto = require('node:crypto');
const sharp = require('sharp');
const { IDENTITY_LIMITS, detectImageType } = require('./shared/identity');

const ALLOWED = new Set(['png', 'jpeg', 'webp']);
const MAX_OUTPUT_BYTES = 1024 * 1024; // the storage bucket's per-file limit

class IdentityImageError extends Error {}

async function processAvatar(input) {
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
    if (bytes.length === 0) throw new IdentityImageError('The picture is empty.');
    if (bytes.length > IDENTITY_LIMITS.imageMaxBytes) throw new IdentityImageError(`Pictures can be at most ${IDENTITY_LIMITS.imageMaxBytes / (1024 * 1024)} MB.`);
    const type = detectImageType(bytes);
    if (!ALLOWED.has(type)) throw new IdentityImageError('Please upload a PNG, JPG or WebP picture.');

    const options = { limitInputPixels: IDENTITY_LIMITS.imageMaxPx * IDENTITY_LIMITS.imageMaxPx, failOn: 'error', animated: false };
    let meta;
    try {
        // Header only (nothing is decoded), so the pixel cap can wait for the
        // decode below and an oversized picture gets the clear message.
        meta = await sharp(bytes, { ...options, limitInputPixels: false }).metadata();
    } catch {
        throw new IdentityImageError('That picture could not be read. Please try another file.');
    }
    if (meta.format !== type && !(type === 'jpeg' && meta.format === 'jpg')) throw new IdentityImageError('That file isn’t really the picture type it claims to be.');
    if ((meta.pages || 1) > 1) throw new IdentityImageError('Animated pictures aren’t supported.');
    const { width = 0, height = 0 } = meta;
    if (width < IDENTITY_LIMITS.imageMinPx || height < IDENTITY_LIMITS.imageMinPx) throw new IdentityImageError(`Pictures must be at least ${IDENTITY_LIMITS.imageMinPx}×${IDENTITY_LIMITS.imageMinPx} pixels.`);
    if (width > IDENTITY_LIMITS.imageMaxPx || height > IDENTITY_LIMITS.imageMaxPx) throw new IdentityImageError(`Pictures can be at most ${IDENTITY_LIMITS.imageMaxPx}×${IDENTITY_LIMITS.imageMaxPx} pixels.`);

    const size = IDENTITY_LIMITS.avatarPx;
    const render = (png) => sharp(bytes, options)
        .rotate() // apply the EXIF orientation before the metadata is dropped
        .resize(size, size, { fit: 'cover', position: 'centre' })
        .png(png)
        .toBuffer();
    let output;
    try {
        output = await render({ compressionLevel: 9 });
        if (output.length > MAX_OUTPUT_BYTES) output = await render({ compressionLevel: 9, palette: true });
    } catch {
        throw new IdentityImageError('That picture could not be processed. Please try another file.');
    }
    if (output.length > MAX_OUTPUT_BYTES) throw new IdentityImageError('That picture is too detailed to use. Please try a simpler one.');
    return { png: output, sha256: crypto.createHash('sha256').update(output).digest('hex'), width: size, height: size };
}

module.exports = { processAvatar, IdentityImageError };
