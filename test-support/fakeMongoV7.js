/**
 * In-memory MongoDB client fake with mongodb driver v7 return shapes
 * (findOneAndUpdate resolves to the document itself, not { value }). Lives
 * outside test/ so `node --test` does not run it as a test file.
 *
 * Supports the operator subset brain.js uses: equality, $lt, $gte, $in,
 * $regex/$options, $set, $setOnInsert, $inc, upsert, sort/skip/limit.
 */
function matches(doc, filter) {
    return Object.entries(filter).every(([key, expected]) => {
        if (expected !== null && typeof expected === 'object' && !(expected instanceof Date)) {
            const ops = Object.keys(expected);
            if (!ops.every((op) => ['$lt', '$gte', '$regex', '$options', '$in'].includes(op))) return false;
            if (expected.$in !== undefined && !expected.$in.includes(doc[key])) return false;
            if (expected.$lt !== undefined && !(doc[key] < expected.$lt)) return false;
            if (expected.$gte !== undefined && !(doc[key] >= expected.$gte)) return false;
            if (expected.$regex !== undefined && !new RegExp(expected.$regex, expected.$options || '').test(String(doc[key] ?? ''))) return false;
            return true;
        }
        return doc[key] === expected;
    });
}

function plainFields(filter) {
    return Object.fromEntries(Object.entries(filter).filter(([, v]) => v === null || typeof v !== 'object'));
}

function v7Client({ legacyFindOneAndUpdate = false } = {}) {
    const collections = new Map();
    const usedDbNames = [];
    const createdIndexes = [];
    function collection(name) {
        if (collections.has(name)) return collections.get(name);
        const docs = [];
        const store = {
            docs,
            async createIndex(spec, options) { createdIndexes.push({ name, spec, options }); return 'idx'; },
            async insertOne(doc) { docs.push({ ...doc }); return { acknowledged: true }; },
            async findOne(filter) {
                const doc = docs.find((d) => matches(d, filter));
                return doc ? { ...doc } : null;
            },
            async updateOne(filter, update, options = {}) {
                let doc = docs.find((d) => matches(d, filter));
                let upserted = false;
                if (!doc && options.upsert) { doc = plainFields(filter); docs.push(doc); upserted = true; }
                if (doc && update.$set) Object.assign(doc, update.$set);
                if (doc && upserted && update.$setOnInsert) Object.assign(doc, update.$setOnInsert);
                return { acknowledged: true, matchedCount: doc && !upserted ? 1 : 0, upsertedCount: upserted ? 1 : 0 };
            },
            async countDocuments(filter) { return docs.filter((d) => matches(d, filter)).length; },
            async deleteOne(filter) {
                const index = docs.findIndex((d) => matches(d, filter));
                if (index < 0) return { deletedCount: 0 };
                docs.splice(index, 1);
                return { deletedCount: 1 };
            },
            async deleteMany(filter) {
                const keep = docs.filter((d) => !matches(d, filter));
                const deletedCount = docs.length - keep.length;
                docs.splice(0, docs.length, ...keep);
                return { deletedCount };
            },
            find(filter) {
                let sortSpec = {};
                let skipCount = 0;
                let limitCount = 0;
                return {
                    sort(spec) { sortSpec = spec; return this; },
                    skip(n) { skipCount = n; return this; },
                    limit(n) { limitCount = n; return this; },
                    async toArray() {
                        const rows = docs.filter((d) => matches(d, filter)).map((d) => ({ ...d }));
                        rows.sort((a, b) => {
                            for (const [key, dir] of Object.entries(sortSpec)) {
                                if (a[key] !== b[key]) return (a[key] - b[key]) * dir;
                            }
                            return 0;
                        });
                        const skipped = rows.slice(skipCount);
                        return limitCount > 0 ? skipped.slice(0, limitCount) : skipped;
                    }
                };
            },
            async findOneAndUpdate(filter, update, options = {}) {
                let doc = docs.find((d) => matches(d, filter));
                const before = doc ? { ...doc } : null;
                if (!doc && options.upsert) { doc = plainFields(filter); docs.push(doc); }
                if (doc && update.$inc) for (const [k, v] of Object.entries(update.$inc)) doc[k] = (doc[k] || 0) + v;
                if (doc && update.$set) Object.assign(doc, update.$set);
                const value = doc && options.returnDocument === 'after' ? { ...doc } : before;
                // Driver v5 shape, only to prove the old destructuring is gone.
                if (legacyFindOneAndUpdate) return { value, ok: 1 };
                return options.includeResultMetadata ? { value, ok: 1 } : value;
            }
        };
        collections.set(name, store);
        return store;
    }
    return {
        collections,
        usedDbNames,
        createdIndexes,
        collection,
        db(name) { usedDbNames.push(name); return { collection }; },
        async connect() {}
    };
}

module.exports = { v7Client, matches };
