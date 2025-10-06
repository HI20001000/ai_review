<script setup>
import { ref, reactive, watch, onMounted, onBeforeUnmount, computed, nextTick } from "vue";
import { usePreview } from "../scripts/composables/usePreview.js";
import { useTreeStore } from "../scripts/composables/useTreeStore.js";
import { useProjectsStore } from "../scripts/composables/useProjectsStore.js";
import { useAiAssistant } from "../scripts/composables/useAiAssistant.js";
import * as fileSystemService from "../scripts/services/fileSystemService.js";
import PanelRail from "../components/workspace/PanelRail.vue";
import ChatAiWindow from "../components/ChatAiWindow.vue";
import ReportTreeNode from "../components/reports/ReportTreeNode.vue";

const preview = usePreview();

const projectsStore = useProjectsStore({
    preview,
    fileSystem: fileSystemService
});

const treeStore = useTreeStore({
    getProjectRootHandleById: projectsStore.getProjectRootHandleById,
    getFileHandleByPath: fileSystemService.getFileHandleByPath,
    previewing: preview.previewing,
    isTextLike: preview.isTextLike,
    MAX_TEXT_BYTES: preview.MAX_TEXT_BYTES,
    selectedProjectId: projectsStore.selectedProjectId
});

projectsStore.setTreeStore(treeStore);

const aiAssistant = useAiAssistant({ treeStore, projectsStore, fileSystem: fileSystemService, preview });

const {
    showUploadModal,
    projects,
    selectedProjectId,
    supportsFS,
    loadProjectsFromDB,
    cleanupLegacyHandles,
    openProject,
    collapseProject,
    deleteProject,
    handleDrop,
    handleDragOver,
    handleFolderInput,
    pickFolderAndImport,
    updateCapabilityFlags
} = projectsStore;

const {
    tree,
    activeTreePath,
    isLoadingTree,
    openNode,
    selectTreeNode
} = treeStore;

const {
    open: openAssistantSession,
    close: closeAssistantSession,
    contextItems,
    messages,
    addActiveNode,
    removeContext,
    clearContext,
    sendUserMessage,
    isProcessing,
    isInteractionLocked: isChatLocked,
    connection,
    retryHandshake
} = aiAssistant;

const { previewing } = preview;

const middlePaneWidth = ref(360);
const mainContentRef = ref(null);
const isChatWindowOpen = ref(false);
const activeRailTool = ref("projects");
const chatWindowState = reactive({ x: 0, y: 80, width: 420, height: 520 });
const chatDragState = reactive({ active: false, offsetX: 0, offsetY: 0 });
const chatResizeState = reactive({
    active: false,
    startX: 0,
    startY: 0,
    startWidth: 0,
    startHeight: 0,
    startLeft: 0,
    startTop: 0,
    edges: {
        left: false,
        right: false,
        top: false,
        bottom: false
    }
});
const hasInitializedChatWindow = ref(false);
const isTreeCollapsed = ref(false);
const reportStates = reactive({});
const reportTreeCache = reactive({});
const activeReportTarget = ref(null);
const isProjectToolActive = computed(() => activeRailTool.value === "projects");
const isReportToolActive = computed(() => activeRailTool.value === "reports");
const reportProjectEntries = computed(() => {
    const list = Array.isArray(projects.value) ? projects.value : [];
    return list.map((project) => {
        const projectKey = normaliseProjectId(project.id);
        return {
            project,
            cache: reportTreeCache[projectKey] || {
                nodes: [],
                loading: false,
                error: "",
                expandedPaths: []
            }
        };
    });
});
const readyReports = computed(() => {
    const list = [];
    const projectList = Array.isArray(projects.value) ? projects.value : [];
    const projectMap = new Map(projectList.map((project) => [String(project.id), project]));

    Object.entries(reportStates).forEach(([key, state]) => {
        if (state.status !== "ready") return;
        const parsed = parseReportKey(key);
        const project = projectMap.get(parsed.projectId);
        if (!project || !parsed.path) return;
        list.push({
            key,
            project,
            path: parsed.path,
            state
        });
    });

    list.sort((a, b) => {
        if (a.project.name === b.project.name) return a.path.localeCompare(b.path);
        return a.project.name.localeCompare(b.project.name);
    });

    return list;
});
const hasReadyReports = computed(() => readyReports.value.length > 0);
const activeReport = computed(() => {
    const target = activeReportTarget.value;
    if (!target) return null;
    const key = toReportKey(target.projectId, target.path);
    if (!key) return null;
    const state = reportStates[key];
    if (!state || state.status !== "ready") return null;
    const projectList = Array.isArray(projects.value) ? projects.value : [];
    const project = projectList.find((item) => String(item.id) === target.projectId);
    if (!project) return null;
    return {
        project,
        state,
        path: target.path
    };
});
const middlePaneStyle = computed(() => {
    const width = isProjectToolActive.value ? middlePaneWidth.value : 0;
    return {
        flex: `0 0 ${width}px`,
        width: `${width}px`
    };
});

const chatWindowStyle = computed(() => ({
    width: `${chatWindowState.width}px`,
    height: `${chatWindowState.height}px`,
    left: `${chatWindowState.x}px`,
    top: `${chatWindowState.y}px`
}));

const isChatToggleDisabled = computed(() => isChatLocked.value && !isChatWindowOpen.value);

watch(isChatWindowOpen, (visible) => {
    if (visible) {
        openAssistantSession();
        const shouldForce = connection.value.status === "error";
        retryHandshake({ force: shouldForce });
        if (!hasInitializedChatWindow.value) {
            chatWindowState.width = 420;
            chatWindowState.height = 520;
            chatWindowState.x = Math.max(20, window.innerWidth - chatWindowState.width - 40);
            chatWindowState.y = 80;
            hasInitializedChatWindow.value = true;
        } else {
            ensureChatWindowInView();
        }
        nextTick(() => {
            ensureChatWindowInView();
        });
    } else {
        closeAssistantSession();
    }
});

