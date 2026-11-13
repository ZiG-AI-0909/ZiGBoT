'use client';

import { useState } from 'react';
import AgentBuilder from './AgentBuilder';
import AiCreator from './AiCreator';

/** Prompt Engineering workspace: external coding agents + ZiGBoT's AI creator, sharing one proposal list. */
export default function AiWorkspace({ projectId, language }) {
    const [version, setVersion] = useState(0);
    return (
        <div className="stack">
            <AgentBuilder projectId={projectId} language={language} onProposal={() => setVersion((v) => v + 1)} />
            <h2 style={{ marginBottom: 0 }}>Proposals</h2>
            <p className="help" style={{ marginTop: 0 }}>From your coding agent or ZiGBoT&apos;s built-in AI creator. Approve to write, reject to discard.</p>
            <AiCreator key={version} projectId={projectId} />
        </div>
    );
}
