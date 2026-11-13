#!/usr/bin/env node
// Copies the Monaco editor runtime into public/monaco/vs so the Code Studio
// loads it from this site, not a CDN (the CSP only allows our own scripts).
// Runs before `next build` and `next dev`; the output is git-ignored.
const fs = require('node:fs');
const path = require('node:path');

const from = path.join(__dirname, '..', 'node_modules', 'monaco-editor', 'min', 'vs');
const to = path.join(__dirname, '..', 'public', 'monaco', 'vs');
if (!fs.existsSync(from)) {
    console.error('monaco-editor is not installed; run npm install in dashboard/.');
    process.exit(1);
}
fs.rmSync(to, { recursive: true, force: true });
fs.cpSync(from, to, { recursive: true });
console.log(`Copied Monaco to ${path.relative(process.cwd(), to)}`);