async function ensureActiveProject() {
    const list = Array.isArray(projects.value) ? projects.value : [];
    if (!list.length) return;

    const selectedIdValue = selectedProjectId.value;
    if (!selectedIdValue) {
        return;
    }

    const current = list.find((project) => project.id === selectedIdValue);
    if (!current) {
        selectedProjectId.value = null;
        return;
    }

    if (!tree.value.length && !isLoadingTree.value) {
        isTreeCollapsed.value = false;
        await openProject(current);
    }
}

watch(
    [projects, selectedProjectId],
    async () => {
        await ensureActiveProject();
    },
    { immediate: true }
);

watch(selectedProjectId, (projectId) => {
    if (projectId === null || projectId === undefined) {
        isTreeCollapsed.value = false;
    }
});

function handleSelectProject(project) {
    if (!project) return;
    const currentId = selectedProjectId.value;
    const treeHasNodes = Array.isArray(tree.value) && tree.value.length > 0;
    if (currentId === project.id) {
        if (isTreeCollapsed.value) {
            isTreeCollapsed.value = false;
            if (!treeHasNodes && !isLoadingTree.value) {
                openProject(project);
            }
        } else {
            if (!isLoadingTree.value && !treeHasNodes) {
                openProject(project);
            } else {
                isTreeCollapsed.value = true;
            }
        }
        return;
    }
    isTreeCollapsed.value = false;
    openProject(project);
}

function toggleProjectTool() {
    activeRailTool.value = isProjectToolActive.value ? null : "projects";
}

function toggleReportTool() {
    activeRailTool.value = isReportToolActive.value ? null : "reports";
}

function normaliseProjectId(projectId) {
    if (projectId === null || projectId === undefined) return "";
    return String(projectId);
}

function toReportKey(projectId, path) {
    const projectKey = normaliseProjectId(projectId);
    if (!projectKey || !path) return "";
    return `${projectKey}::${path}`;
}

function parseReportKey(key) {
    if (!key) return { projectId: "", path: "" };
    const index = key.indexOf("::");
    if (index === -1) {
        return { projectId: key, path: "" };
    }
    return {
        projectId: key.slice(0, index),
        path: key.slice(index + 2)
    };
}

function createDefaultReportState() {
    return {
        status: "idle",
        report: "",
        updatedAt: null,
        updatedAtDisplay: null
    };
}

function ensureReportTreeEntry(projectId) {
    const key = normaliseProjectId(projectId);
    if (!key) return null;
    if (!Object.prototype.hasOwnProperty.call(reportTreeCache, key)) {
        reportTreeCache[key] = {
            nodes: [],
            loading: false,
            error: "",
            expandedPaths: []
        };
    }
    return reportTreeCache[key];
}

function ensureFileReportState(projectId, path) {
    const key = toReportKey(projectId, path);
    if (!key) return null;
    if (!Object.prototype.hasOwnProperty.call(reportStates, key)) {
        reportStates[key] = createDefaultReportState();
    }
    return reportStates[key];
}

function getReportStateForFile(projectId, path) {
    return ensureFileReportState(projectId, path) || createDefaultReportState();
}

function getStatusLabel(status) {
    switch (status) {
        case "processing":
            return "處理中";
        case "ready":
            return "已完成";
        default:
            return "待生成";
    }
}

function isReportNodeExpanded(projectId, path) {
    const entry = ensureReportTreeEntry(projectId);
    if (!entry) return false;
    if (!path) return true;
    return entry.expandedPaths.includes(path);
}

function toggleReportNode(projectId, path) {
    const entry = ensureReportTreeEntry(projectId);
    if (!entry || !path) return;
    const set = new Set(entry.expandedPaths);
    if (set.has(path)) {
        set.delete(path);
    } else {
        set.add(path);
    }
    entry.expandedPaths = Array.from(set);
}

function collectFileNodes(nodes, bucket = []) {
    for (const node of nodes || []) {
        if (node.type === "file") {
            bucket.push(node);
        } else if (node.children && node.children.length) {
            collectFileNodes(node.children, bucket);
        }
    }
    return bucket;
}

function ensureStatesForProject(projectId, nodes) {
    const fileNodes = collectFileNodes(nodes);
    const validPaths = new Set();
    for (const node of fileNodes) {
        if (!node?.path) continue;
        ensureFileReportState(projectId, node.path);
        validPaths.add(node.path);
    }

    Object.keys(reportStates).forEach((key) => {
        const parsed = parseReportKey(key);
        if (parsed.projectId !== normaliseProjectId(projectId)) return;
        if (parsed.path && !validPaths.has(parsed.path)) {
            if (activeReportTarget.value &&
                activeReportTarget.value.projectId === parsed.projectId &&
                activeReportTarget.value.path === parsed.path) {
                activeReportTarget.value = null;
            }
            delete reportStates[key];
        }
    });
}

async function loadReportTreeForProject(projectId) {
    const entry = ensureReportTreeEntry(projectId);
    if (!entry || entry.loading) return;
    entry.loading = true;
    entry.error = "";
    try {
        const nodes = await treeStore.loadTreeFromDB(projectId);
        entry.nodes = nodes;
        ensureStatesForProject(projectId, nodes);
        const nextExpanded = new Set(entry.expandedPaths);
        for (const node of nodes) {
            if (node.type === "dir") {
                nextExpanded.add(node.path);
            }
        }
        entry.expandedPaths = Array.from(nextExpanded);
    } catch (error) {
        console.error("[Report] Failed to load tree for project", projectId, error);
        entry.error = error?.message ? String(error.message) : String(error);
    } finally {
        entry.loading = false;
    }
}

