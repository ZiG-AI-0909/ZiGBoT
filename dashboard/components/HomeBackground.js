// Animated homepage backdrop: drifting neon blobs, a scrolling synthwave grid,
// and floating stickers. Pure CSS (globals.css, .bg-*), decorative only.
const STICKERS = [
    { text: '💀', left: '6%', delay: '0s', duration: '19s' },
    { text: 'no cap', left: '18%', delay: '-7s', duration: '23s' },
    { text: '🔥', left: '31%', delay: '-13s', duration: '17s' },
    { text: 'W', left: '44%', delay: '-3s', duration: '21s' },
    { text: '😭', left: '57%', delay: '-10s', duration: '18s' },
    // Kept out of the landing hero's mascot column (which also has a solid
    // backdrop, so stickers pass behind it rather than through it).
    { text: 'fr fr', left: '3%', delay: '-16s', duration: '24s' },
    { text: '✨', left: '80%', delay: '-5s', duration: '20s' },
    { text: '🗿', left: '91%', delay: '-12s', duration: '22s' },
    { text: 'slay', left: '12%', delay: '-18s', duration: '26s' },
    { text: '👀', left: '75%', delay: '-21s', duration: '16s' }
];

export default function HomeBackground() {
    return (
        <div className="bg-fx" aria-hidden="true">
            <div className="bg-blob bg-blob-1" />
            <div className="bg-blob bg-blob-2" />
            <div className="bg-blob bg-blob-3" />
            <div className="bg-grid" />
            {STICKERS.map((s) => (
                <span key={s.text} className="bg-sticker" style={{ left: s.left, animationDelay: s.delay, animationDuration: s.duration }}>{s.text}</span>
            ))}
        </div>
    );
}
