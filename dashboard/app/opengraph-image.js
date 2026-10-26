import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ImageResponse } from 'next/og';
import seo from '@/lib/seo';

// Link-preview image (Open Graph / Twitter), built at build time from the
// ZiG mascot (public/zigbot.png). Uses next/og, which ships with Next.js.
export const alt = seo.OG_IMAGE.alt;
export const size = { width: seo.OG_IMAGE.width, height: seo.OG_IMAGE.height };
export const contentType = 'image/png';

export default async function OpenGraphImage() {
    const mascot = await readFile(path.join(process.cwd(), 'public', 'zigbot.png'));
    const src = `data:image/png;base64,${mascot.toString('base64')}`;
    return new ImageResponse(
        (
            <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', gap: 56, padding: '0 80px', background: 'linear-gradient(135deg, #07000d 0%, #1c0736 55%, #2e0b4f 100%)', color: '#f4efff', fontFamily: 'sans-serif' }}>
                <img src={src} width={380} height={380} style={{ borderRadius: 190, boxShadow: '0 0 80px rgba(192, 132, 252, 0.6)' }} alt="" />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 620 }}>
                    <div style={{ fontSize: 88, fontWeight: 800, letterSpacing: 2, color: '#e879f9' }}>ZiGBoT</div>
                    <div style={{ fontSize: 40, lineHeight: 1.2 }}>The Discord bot with a personality and memory you control.</div>
                    <div style={{ fontSize: 28, color: '#c4b5fd' }}>zigbotai.vercel.app</div>
                </div>
            </div>
        ),
        size
    );
}