function selectReport(projectId, path) {
    const key = toReportKey(projectId, path);
    if (!key) return;
    const state = reportStates[key];
    if (!state || state.status !== "ready") return;
    activeReportTarget.value = {
        projectId: normaliseProjectId(projectId),
        path
    };
}

async function generateReportForFile(project, node) {
    if (!project || !node || node.type !== "file") return;
    const projectId = normaliseProjectId(project.id);
    const state = ensureFileReportState(projectId, node.path);
    if (!state || state.status === "processing") return;

    state.status = "processing";

    await new Promise((resolve) => setTimeout(resolve, 1800));

    const completedAt = new Date();
    state.status = "ready";
    state.updatedAt = completedAt;
    state.updatedAtDisplay = completedAt.toLocaleString();
    state.report = buildReportContent(project, node, completedAt);

    activeReportTarget.value = {
        projectId,
        path: node.path
    };
}

function buildReportContent(project, node, completedAt) {
    const timestamp = completedAt?.toLocaleString() ?? new Date().toLocaleString();
    const infoLines = [
        `# ${node?.name ?? "文件"} 審查報告`,
        "",
        `- 所屬專案：${project?.name ?? "專案"}`,
        `- 文件路徑：${node?.path ?? ""}`,
        `- 生成時間：${timestamp}`
    ];
    infoLines.push(
        "",
        "## 審查摘要",
        "1. 整合 Dify 單文件輸出，摘錄主要風險與異常。",
        "2. 評估程式碼風格、可維護性與測試覆蓋情況。",
        "3. 標記需要人工複核的段落或外部依賴。",
        "",
        "## 後續建議",
        "- 若檔案相依其他模組，建議同步追加審查。",
        "- 重新生成報告時保留本次輸出以利差異比對。",
        "- 若需更進階分析，可於 Dify 任務中追加上下文。"
    );
    return infoLines.join("\n");
}

watch(
    projects,
    (list) => {
        const projectList = Array.isArray(list) ? list : [];
        const currentIds = new Set(projectList.map((project) => normaliseProjectId(project.id)));

        projectList.forEach((project) => {
            const entry = ensureReportTreeEntry(project.id);
            if (isReportToolActive.value && entry && !entry.nodes.length && !entry.loading) {
                loadReportTreeForProject(project.id);
            }
        });

        Object.keys(reportTreeCache).forEach((projectId) => {
            if (!currentIds.has(projectId)) {
                delete reportTreeCache[projectId];
            }
        });

        Object.keys(reportStates).forEach((key) => {
            const parsed = parseReportKey(key);
            if (!currentIds.has(parsed.projectId)) {
                if (activeReportTarget.value &&
                    activeReportTarget.value.projectId === parsed.projectId &&
                    activeReportTarget.value.path === parsed.path) {
                    activeReportTarget.value = null;
                }
                delete reportStates[key];
            }
        });
    },
    { immediate: true, deep: true }
);

watch(
    isReportToolActive,
    (active) => {
        if (!active) return;
        const list = Array.isArray(projects.value) ? projects.value : [];
        list.forEach((project) => {
            const entry = ensureReportTreeEntry(project.id);
            if (entry && !entry.nodes.length && !entry.loading) {
                loadReportTreeForProject(project.id);
            }
        });
    }
);

watch(
    readyReports,
    (list) => {
        if (!list.length) {
            activeReportTarget.value = null;
            return;
        }
        const target = activeReportTarget.value;
        const hasActive = target
            ? list.some((entry) => normaliseProjectId(entry.project.id) === target.projectId && entry.path === target.path)
            : false;
        if (!hasActive) {
            const next = list[0];
            activeReportTarget.value = {
                projectId: normaliseProjectId(next.project.id),
                path: next.path
            };
        }
    },
    { immediate: true }
);

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function shouldIgnoreMouseEvent(event) {
    return (
        event?.type === "mousedown" &&
        typeof window !== "undefined" &&
        "PointerEvent" in window
    );
}

function startPreviewResize(event) {
    if (event.button !== 0) return;
    event.preventDefault();

    const startX = event.clientX;
    const startWidth = middlePaneWidth.value;
    const containerEl = mainContentRef.value;
    const workspaceEl = containerEl?.querySelector(".workSpace");
    if (!workspaceEl) return;

    const minWidth = 260;
    const workspaceMinWidth = 320;
    const workspaceRect = workspaceEl.getBoundingClientRect();
    const maxAdditional = Math.max(0, workspaceRect.width - workspaceMinWidth);
    const maxWidth = Math.max(minWidth, startWidth + maxAdditional);

    const handleMove = (pointerEvent) => {
        const delta = pointerEvent.clientX - startX;
        middlePaneWidth.value = clamp(startWidth + delta, minWidth, maxWidth);
    };

    const stop = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
}

async function handleAddActiveContext() {
    const added = await addActiveNode();
    if (added) {
        openChatWindow();
    }
}

async function handleSendMessage(content) {
    const text = (content || "").trim();
    if (!text) return;
    openChatWindow();
    console.log("[ChatAI] Sending message:", text);
    await sendUserMessage(text);
}

function openChatWindow() {
    if (!isChatWindowOpen.value) {
        isChatWindowOpen.value = true;
    }
}

function closeChatWindow() {
    if (isChatWindowOpen.value) {
        isChatWindowOpen.value = false;
        stopChatDrag();
        stopChatResize();
    }
}

