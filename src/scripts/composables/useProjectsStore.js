import { ref } from "vue";
import { idbDelete, idbDeleteNodesByProject, idbGetAll, idbPut, idbPutMany } from "../services/indexedDbService.js";
import { parentOf } from "../utils/path.js";

export function useProjectsStore({ preview, fileSystem }) {
    const showUploadModal = ref(false);
    const projects = ref([]);
    const selectedProjectId = ref(null);
    const supportsFS = ref(false);
    const supportsOPFS = ref(false);

    const inMemoryHandles = new Map();
    let treeStore = null;

    function setTreeStore(store) {
        treeStore = store;
    }

    function sanitizeRecord(rec) {
        return { id: rec.id, name: rec.name, mode: rec.mode, createdAt: rec.createdAt ?? Date.now() };
    }

    async function saveProjectRecord(record, handleIfAny) {
        await idbPut("projects", sanitizeRecord(record));
        if (handleIfAny) inMemoryHandles.set(record.id, handleIfAny);
    }

    async function loadProjectsFromDB() {
        const saved = await idbGetAll("projects");
        projects.value = saved.map(sanitizeRecord).sort((a, b) => a.name.localeCompare(b.name));
    }

    async function cleanupLegacyHandles() {
        const all = await idbGetAll("projects");
        for (const rec of all) {
            if ("handle" in rec) await idbPut("projects", sanitizeRecord(rec));
        }
    }

    function explainFSerror(error) {
        if (!error) return "Unknown file-system error";
        switch (error.name) {
            case "SecurityError": return "This operation requires HTTPS or localhost.";
            case "NotAllowedError": return "User denied the permission request.";
            case "AbortError": return "Operation was aborted.";
            case "TypeError": return "Required file-system API is not supported by the browser.";
            default: return `${error.name || "Error"}: ${error.message || error}`;
        }
    }

    async function safeAlertFail(prefix, error) {
        console.error(prefix, error);
        alert(`${prefix}\nReason: ${explainFSerror(error)}\nHint: Use Chrome/Edge on localhost or HTTPS.`);
    }

    async function getProjectRootHandleById(projectId) {
        const rec = projects.value.find((p) => p.id === projectId);
        if (!rec) throw new Error("Project not found");
        if (rec.mode === "opfs") {
            const root = await fileSystem.getViewFolderDir();
            if (!root) throw new Error("OPFS root directory is unavailable");
            return await root.getDirectoryHandle(rec.name);
        }
        const handle = inMemoryHandles.get(rec.id);
        if (!handle) throw new Error("External project handle is missing");
        return handle;
    }

    function resetSelectionState() {
        preview.resetPreview();
        treeStore?.selectTreeNode("");
        if (treeStore) treeStore.tree.value = [];
        selectedProjectId.value = null;
        if (treeStore) treeStore.isLoadingTree.value = false;
    }

    async function openProject(project) {
        if (!project) return;
        if (!treeStore) throw new Error("Tree store is not initialised");

        const currentId = project.id;
        selectedProjectId.value = currentId;
        preview.resetPreview();
        treeStore.selectTreeNode("");
        treeStore.tree.value = [];
        treeStore.isLoadingTree.value = true;
        try {
            const built = await treeStore.loadTreeFromDB(currentId);
            if (selectedProjectId.value === currentId) {
                treeStore.tree.value = built;
                console.log(`[Tree] built for ${currentId}: roots=${built.length}`);
            }
        } catch (error) {
            if (selectedProjectId.value === currentId) {
                await safeAlertFail("Failed to build project tree", error);
            }
        } finally {
            if (selectedProjectId.value === currentId) {
                treeStore.isLoadingTree.value = false;
            }
        }
    }

    function collapseProject() {
        resetSelectionState();
    }

    async function importDirCommon(dirHandle) {
        if (!treeStore) throw new Error("Tree store is not initialised");
        const projectName = dirHandle.name;
        let mode = "external";
        let opfsRoot = null;

        if (supportsOPFS.value) {
            try {
                opfsRoot = await fileSystem.getViewFolderDir();
                if (!opfsRoot) throw new Error("OPFS root directory is unavailable");
                const destRoot = await opfsRoot.getDirectoryHandle(projectName, { create: true });
                await fileSystem.copyDirectorySafe(dirHandle, destRoot);
                mode = "opfs";
            } catch (error) {
                console.warn("OPFS import failed, falling back to external mode", error);
                mode = "external";
                opfsRoot = null;
            }
        }

        const record = { id: `${mode}:${projectName}`, name: projectName, mode, createdAt: Date.now() };
        await saveProjectRecord(record, mode === "external" ? dirHandle : null);
        await loadProjectsFromDB();
        selectedProjectId.value = record.id;

        try {
            const rootHandle = mode === "opfs"
                ? await opfsRoot.getDirectoryHandle(projectName)
                : dirHandle;

            await idbDeleteNodesByProject(record.id);
            await treeStore.scanAndIndexProject(record.id, rootHandle);
            treeStore.tree.value = await treeStore.loadTreeFromDB(record.id);
        } catch (error) {
            console.warn("Import operation hit an error; resulting data may be incomplete", error);
        }
    }

    async function pickFolderAndImport() {
        try {
            const handle = await window.showDirectoryPicker({ mode: "read" });
            await importDirCommon(handle);
            showUploadModal.value = false;
        } catch (error) {
            if (error?.name !== "AbortError") {
                await safeAlertFail("Failed to import folder", error);
            }
        }
    }

    async function deleteProject(event, project) {
        event?.stopPropagation?.();
        const ok = confirm(`Delete project ${project.name}? (OPFS files stay on disk)`);
        if (!ok) return;
        try {
            await idbDelete("projects", project.id);
            await idbDeleteNodesByProject(project.id);
            inMemoryHandles.delete(project.id);
            location.reload();
        } catch (error) {
            await safeAlertFail("Failed to delete project", error);
        }
    }

    async function handleDrop(event) {
        event.preventDefault();
        const items = event.dataTransfer?.items;
        if (!items) return;

        for (const item of items) {
            try {
                if ("getAsFileSystemHandle" in item) {
                    const handle = await item.getAsFileSystemHandle();
                    if (handle?.kind === "directory") await importDirCommon(handle);
                }
            } catch (error) {
                await safeAlertFail("Failed to import dropped folder", error);
            }
        }
        showUploadModal.value = false;
    }

    function handleDragOver(event) {
        event.preventDefault();
    }

    async function handleFolderInput(event) {
        if (!treeStore) throw new Error("Tree store is not initialised");
        const files = Array.from(event.target.files || []);
        if (!files.length) return;

        const first = files[0];
        const rootName = (first.webkitRelativePath || "").split("/")[0] || "ImportedProject";
        const projectId = `external:${rootName}`;

        const record = { id: projectId, name: rootName, mode: "external", createdAt: Date.now() };
        await saveProjectRecord(record, null);
        await idbDeleteNodesByProject(projectId);

        const dirSet = new Set();
        const fileNodes = [];

        for (const file of files) {
            let relPath = file.webkitRelativePath || file.name;
            if (file.webkitRelativePath && relPath.startsWith(rootName + "/")) {
                relPath = relPath.slice(rootName.length + 1);
            }
            const name = relPath.split("/").pop();
            const parent = parentOf(relPath);

            if (parent) {
                let acc = "";
                for (const segment of parent.split("/")) {
                    acc = acc ? `${acc}/${segment}` : segment;
                    dirSet.add(acc);
                }
            }

            fileNodes.push({
                key: `${projectId}:${relPath}`,
                projectId,
                type: "file",
                name,
                path: relPath,
                parent,
                size: file.size,
                lastModified: file.lastModified || 0,
                mime: file.type || "",
                isBig: file.size >= 50 * 1024 * 1024
            });
        }

        const dirNodes = Array.from(dirSet).map((path) => ({
            key: `${projectId}:${path}`,
            projectId,
            type: "dir",
            name: path.split("/").pop(),
            path,
            parent: parentOf(path)
        }));

        await idbPutMany("nodes", [...dirNodes, ...fileNodes]);
        await loadProjectsFromDB();
        selectedProjectId.value = projectId;
        const built = await treeStore.loadTreeFromDB(projectId);
        treeStore.tree.value = built;
        console.log(`[Fallback Import] nodes=${built.length} roots=${built.length}`);
        showUploadModal.value = false;
        event.target.value = "";
    }

    function updateCapabilityFlags() {
        const isClient = typeof window !== "undefined";
        supportsFS.value = isClient && typeof window.showDirectoryPicker === "function" && window.isSecureContext;
        supportsOPFS.value = isClient && Boolean(navigator.storage && navigator.storage.getDirectory && window.isSecureContext);
    }

    return {
        showUploadModal,
        projects,
        selectedProjectId,
        supportsFS,
        supportsOPFS,
        setTreeStore,
        getProjectRootHandleById,
        saveProjectRecord,
        loadProjectsFromDB,
        cleanupLegacyHandles,
        openProject,
        collapseProject,
        importDirCommon,
        deleteProject,
        handleDrop,
        handleDragOver,
        handleFolderInput,
        pickFolderAndImport,
        updateCapabilityFlags,
        safeAlertFail,
        explainFSerror
    };
}

