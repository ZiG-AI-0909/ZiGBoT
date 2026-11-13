import TopBar from '@/components/TopBar';

// Shown instantly while a Studio page loads.
export default function LoadingStudio() {
    return (
        <div className="shell" aria-busy="true">
            <TopBar />
            <div className="skeleton" style={{ height: 36, maxWidth: 320, marginBottom: 16 }} />
            <div className="guild-grid">
                <div className="skeleton" />
                <div className="skeleton" />
                <div className="skeleton" />
            </div>
        </div>
    );
}