function toggleChatWindow() {
    if (isChatWindowOpen.value) {
        closeChatWindow();
    } else {
        if (!isChatToggleDisabled.value) {
            openChatWindow();
        }
    }
}

function ensureChatWindowInView() {
    const maxX = Math.max(0, window.innerWidth - chatWindowState.width);
    const maxY = Math.max(0, window.innerHeight - chatWindowState.height);
    chatWindowState.x = clamp(chatWindowState.x, 0, maxX);
    chatWindowState.y = clamp(chatWindowState.y, 0, maxY);
}

function startChatDrag(event) {
    if (shouldIgnoreMouseEvent(event)) return;
    if (event.button !== 0) return;
    event.preventDefault();
    chatDragState.active = true;
    chatDragState.offsetX = event.clientX - chatWindowState.x;
    chatDragState.offsetY = event.clientY - chatWindowState.y;
    window.addEventListener("pointermove", handleChatDrag);
    window.addEventListener("pointerup", stopChatDrag);
    window.addEventListener("pointercancel", stopChatDrag);
}

function handleChatDrag(event) {
    if (!chatDragState.active) return;
    event.preventDefault();
    const maxX = Math.max(0, window.innerWidth - chatWindowState.width);
    const maxY = Math.max(0, window.innerHeight - chatWindowState.height);
    chatWindowState.x = clamp(event.clientX - chatDragState.offsetX, 0, maxX);
    chatWindowState.y = clamp(event.clientY - chatDragState.offsetY, 0, maxY);
}

function stopChatDrag() {
    chatDragState.active = false;
    window.removeEventListener("pointermove", handleChatDrag);
    window.removeEventListener("pointerup", stopChatDrag);
    window.removeEventListener("pointercancel", stopChatDrag);
}

function startChatResize(payload) {
    const event = payload?.originalEvent ?? payload;
    const edges = payload?.edges ?? { right: true, bottom: true };
    if (!event || shouldIgnoreMouseEvent(event)) return;
    if (event.button !== 0) return;
    if (!edges.left && !edges.right && !edges.top && !edges.bottom) return;

    event.preventDefault();
    chatResizeState.active = true;
    chatResizeState.startX = event.clientX;
    chatResizeState.startY = event.clientY;
    chatResizeState.startWidth = chatWindowState.width;
    chatResizeState.startHeight = chatWindowState.height;
    chatResizeState.startLeft = chatWindowState.x;
    chatResizeState.startTop = chatWindowState.y;
    chatResizeState.edges.left = !!edges.left;
    chatResizeState.edges.right = !!edges.right;
    chatResizeState.edges.top = !!edges.top;
    chatResizeState.edges.bottom = !!edges.bottom;

    window.addEventListener("pointermove", handleChatResize);
    window.addEventListener("pointerup", stopChatResize);
    window.addEventListener("pointercancel", stopChatResize);
}

function handleChatResize(event) {
    if (!chatResizeState.active) return;
    event.preventDefault();
    const deltaX = event.clientX - chatResizeState.startX;
    const deltaY = event.clientY - chatResizeState.startY;
    const minWidth = 320;
    const minHeight = 320;

    if (chatResizeState.edges.left) {
        const proposedLeft = chatResizeState.startLeft + deltaX;
        const maxLeft = chatResizeState.startLeft + chatResizeState.startWidth - minWidth;
        const clampedLeft = clamp(proposedLeft, 0, Math.max(0, maxLeft));
        const widthFromLeft = chatResizeState.startWidth + (chatResizeState.startLeft - clampedLeft);
        const maxWidthFromViewport = Math.max(minWidth, window.innerWidth - clampedLeft);
        chatWindowState.x = clampedLeft;
        chatWindowState.width = clamp(widthFromLeft, minWidth, maxWidthFromViewport);
    }

    if (chatResizeState.edges.top) {
        const proposedTop = chatResizeState.startTop + deltaY;
        const maxTop = chatResizeState.startTop + chatResizeState.startHeight - minHeight;
        const clampedTop = clamp(proposedTop, 0, Math.max(0, maxTop));
        const heightFromTop = chatResizeState.startHeight + (chatResizeState.startTop - clampedTop);
        const maxHeightFromViewport = Math.max(minHeight, window.innerHeight - clampedTop);
        chatWindowState.y = clampedTop;
        chatWindowState.height = clamp(heightFromTop, minHeight, maxHeightFromViewport);
    }

    if (chatResizeState.edges.right) {
        const maxWidth = Math.max(minWidth, window.innerWidth - chatWindowState.x);
        chatWindowState.width = clamp(chatResizeState.startWidth + deltaX, minWidth, maxWidth);
    }

    if (chatResizeState.edges.bottom) {
        const maxHeight = Math.max(minHeight, window.innerHeight - chatWindowState.y);
        chatWindowState.height = clamp(chatResizeState.startHeight + deltaY, minHeight, maxHeight);
    }
}

function stopChatResize() {
    chatResizeState.active = false;
    chatResizeState.edges.left = false;
    chatResizeState.edges.right = false;
    chatResizeState.edges.top = false;
    chatResizeState.edges.bottom = false;
    window.removeEventListener("pointermove", handleChatResize);
    window.removeEventListener("pointerup", stopChatResize);
    window.removeEventListener("pointercancel", stopChatResize);
}

onMounted(async () => {
    await cleanupLegacyHandles();
    updateCapabilityFlags();
    await loadProjectsFromDB();
    window.addEventListener("resize", ensureChatWindowInView);
});

onBeforeUnmount(() => {
    window.removeEventListener("resize", ensureChatWindowInView);
    stopChatDrag();
    stopChatResize();
});
</script>



