/**
 * Line diff for the version-history view (Myers-style via LCS table, bounded).
 * diffLines(a, b) → [{ type: 'same'|'add'|'del', text }]. Pure, CommonJS.
 */
const MAX_LINES = 4000;

function diffLines(before, after) {
    const a = String(before ?? '').split('\n');
    const b = String(after ?? '').split('\n');
    if (a.length > MAX_LINES || b.length > MAX_LINES) {
        return [{ type: 'del', text: `(${a.length} lines)` }, { type: 'add', text: `(${b.length} lines: too large to diff line by line)` }];
    }
    // Trim the common head and tail first: most saves change a few lines.
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
    let endA = a.length - 1;
    let endB = b.length - 1;
    while (endA >= start && endB >= start && a[endA] === b[endB]) { endA -= 1; endB -= 1; }
    const midA = a.slice(start, endA + 1);
    const midB = b.slice(start, endB + 1);
    const lcs = Array.from({ length: midA.length + 1 }, () => new Uint16Array(midB.length + 1));
    for (let i = midA.length - 1; i >= 0; i -= 1) {
        for (let j = midB.length - 1; j >= 0; j -= 1) {
            lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
    }
    const out = a.slice(0, start).map((text) => ({ type: 'same', text }));
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
        if (midA[i] === midB[j]) { out.push({ type: 'same', text: midA[i] }); i += 1; j += 1; }
        else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ type: 'del', text: midA[i] }); i += 1; }
        else { out.push({ type: 'add', text: midB[j] }); j += 1; }
    }
    while (i < midA.length) out.push({ type: 'del', text: midA[i++] });
    while (j < midB.length) out.push({ type: 'add', text: midB[j++] });
    for (const text of a.slice(endA + 1)) out.push({ type: 'same', text });
    return out;
}

module.exports = { diffLines };
