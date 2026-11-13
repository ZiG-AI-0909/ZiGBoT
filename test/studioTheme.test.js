// Platform Phase 2: futuristic Studio (theme, IDE workspace, live indicators), practical and accessible.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', 'dashboard', ...p), 'utf8');
const css = read('app', 'globals.css');

test('Studio theme wraps every Studio page; decorative layers are hidden from assistive tech and inert', () => {
    const layout = read('app', 'studio', 'layout.js');
    assert.match(layout, /<div className="studio-theme">/);
    assert.match(layout, /<div className="studio-bg" aria-hidden="true">/);
    assert.match(css, /\.studio-bg \{ position: fixed; inset: 0; z-index: -1; overflow: hidden; pointer-events: none; \}/);
    assert.match(css, /animation: studio-drift/);
    assert.match(css, /@keyframes studio-drift \{ from \{ transform: translate3d/, 'GPU-friendly transform animation');
});

test('reduced motion stops the background and pulsing indicators', () => {
    const block = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
    assert.match(block, /\.studio-bg \.orb, \.live-dot\.is-busy \{ animation: none; \}/);
});

test('Code is an IDE: explorer, editor, AI assistant, console and a status bar', () => {
    const code = read('components', 'studio', 'CodeStudio.js');
    for (const area of ['ide-explorer', 'ide-editor', 'ide-assistant', 'ide-console', 'ide-status']) assert.ok(code.includes(area), area);
    assert.match(css, /grid-template-areas: "explorer editor assistant" "console console console"/);
    assert.match(css, /@media \(max-width: 720px\) \{ \.ide \{ grid-template-columns: 1fr;/, 'phones get one column');
    assert.match(code, /await call\(`\$\{base\}\/agent`, \{ method: 'POST'/, 'assistant creates a proposal with the user\'s own key (approve elsewhere)');
    assert.doesNotMatch(code.slice(code.indexOf('function AssistantPane'), code.indexOf('export default')), /\/file`, \{ method: 'PUT'/, 'assistant never writes files');
});

test('live indicators: status bar, assistant, simulator console', () => {
    assert.match(read('components', 'studio', 'CodeStudio.js'), /live-dot \$\{busyCheck \? 'is-busy'/);
    const builder = read('components', 'studio', 'WorkflowBuilder.js');
    assert.match(builder, /Execution console/);
    assert.match(builder, /className="sim-console"/);
    assert.match(read('app', 'studio', 'page.js'), /className="studio-hero"/);
});
