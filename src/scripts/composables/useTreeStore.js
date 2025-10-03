import { parentOf } from "../utils/path.js";
import { ref } from "vue";
import { idbGetAllByIndex, idbPutMany } from "../services/indexedDbService.js";

export function useTreeStore({
    getProjectRootHandleById,
    getFileHandleByPath,
    previewing,
    isTextLike,
    MAX_TEXT_BYTES,
    selectedProjectId
}) {
    const tree = ref([]);
    const activeTreePath = ref("");
    const isLoadingTree = ref(false);

    function buildTreeFromFlat(nodes) {
        const map = new Map();
        const roots = [];
        for (const n of nodes) {
            map.set(n.path, { ...n, children: n.type === "dir" ? [] : undefined });
        }
        for (const n of nodes) {
            const node = map.get(n.path);
            if (!n.parent) {
                roots.push(node);
            } else {
                const parent = map.get(n.parent);
                if (parent && parent.type === "dir") parent.children.push(node);
            }
        }
        const sorter = (a, b) =>
            a.type === b.type ? a.name.localeCompare(b.name) : (a.type === "dir" ? -1 : 1);
        const dfs = (node) => {
            if (node.children) {
                node.children.sort(sorter);
                node.children.forEach(dfs);
            }
        };
        roots.sort(sorter).forEach(dfs);
        return roots;
    }

    async function loadTreeFromDB(projectId) {
        const flat = await idbGetAllByIndex("nodes", "byProject", projectId);
        console.log(`[Tree] loaded flat nodes for ${projectId}:`, flat.length);
        return buildTreeFromFlat(flat);
    }

    async function scanAndIndexProject(projectId, dirHandle) {
        const queue = [{ handle: dirHandle, base: "" }];
        const nodes = [];

        for (const item of queue) {
            for await (const [name, handle] of item.handle.entries()) {
                const path = item.base ? `${item.base}/${name}` : name;
                if (handle.kind === "directory") {
                    nodes.push({
                        key: `${projectId}:${path}`,
                        projectId,
                        type: "dir",
                        name,
                        path,
                        parent: parentOf(path)
                    });
                    queue.push({ handle, base: path });
                } else {
                    let size = 0;
                    let lastModified = 0;
                    let mime = "";
                    try {
                        const file = await handle.getFile();
                        size = file.size;
                        lastModified = file.lastModified || 0;
                        mime = file.type || "";
                    } catch (_) {
                        // ignore file read errors
                    }
                    nodes.push({
                        key: `${projectId}:${path}`,
                        projectId,
                        type: "file",
                        name,
                        path,
                        parent: parentOf(path),
                        size,
                        lastModified,
                        mime,
                        isBig: size >= 50 * 1024 * 1024
                    });
                }
            }
        }

        await idbPutMany("nodes", nodes);
    }

    async function openNode(node) {
        if (!node) return;
        activeTreePath.value = node.path || "";
        if (node.type !== "file") return;
        try {
            if (previewing.value.url) {
                URL.revokeObjectURL(previewing.value.url);
            }
            const root = await getProjectRootHandleById(selectedProjectId.value);
            const fileHandle = await getFileHandleByPath(root, node.path);
            const file = await fileHandle.getFile();
            const mime = node.mime || file.type || "";
            const size = file.size;

            if (mime.startsWith("image/")) {
                const url = URL.createObjectURL(file);
                previewing.value = { name: node.name, mime, size, text: "", url, kind: "image", error: "" };
                return;
            }
            if (mime === "application/pdf" || node.path.toLowerCase().endsWith(".pdf")) {
                const url = URL.createObjectURL(file);
                previewing.value = { name: node.name, mime, size, text: "", url, kind: "pdf", error: "" };
                return;
            }
            if (isTextLike(node.name, mime) && size <= MAX_TEXT_BYTES) {
                const text = await file.text();
                previewing.value = {
                    name: node.name,
                    mime: mime || "text/plain",
                    size,
                    text,
                    url: "",
                    kind: "text",
                    error: ""
                };
                return;
            }
            const url = URL.createObjectURL(file);
            previewing.value = {
                name: node.name,
                mime: mime || "application/octet-stream",
                size,
                text: "",
                url,
                kind: "other",
                error: ""
            };
        } catch (error) {
            previewing.value = {
                name: node?.name || "",
                mime: "",
                size: 0,
                text: "",
                url: "",
                kind: "error",
                error: String(error)
            };
        }
    }

    function selectTreeNode(path) {
        activeTreePath.value = path || "";
    }

    return {
        tree,
        activeTreePath,
        isLoadingTree,
        buildTreeFromFlat,
        loadTreeFromDB,
        scanAndIndexProject,
        openNode,
        selectTreeNode
    };
}

