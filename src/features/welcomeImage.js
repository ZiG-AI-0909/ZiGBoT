/**
 * Welcome image card (Section C), drawn with @napi-rs/canvas: no network
 * access and no member data beyond the name shown. Returns a PNG Buffer.
 */
const { createCanvas } = require('@napi-rs/canvas');

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

module.exports = { renderWelcomeImage, WIDTH, HEIGHT };