<template>
    <div class="page">
        <div class="topBar">
            <div class="topBar_left">
                <h1 class="topBar_title">Workspace</h1>
            </div>
            <div class="topBar_spacer"></div>
            <div class="topBar_right">
                <div class="topBar_addProject" @click="showUploadModal = true">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
                        <path d="M256,0C114.6,0,0,114.6,0,256s114.6,256,256,256s256-114.6,256-256S397.4,0,256,0z M405.3,277.3c0,11.8-9.5,21.3-21.3,21.3h-85.3V384c0,11.8-9.5,21.3-21.3,21.3h-42.7c-11.8,0-21.3-9.6-21.3-21.3v-85.3H128c-11.8,0-21.3-9.6-21.3-21.3v-42.7c0-11.8,9.5-21.3,21.3-21.3h85.3V128c0-11.8,9.5-21.3,21.3-21.3h42.7c11.8,0,21.3,9.6,21.3,21.3v85.3H384c11.8,0,21.3,9.6,21.3,21.3V277.3z" />
                    </svg>
                    <p>Add Project</p>
                </div>
            </div>
        </div>

        <div class="mainContent" ref="mainContentRef">
            <nav class="toolColumn">
                <button
                    type="button"
                    class="toolColumn_btn"
                    :class="{ active: isProjectToolActive }"
                    @click="toggleProjectTool"
                    :aria-pressed="isProjectToolActive"
                    title="Projects"
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <rect x="3" y="5" width="18" height="14" rx="2" ry="2" fill="currentColor" opacity="0.18" />
                        <path
                            d="M5 7h5l1.5 2H19v8H5V7Z"
                            fill="currentColor"
                        />
                    </svg>
                </button>
                <button
                    type="button"
                    class="toolColumn_btn"
                    :class="{ active: isReportToolActive }"
                    @click="toggleReportTool"
                    :aria-pressed="isReportToolActive"
                    title="報告審查"
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <rect x="3" y="3" width="18" height="18" rx="9" fill="currentColor" opacity="0.18" />
                        <path
                            d="M14.8 13.4a4.5 4.5 0 1 0-1.4 1.4l3.5 3.5 1.4-1.4-3.5-3.5Zm-3.8.6a3 3 0 1 1 0-6 3 3 0 0 1 0 6Z"
                            fill="currentColor"
                        />
                    </svg>
                </button>
                <button
                    type="button"
                    class="toolColumn_btn toolColumn_btn--chat"
                    :class="{ active: isChatWindowOpen }"
                    :disabled="isChatToggleDisabled"
                    @click="toggleChatWindow"
                    :aria-pressed="isChatWindowOpen"
                    title="Chat AI"
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <rect x="3" y="3" width="18" height="18" rx="4" fill="currentColor" opacity="0.12" />
                        <path
                            d="M8.5 8h7c.83 0 1.5.67 1.5 1.5v3c0 .83-.67 1.5-1.5 1.5h-.94l-1.8 1.88c-.31.33-.76.12-.76-.32V14.5h-3.5c-.83 0-1.5-.67-1.5-1.5v-3C7 8.67 7.67 8 8.5 8Z"
                            fill="currentColor"
                        />
                    </svg>
                </button>
            </nav>
            <PanelRail
                :style-width="middlePaneStyle"
                :projects="projects"
                :selected-project-id="selectedProjectId"
                :on-select-project="handleSelectProject"
                :on-delete-project="deleteProject"
                :is-tree-collapsed="isTreeCollapsed"
                :show-content="isProjectToolActive"
                :tree="tree"
                :active-tree-path="activeTreePath"
                :is-loading-tree="isLoadingTree"
                :open-node="openNode"
                :select-tree-node="selectTreeNode"
                @resize-start="startPreviewResize"
            />

            <section class="workSpace" :class="{ 'workSpace--reports': isReportToolActive }">
                <template v-if="isReportToolActive">
                    <div class="reportReview">
                        <aside class="reportProjects">
                            <div class="panelHeader">代碼審查</div>
                            <template v-if="reportProjectEntries.length">
                                <ul class="reportProjectList">
                                    <li
                                        v-for="entry in reportProjectEntries"
                                        :key="entry.project.id"
                                        class="reportProjectItem"
                                    >
                                        <div class="projectHeader">
                                            <span class="projName" :title="entry.project.name">{{ entry.project.name }}</span>
                                            <button
                                                v-if="entry.cache.error"
                                                type="button"
                                                class="reportRetryBtn"
                                                @click.stop="loadReportTreeForProject(entry.project.id)"
                                            >
                                                重新載入
                                            </button>
                                            <span v-else-if="entry.cache.loading" class="reportMeta">載入中…</span>
                                        </div>
                                        <p v-if="entry.cache.error" class="reportError">無法載入：{{ entry.cache.error }}</p>
                                        <div v-else-if="entry.cache.loading" class="reportLoading">正在載入檔案清單…</div>
                                        <p v-else-if="!entry.cache.nodes.length" class="reportEmpty">此專案尚未索引任何檔案。</p>
                                        <div v-else class="reportTreeWrapper">
                                            <ul class="reportFileTree">
                                                <ReportTreeNode
                                                    v-for="node in entry.cache.nodes"
                                                    :key="node.path"
                                                    :node="node"
                                                    :project="entry.project"
                                                    :project-id="normaliseProjectId(entry.project.id)"
                                                    :is-expanded="isReportNodeExpanded"
                                                    :toggle="toggleReportNode"
                                                    :get-state="getReportStateForFile"
                                                    :on-generate="generateReportForFile"
                                                    :on-select="selectReport"
                                                    :get-status-label="getStatusLabel"
                                                />
                                            </ul>
                                        </div>
                                    </li>
                                </ul>
                            </template>
                            <p v-else class="emptyProjects">尚未匯入任何專案。</p>
                        </aside>
                        <section class="reportViewer">
                            <div class="panelHeader">報告檢視</div>
                            <template v-if="hasReadyReports">
                                <div class="reportTabs">
                                    <button
                                        v-for="entry in readyReports"
                                        :key="entry.key"
                                        type="button"
                                        class="reportTab"
                                        :class="{
                                            active:
                                                activeReport &&
                                                normaliseProjectId(entry.project.id) === normaliseProjectId(activeReport.project.id) &&
                                                entry.path === activeReport.path
                                        }"
                                        @click="selectReport(entry.project.id, entry.path)"
                                    >
                                        {{ entry.project.name }} / {{ entry.path }}
                                    </button>
                                </div>
                                <div v-if="activeReport" class="reportViewerContent">
                                    <h2 class="reportTitle">{{ activeReport.project.name }} / {{ activeReport.path }}</h2>
                                    <p
                                        v-if="activeReport.state.updatedAtDisplay"
                                        class="reportViewerTimestamp"
                                    >
                                        生成時間：{{ activeReport.state.updatedAtDisplay }}
                                    </p>
                                    <pre class="reportBody">{{ activeReport.state.report }}</pre>
                                </div>
                                <div v-else class="reportViewerPlaceholder">請從左側選擇檔案報告。</div>
                            </template>
                            <p v-else class="reportViewerPlaceholder">尚未生成任何報告，請先於左側檔案中啟動生成。</p>
                        </section>
                    </div>
                </template>
                <template v-else-if="previewing.kind && previewing.kind !== 'error'">
                    <div class="pvHeader">
                        <div class="pvName">{{ previewing.name }}</div>
                        <div class="pvMeta">{{ previewing.mime || '-' }} | {{ (previewing.size / 1024).toFixed(1) }} KB</div>
                    </div>

                    <div v-if="previewing.kind === 'text'" class="pvBox">
                        <pre class="pvPre">{{ previewing.text }}</pre>
                    </div>

                    <div v-else-if="previewing.kind === 'image'" class="pvBox imgBox">
                        <img :src="previewing.url" :alt="previewing.name" />
                    </div>

                    <div v-else-if="previewing.kind === 'pdf'" class="pvBox pdfBox">
                        <iframe :src="previewing.url" title="PDF Preview" style="width:100%;height:100%;border:none;"></iframe>
                    </div>

                    <div v-else class="pvBox">
                        <a class="btn" :href="previewing.url" download>Download file</a>
                        <a class="btn outline" :href="previewing.url" target="_blank">Open in new window</a>
                    </div>
                </template>

                <template v-else-if="previewing.kind === 'error'">
                    <div class="pvError">
                        Cannot preview: {{ previewing.error }}
                    </div>
                </template>

                <template v-else>
                    <div class="pvPlaceholder">Select a file to see its preview here.</div>
                </template>
            </section>
        </div>

        <Teleport to="body">
            <ChatAiWindow
                :visible="isChatWindowOpen"
                :floating-style="chatWindowStyle"
                :context-items="contextItems"
                :messages="messages"
                :loading="isProcessing"
                :disabled="isChatLocked"
                :connection="connection"
                @add-active="handleAddActiveContext"
                @clear-context="clearContext"
                @remove-context="removeContext"
                @send-message="handleSendMessage"
                @close="closeChatWindow"
                @drag-start="startChatDrag"
                @resize-start="startChatResize"
            />
        </Teleport>

        <div v-if="showUploadModal" class="modalBackdrop" @click.self="showUploadModal = false">
            <div class="modalCard">
                <h3>Import Project Folder</h3>
                <p>Drag a folder here or use the buttons below to import a project. External directories and OPFS are supported.</p>

                <div class="dropZone" @drop="handleDrop" @dragover="handleDragOver">Drop a folder here to import</div>

                <div class="modalBtns">
                    <button class="btn" v-if="supportsFS" @click="pickFolderAndImport">Select folder</button>
                    <label class="btn outline" v-else>Fallback import<input type="file" webkitdirectory directory multiple style="display:none" @change="handleFolderInput"></label>
                    <button class="btn ghost" @click="showUploadModal = false">Cancel</button>
                </div>
                <p class="hint" v-if="!supportsFS">Your browser does not support showDirectoryPicker. Use the fallback input instead.</p>
            </div>
        </div>
    </div>
