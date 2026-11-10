import ads from '@/lib/ads';

// Google AdSense loader for the PUBLIC pages only (their CSP allows it; see
// lib/ads.js). React hoists an async script into <head> and loads it once,
// however many times it is rendered. With Auto ads on in AdSense, Google
// places the ads itself.
export default function AdSense() {
    return <script async src={ads.SCRIPT_URL} crossOrigin="anonymous" />;
}
