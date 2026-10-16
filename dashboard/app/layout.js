import './globals.css';

export const metadata = {
    title: 'ZiGBoT Dashboard',
    description: 'Configure ZiGBoT for your Discord servers: AI personality, role behaviour, and channels.'
};

export const viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }) {
    return (
        <html lang="en">
            <body>{children}</body>
        </html>
    );
}