</template>
<style>
/* 讓 100% 有依據 */
html,
body,
#app {
    height: 100%;
    margin: 0;
    font-family: "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #e5e7eb;
}

.page {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    background-color: #1e1e1e;
}

/* 頂欄 */
.topBar {
    box-sizing: border-box;
    height: 60px;
    padding: 0 16px;
    background: linear-gradient(90deg, #2c2c2c, #252526);
    border-bottom: 1px solid #3d3d3d;
    display: flex;
    align-items: center;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.5);
}

.topBar_spacer {
    flex: 1 1 auto;
}

.topBar_right {
    display: flex;
    align-items: center;
    gap: 12px;
}

.topBar_iconBtn {
    width: 44px;
    height: 44px;
    border-radius: 12px;
    border: 1px solid #3d3d3d;
    background: #2b2b2b;
    color: #cbd5f5;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background 0.2s ease, transform 0.2s ease, border-color 0.2s ease, color 0.2s ease;
}

.topBar_iconBtn svg {
    width: 20px;
    height: 20px;
}

.topBar_iconBtn:hover:not(:disabled) {
    background: #343434;
    border-color: #4b5563;
    color: #e0f2fe;
    transform: translateY(-1px);
}

.topBar_iconBtn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
}

.topBar_iconBtn.active {
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.3), rgba(14, 165, 233, 0.3));
    border-color: rgba(14, 165, 233, 0.6);
    color: #e0f2fe;
}

