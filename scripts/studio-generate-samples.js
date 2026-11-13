#!/usr/bin/env node
/**
 * Writes one sample project per Studio framework x template into a folder,
 * for the CI checks (tsc --noEmit, python -m py_compile, and each project's
 * own tests). Usage: node scripts/studio-generate-samples.js <out-dir>
 * Only writes files; it never runs generated code.
 */
const fs = require('node:fs');
const path = require('node:path');
const { generateProject } = require('../dashboard/lib/studio/generators');
const { FRAMEWORKS, TEMPLATES } = require('../dashboard/lib/studio/projects');

const out = path.resolve(process.argv[2] || 'studio-samples');
let count = 0;
for (const framework of FRAMEWORKS) {
    for (const template of TEMPLATES) {
        const dir = path.join(out, `${framework.id}-${template.id}`);
        fs.rmSync(dir, { recursive: true, force: true });
        for (const file of generateProject({ name: `Sample ${template.id}`, botName: 'Helper', framework: framework.id, template: template.id })) {
            const target = path.join(dir, file.path);
            if (!target.startsWith(dir + path.sep)) throw new Error(`Unsafe path: ${file.path}`);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, file.content);
            count += 1;
        }
    }
}
console.log(`Wrote ${count} files to ${out}`);
