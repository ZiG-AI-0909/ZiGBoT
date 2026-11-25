/**
 * Welcome image card (Section C), drawn with @napi-rs/canvas: no network
 * access and no member data beyond the name shown. Returns a PNG Buffer.
 */
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

const WIDTH = 800;
const HEIGHT = 250;

// Shrinks the text until it fits the card.
function fitText(ctx, text, maxWidth, size, weight = 'bold') {
    let px = size;
    do {
        ctx.font = `${weight} ${px}px sans-serif`;
        px -= 2;
    } while (ctx.measureText(text).width > maxWidth && px > 14);
}

function renderWelcomeImage({ name, server, memberCount }) {
    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
    gradient.addColorStop(0, '#1a1030');
    gradient.addColorStop(0.55, '#3b1d6e');
    gradient.addColorStop(1, '#0e7490');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 4;
    ctx.strokeRect(14, 14, WIDTH - 28, HEIGHT - 28);

    ctx.textAlign = 'center';
    ctx.fillStyle = '#e9d5ff';
    ctx.font = 'bold 30px sans-serif';
    ctx.fillText('WELCOME', WIDTH / 2, 70);
    ctx.fillStyle = '#ffffff';
    const shown = String(name || 'New member').slice(0, 40);
    fitText(ctx, shown, WIDTH - 120, 60);
    ctx.fillText(shown, WIDTH / 2, 140);
    ctx.fillStyle = '#cbd5e1';
    const line = `to ${String(server || 'the server').slice(0, 50)}${Number.isFinite(memberCount) ? ` · member #${memberCount}` : ''}`;
    fitText(ctx, line, WIDTH - 120, 28, 'normal');
    ctx.fillText(line, WIDTH / 2, 195);
    return canvas.toBuffer('image/png');
}

/** Encode a subtle animated version of the welcome card as a short looping GIF. */
async function renderWelcomeGif(input, { durationSeconds = 2.4, fps = 8 } = {}) {
    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');
    const image = await loadImage(renderWelcomeImage(input));
    for (let frame = 0; frame < Math.ceil(durationSeconds * fps); frame++) {
        const phase = frame / fps;
        // Keep the original card artwork and subtly animate a soft sheen across it.
        ctx.clearRect(0, 0, WIDTH, HEIGHT);
        ctx.drawImage(image, 0, 0, WIDTH, HEIGHT);
        const x = ((phase / durationSeconds) * (WIDTH + 220)) - 110;
        const sheen = ctx.createLinearGradient(x - 90, 0, x + 90, 0);
        sheen.addColorStop(0, 'rgba(255,255,255,0)');
        sheen.addColorStop(0.5, `rgba(255,255,255,${0.10 + 0.04 * Math.sin(phase * Math.PI * 2 / durationSeconds)})`);
        sheen.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = sheen;
        ctx.fillRect(0, 0, WIDTH, HEIGHT);
        const rgba = ctx.getImageData(0, 0, WIDTH, HEIGHT).data;
        const palette = quantize(rgba, 64);
        const indexed = applyPalette(rgba, palette);
        if (frame === 0) {
            var encoder = GIFEncoder();
        }
        encoder.writeFrame(indexed, WIDTH, HEIGHT, { palette, delay: 1000 / fps, repeat: 0 });
    }
    encoder.finish();
    return Buffer.from(encoder.bytes());
}

module.exports = { renderWelcomeImage, renderWelcomeGif, WIDTH, HEIGHT };