.topBar_addProject {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 14px;
    border-radius: 6px;
    background-color: #007acc;
    transition: all 0.25s ease;
}

.topBar_addProject p {
    margin: 0;
    color: white;
    font-weight: 600;
    font-size: 15px;
}

.topBar_addProject svg {
    height: 20px;
    fill: white;
    transition: transform 0.25s ease, fill 0.25s ease;
}

.topBar_addProject:hover {
    background-color: #0288d1;
    transform: translateY(-2px) scale(1.03);
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}

.topBar_addProject:active {
    transform: scale(0.96);
}


.mainContent {
    display: flex;
    flex-direction: row;
    align-items: stretch;
    flex: 1 1 auto;
    min-height: 0;
    background-color: #1e1e1e;
    padding: 0;
    height: calc(100vh - 60px);
    max-height: calc(100vh - 60px);
    overflow-x: hidden;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: #3d3d3d #1b1b1b;
}

.mainContent::-webkit-scrollbar {
    width: 10px;
}

.mainContent::-webkit-scrollbar-track {
    background: #1b1b1b;
}

.mainContent::-webkit-scrollbar-thumb {
    background: linear-gradient(180deg, #3b82f6, #0ea5e9);
    border-radius: 999px;
    border: 2px solid #1b1b1b;
}

.mainContent::-webkit-scrollbar-thumb:hover {
    background: linear-gradient(180deg, #60a5fa, #22d3ee);
}

.toolColumn {
    flex: 0 0 64px;
    width: 64px;
    background: #252526;
    border-right: 1px solid #323232;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 16px 10px;
    box-sizing: border-box;
}

.toolColumn_btn {
    width: 44px;
    height: 44px;
    border: 1px solid #3d3d3d;
    background: #262626;
    color: #cbd5f5;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background 0.2s ease, color 0.2s ease, border-color 0.2s ease, transform 0.2s ease;
    padding: 0;
}

.toolColumn_btn svg {
    width: 33px;
    height: 33px;
}

.toolColumn_btn--chat {
    margin-top: auto;
}

.toolColumn_btn:hover {
    background: #2f2f2f;
    border-color: #4b5563;
    color: #e0f2fe;
    transform: translateY(-1px);
}

.toolColumn_btn.active {
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.25), rgba(14, 165, 233, 0.25));
    border-color: rgba(14, 165, 233, 0.6);
    color: #e0f2fe;
}

.toolColumn_btn:focus-visible {
    outline: 2px solid #60a5fa;
    outline-offset: 2px;
}

.mainContent > * {
    min-height: 0;
}

@media (max-width: 900px) {
    .mainContent {
        flex-direction: column;
    }
    .toolColumn {
        flex-direction: row;
        width: 100%;
        flex: 0 0 auto;
        border-right: none;
        border-bottom: 1px solid #323232;
        justify-content: flex-start;
    }
    .toolColumn_btn {
        transform: none;
    }
    .toolColumn_btn--chat {
        margin-top: 0;
        margin-left: auto;
    }
    .workSpace {
        width: 100%;
        flex: 1 1 auto;
    }
}
.loading {
    padding: 10px;
    opacity: .8;
}

.treeRoot {
    list-style: none;
    margin: 0;
    padding: 0 8px 8px 0;
}

.workSpace {
    flex: 1 1 320px;
    min-width: 0;
    min-height: 0;
    background: #252526;
    border-radius: 0;
    border: 1px solid #323232;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    overflow: auto;
}

.workSpace--reports {
    overflow: hidden;
    padding: 12px;
}

.reportReview {
    flex: 1 1 auto;
    display: flex;
    gap: 12px;
    min-height: 0;
}

.reportProjects {
    flex: 0 0 320px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    background: #191919;
    border: 1px solid #323232;
    border-radius: 6px;
    padding: 16px;
    overflow-y: auto;
}

.panelHeader {
    font-weight: 700;
    color: #cbd5e1;
    font-size: 14px;
}

