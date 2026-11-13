/**
 * Rank card image (Section G), drawn with @napi-rs/canvas. No network
 * access; shows only the name, level, XP progress and rank. PNG Buffer.
 */
const { createCanvas } = require('@napi-rs/canvas');

const WIDTH = 800;
const HEIGHT = 220;

function renderRankCard({ name, level, into, needed, rank }) {
    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#16112b';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = '#a855f7';
    ctx.fillRect(0, 0, 10, HEIGHT);

    ctx.fillStyle = '#ffffff';
    let size = 44;
    const shown = String(name || 'Member').slice(0, 32);
    do {
        ctx.font = `bold ${size}px sans-serif`;
        size -= 2;
    } while (ctx.measureText(shown).width > 470 && size > 16);
    ctx.fillText(shown, 40, 75);

    ctx.textAlign = 'right';
    ctx.fillStyle = '#e9d5ff';
    ctx.font = 'bold 30px sans-serif';
    ctx.fillText(`LEVEL ${level}`, WIDTH - 40, 70);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '24px sans-serif';
    ctx.fillText(rank ? `RANK #${rank}` : 'UNRANKED', WIDTH - 40, 105);

    const x = 40;
    const y = 140;
    const w = WIDTH - 80;
    const h = 30;
    ctx.fillStyle = '#334155';
    ctx.fillRect(x, y, w, h);
    const share = needed > 0 ? Math.max(0, Math.min(1, into / needed)) : 0;
    ctx.fillStyle = '#22d3ee';
    ctx.fillRect(x, y, Math.round(w * share), h);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '20px sans-serif';
    ctx.fillText(`${into} / ${needed} XP`, x, y + h + 28);
    return canvas.toBuffer('image/png');
}

module.exports = { renderRankCard, WIDTH, HEIGHT };
