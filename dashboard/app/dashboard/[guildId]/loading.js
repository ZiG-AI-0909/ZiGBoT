import TopBar from '@/components/TopBar';

// Shown instantly while the server's settings are verified and loaded.
export default function LoadingGuild() {
    return (
        <div className="shell" aria-busy="true">
            <TopBar />
            <span className="small muted">← All servers</span>
            <div className="spread" style={{ marginTop: 16 }}>
                <div className="row">
                    <div className="guild-icon skeleton" style={{ minHeight: 48 }} />
                    <div>
                        <h1>Loading server…</h1>
                        <p className="muted small">Checking your permissions with Discord</p>
                    </div>
                </div>
            </div>
            <div className="tabs" />
            <div className="stack">
                <div className="skeleton" />
                <div className="skeleton" />
                <div className="skeleton" />
            </div>
        </div>
    );
}