.reportProjectList {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.reportProjectItem {
    border: 1px solid #2f2f2f;
    border-radius: 6px;
    background: #101010;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.projectHeader {
    display: flex;
    align-items: center;
    gap: 12px;
}

.reportMeta {
    margin-left: auto;
    font-size: 12px;
    color: #94a3b8;
}

.reportRetryBtn {
    margin-left: auto;
    padding: 4px 10px;
    border-radius: 4px;
    border: 1px solid rgba(239, 68, 68, 0.5);
    background: rgba(239, 68, 68, 0.1);
    color: #fca5a5;
    font-size: 12px;
    cursor: pointer;
    transition: background 0.2s ease, border-color 0.2s ease;
}

.reportRetryBtn:hover {
    background: rgba(239, 68, 68, 0.2);
    border-color: rgba(248, 113, 113, 0.7);
}

.projName {
    flex: 1 1 auto;
    min-width: 0;
    font-weight: 600;
    color: #f3f4f6;
    white-space: nowrap;
    text-overflow: ellipsis;
    overflow: hidden;
}

.reportActionBtn {
    flex: 0 0 auto;
    padding: 6px 12px;
    border-radius: 4px;
    border: 1px solid #2563eb;
    background: linear-gradient(135deg, rgba(37, 99, 235, 0.18), rgba(14, 165, 233, 0.18));
    color: #bfdbfe;
    font-size: 12px;
    cursor: pointer;
    transition: transform 0.2s ease, background 0.2s ease;
}

.reportActionBtn:hover {
    transform: translateY(-1px);
    background: linear-gradient(135deg, rgba(37, 99, 235, 0.28), rgba(14, 165, 233, 0.28));
}

.reportActionBtn:disabled {
    cursor: not-allowed;
    opacity: 0.6;
    transform: none;
}

.reportLoading,
.reportEmpty {
    margin: 0;
    font-size: 12px;
    color: #94a3b8;
}

.reportError {
    margin: 0;
    font-size: 12px;
    color: #fca5a5;
}

.reportStatusRow {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}

.statusBadge {
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    background: #374151;
    color: #e2e8f0;
}

.statusBadge--processing {
    background: rgba(251, 191, 36, 0.2);
    color: #facc15;
}

.statusBadge--ready {
    background: rgba(34, 197, 94, 0.2);
    color: #4ade80;
}

.modeBadge {
    padding: 2px 6px;
    border-radius: 4px;
    background: rgba(99, 102, 241, 0.18);
    color: #c7d2fe;
    font-size: 11px;
}

.reportViewBtn {
    margin-left: auto;
    padding: 4px 10px;
    border-radius: 4px;
    border: 1px solid rgba(148, 163, 184, 0.4);
    background: rgba(148, 163, 184, 0.12);
    color: #e2e8f0;
    font-size: 12px;
    cursor: pointer;
    transition: background 0.2s ease;
}

.reportViewBtn:hover {
    background: rgba(148, 163, 184, 0.2);
}

.reportTimestamp {
    margin: 0;
    font-size: 11px;
    color: #94a3b8;
}

.reportTreeWrapper {
    border-top: 1px solid #2f2f2f;
    padding-top: 8px;
}

.reportFileTree {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.reportTreeNode {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.reportTreeRow {
    display: flex;
    align-items: center;
    gap: 8px;
}

.reportTreeToggle {
    width: 24px;
    height: 24px;
    border-radius: 4px;
    border: 1px solid #2f2f2f;
    background: #1f2937;
    color: #cbd5f5;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background 0.2s ease, border-color 0.2s ease;
}

.reportTreeToggle:hover {
    background: #374151;
    border-color: #475569;
}

.reportTreeSpacer {
    width: 24px;
    height: 24px;
}

.reportTreeLabel {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 13px;
    color: #e2e8f0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.reportFileTreeChildren {
    list-style: none;
    margin: 4px 0 0 24px;
    padding: 0 0 0 12px;
    border-left: 1px dashed rgba(148, 163, 184, 0.25);
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.emptyProjects {
    margin: 0;
    color: #94a3b8;
    font-size: 13px;
}

.reportViewer {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    gap: 16px;
    background: #1b1b1b;
    border: 1px solid #2f2f2f;
    border-radius: 6px;
    padding: 16px;
    min-width: 0;
}

.reportTabs {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}

.reportTab {
    border: 1px solid rgba(148, 163, 184, 0.4);
    border-radius: 4px;
    background: rgba(148, 163, 184, 0.12);
    color: #e2e8f0;
    font-size: 12px;
    padding: 4px 10px;
    cursor: pointer;
    transition: background 0.2s ease, border-color 0.2s ease;
}

.reportTab.active {
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.25), rgba(14, 165, 233, 0.25));
    border-color: rgba(59, 130, 246, 0.5);
}

.reportViewerContent {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
    overflow: hidden;
}

.reportTitle {
    margin: 0;
    font-size: 18px;
    color: #f9fafb;
}

.reportViewerTimestamp {
    margin: 0;
    font-size: 12px;
    color: #a5b4fc;
}

.reportBody {
    flex: 1 1 auto;
    margin: 0;
    padding: 16px;
    border-radius: 6px;
    background: #111827;
    border: 1px solid #1f2937;
    color: #e5e7eb;
    font-family: Consolas, "Courier New", monospace;
    font-size: 13px;
    white-space: pre-wrap;
    word-break: break-word;
    overflow: auto;
}

.reportViewerPlaceholder {
    margin: 0;
    color: #94a3b8;
    font-size: 13px;
}

.pvHeader {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 12px;
    line-height: 1.2;
}

.pvName {
    font-size: 16px;
    font-weight: 600;
    color: #f3f4f6;
    word-break: break-all;
}

.pvMeta {
    font-size: 12px;
    color: #94a3b8;
}

.pvBox {
    flex: 1 1 auto;
    background: #1b1b1b;
    border-radius: 6px;
    border: 1px solid #2f2f2f;
    padding: 12px;
    overflow: auto;
    display: flex;
}

.pvPre {
    margin: 0;
    flex: 1 1 auto;
    min-width: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: Consolas, "Courier New", monospace;
    font-size: 13px;
    line-height: 1.45;
    color: #d1d5db;
    overflow: auto;
}

.modalBackdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, .5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
}

.modalCard {
    width: 520px;
    max-width: 90vw;
    background: #252526;
    color: #e5e7eb;
    border: 1px solid #3d3d3d;
    border-radius: 10px;
    padding: 18px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, .6);
}

.modalCard h3 {
    margin: 0 0 6px;
}

.modalCard p {
    margin: 6px 0 12px;
    opacity: .9;
}

.dropZone {
    border: 2px dashed #3d3d3d;
    border-radius: 10px;
    height: 160px;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 12px;
    user-select: none;
}

.dropZone:hover {
    background: #2a2a2a;
}

.modalBtns {
    display: flex;
    gap: 10px;
}

.btn {
    padding: 8px 14px;
    border-radius: 8px;
    border: 1px solid #3d3d3d;
    background: #007acc;
    color: #fff;
    cursor: pointer;
}

.btn:hover {
    filter: brightness(1.1);
}

.btn.ghost {
    background: transparent;
    color: #e5e7eb;
}

.btn.outline {
    background: transparent;
    color: #e5e7eb;
    border-color: #4b5563;
}
</style>






































































