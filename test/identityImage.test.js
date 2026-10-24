const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// Custom bot identity avatars: dashboard/lib/identityImage.js with real images
// made by sharp (the dashboard dependency the pipeline uses).
const sharp = require('../dashboard/node_modules/sharp');
const { processAvatar, IdentityImageError } = require('../dashboard/lib/identityImage');

const solid = (width, height, format, extra = (s) => s) => extra(sharp({ create: { width, height, channels: 3, background: '#7c3aed' } }))[format]().toBuffer();

async function rejectsWith(input, pattern) {
    await assert.rejects(() => processAvatar(input), (error) => error instanceof IdentityImageError && pattern.test(error.message));
}

test('a JPEG with EXIF/GPS-style metadata becomes a clean 512x512 PNG', async () => {
    const jpeg = await solid(900, 600, 'jpeg', (s) => s.withExif({ IFD0: { Copyright: 'SECRET-EXIF-MARK', ImageDescription: 'taken at 28.6139N 77.2090E' } }));
    assert.ok(jpeg.includes('SECRET-EXIF-MARK'), 'the input really carries metadata');
    const out = await processAvatar(jpeg);
    const meta = await sharp(out.png).metadata();
    assert.equal(meta.format, 'png');
    assert.deepEqual([meta.width, meta.height], [512, 512]);
    assert.equal(meta.exif, undefined, 'EXIF removed');
    assert.equal(meta.xmp, undefined);
    assert.ok(!out.png.includes('SECRET-EXIF-MARK') && !out.png.includes('28.6139'));
    assert.equal(out.sha256, crypto.createHash('sha256').update(out.png).digest('hex'));
});

test('WebP is converted to PNG (Discord takes JPG, GIF and PNG); PNG stays PNG', async () => {
    for (const format of ['webp', 'png']) {
        const out = await processAvatar(await solid(300, 300, format));
        assert.equal((await sharp(out.png).metadata()).format, 'png', format);
    }
});

test('GIFs, animated pictures, and files that only pretend to be images are refused', async () => {
    await rejectsWith(await solid(300, 300, 'gif'), /PNG, JPG or WebP/);
    const frame = (color) => sharp({ create: { width: 200, height: 200, channels: 4, background: color } }).webp().toBuffer();
    const animated = await sharp([await frame('#f00'), await frame('#00f')], { join: { animated: true } }).webp().toBuffer();
    await rejectsWith(animated, /Animated/);
    await rejectsWith(Buffer.concat([Buffer.from('MZ\x90\0\x03\0\0\0'), crypto.randomBytes(400)]), /PNG, JPG or WebP/);
    await rejectsWith(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"></svg>'), /PNG, JPG or WebP/);
    // A real PNG header followed by garbage.
    await rejectsWith(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(300)]), /could not be read/);
    await rejectsWith(Buffer.alloc(0), /empty/);
});

test('size and dimension limits (including a tiny file that decodes to a huge image)', async () => {
    await rejectsWith(await solid(100, 300, 'png'), /at least 128/);
    // Highly compressible: under the 2 MB upload limit on disk, 4097x4097 pixels once decoded.
    const bomb = await sharp({ create: { width: 4097, height: 4097, channels: 3, background: '#7c3aed' } }).png({ compressionLevel: 9 }).toBuffer();
    assert.ok(bomb.length < 2 * 1024 * 1024, `the bomb passes the size limit (${bomb.length} bytes)`);
    await rejectsWith(bomb, /at most 4096/);
    await rejectsWith(Buffer.concat([await solid(200, 200, 'png'), Buffer.alloc(2 * 1024 * 1024)]), /at most 2 MB/);
    const ok = await processAvatar(await solid(4096, 128, 'png'));
    assert.deepEqual([(await sharp(ok.png).metadata()).width, (await sharp(ok.png).metadata()).height], [512, 512], 'wide pictures are cropped to a square');
});
