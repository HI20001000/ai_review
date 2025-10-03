const DB_NAME = "projects-db";
const DB_VERSION = 3;

export function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;

            if (!db.objectStoreNames.contains("projects")) {
                db.createObjectStore("projects", { keyPath: "id" });
            }

            let nodesStore;
            if (!db.objectStoreNames.contains("nodes")) {
                nodesStore = db.createObjectStore("nodes", { keyPath: "key" });
            } else {
                nodesStore = req.transaction.objectStore("nodes");
            }

            const needByProject = !nodesStore.indexNames.contains("byProject");
            const needByParent = !nodesStore.indexNames.contains("byParent");
            if (needByProject) nodesStore.createIndex("byProject", "projectId", { unique: false });
            if (needByParent) nodesStore.createIndex("byParent", "parent", { unique: false });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export async function idbPut(store, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readwrite");
        tx.objectStore(store).put(value);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

export async function idbPutMany(store, values) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readwrite");
        const os = tx.objectStore(store);
        values.forEach((v) => os.put(v));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

export async function idbGetAll(store) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readonly");
        const req = tx.objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

export async function idbGetAllByIndex(store, indexName, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction(store, "readonly");
            const os = tx.objectStore(store);

            if (os.indexNames.contains(indexName)) {
                const idx = os.index(indexName);
                const req = idx.getAll(value);
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => reject(req.error);
            } else {
                console.warn(`IndexedDB index "${indexName}" not found on store "${store}". Fallback to getAll.`);
                const req = os.getAll();
                req.onsuccess = () => {
                    const all = req.result || [];
                    const out =
                        indexName === "byProject" ? all.filter((r) => r.projectId === value) :
                        indexName === "byParent" ? all.filter((r) => r.parent === value) :
                        all;
                    resolve(out);
                };
                req.onerror = () => reject(req.error);
            }
        } catch (err) {
            reject(err);
        }
    });
}

export async function idbDelete(store, key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readwrite");
        tx.objectStore(store).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

export async function idbDeleteNodesByProject(projectId) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction("nodes", "readwrite");
            const store = tx.objectStore("nodes");

            if (store.indexNames.contains("byProject")) {
                const index = store.index("byProject");
                const range = IDBKeyRange.only(projectId);
                const cursorReq = index.openKeyCursor(range);

                cursorReq.onsuccess = () => {
                    const cursor = cursorReq.result;
                    if (cursor) {
                        store.delete(cursor.primaryKey);
                        cursor.continue();
                    } else {
                        resolve();
                    }
                };
                cursorReq.onerror = () => reject(cursorReq.error);

                tx.onerror = () => reject(tx.error);
                return;
            }

            const allReq = store.getAll();
            allReq.onsuccess = () => {
                const all = allReq.result || [];
                for (const rec of all) {
                    if (rec.projectId === projectId) {
                        store.delete(rec.key);
                    }
                }
            };
            allReq.onerror = () => reject(allReq.error);

            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        } catch (err) {
            reject(err);
        }
    });
}
