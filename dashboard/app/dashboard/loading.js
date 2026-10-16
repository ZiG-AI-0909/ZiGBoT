import TopBar from '@/components/TopBar';

// Shown instantly while the server list loads.
export default function LoadingServers() {
    return (
        <div className="shell" aria-busy="true">
            <TopBar />
            <h1>Your servers</h1>
            <div className="guild-grid" style={{ marginTop: 20 }}>
                <div className="skeleton" />
                <div className="skeleton" />
                <div className="skeleton" />
            </div>
        </div>
    );
}
