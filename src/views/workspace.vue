<script setup>
import { ref, reactive, watch, onMounted, onBeforeUnmount, computed, nextTick } from "vue";
import { usePreview } from "../scripts/composables/usePreview.js";
import { useTreeStore } from "../scripts/composables/useTreeStore.js";
import { useProjectsStore } from "../scripts/composables/useProjectsStore.js";
import { useAiAssistant } from "../scripts/composables/useAiAssistant.js";
import * as fileSystemService from "../scripts/services/fileSystemService.js";
import { generateReportViaDify, fetchProjectReports, generateSnippetReportViaDify } from "../scripts/services/reportService.js";
import PanelRail from "../components/workspace/PanelRail.vue";
import ChatAiWindow from "../components/ChatAiWindow.vue";
import ReportPanel from "../components/reports/ReportPanel.vue";

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
    updateCapabilityFlags,
    getProjectRootHandleById,
    safeAlertFail
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
    addSnippetContext,
    removeContext,
    clearContext,
    sendUserMessage,
    isProcessing,
    isInteractionLocked: isChatLocked,
    connection,
    retryHandshake
} = aiAssistant;

const { previewing } = preview;

const previewLineItems = computed(() => {
    if (previewing.value.kind !== "text") return [];
    const text = previewing.value.text ?? "";
    const lines = text.split(/\r\n|\r|\n/);
    if (lines.length === 0) {
        return [{ number: 1, content: "\u00A0" }];
    }
    return lines.map((line, index) => ({
        number: index + 1,
        content: line === "" ? "\u00A0" : line,
        raw: line
    }));
});

const middlePaneWidth = ref(360);
const mainContentRef = ref(null);
const codeScrollRef = ref(null);
const codeEditorRef = ref(null);
let detachSelectionChangeListener = null;
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
const reportBatchStates = reactive({});
const activeReportTarget = ref(null);
const isProjectToolActive = computed(() => activeRailTool.value === "projects");
const isReportToolActive = computed(() => activeRailTool.value === "reports");
const panelMode = computed(() => (isReportToolActive.value ? "reports" : "projects"));
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
                expandedPaths: [],
                hydratedReports: false,
                hydratingReports: false,
                reportHydrationError: ""
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
    if (!state || (state.status !== "ready" && state.status !== "error")) return null;
    const projectList = Array.isArray(projects.value) ? projects.value : [];
    const project = projectList.find((item) => String(item.id) === target.projectId);
    if (!project) return null;
    return {
        project,
        state,
        path: target.path
    };
});

const viewerHasContent = computed(() => {
    const report = activeReport.value;
    if (!report) return false;
    return report.state.status === "ready" || report.state.status === "error";
});

const hasChunkDetails = computed(() => {
    const report = activeReport.value;
    if (!report) return false;
    const chunks = report.state.chunks;
    return Array.isArray(chunks) && chunks.length > 1;
});
const middlePaneStyle = computed(() => {
    const hasActiveTool = isProjectToolActive.value || isReportToolActive.value;
    const width = hasActiveTool ? middlePaneWidth.value : 0;
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

const snippetSelection = reactive({
    startLine: null,
    endLine: null,
    startColumn: null,
    endColumn: null,
    lineCount: 0,
    text: "",
    path: ""
});
const snippetState = reactive({
    status: "idle",
    error: "",
    report: "",
    chunks: [],
    conversationId: "",
    updatedAt: null,
    updatedAtDisplay: "",
    lastSelectionKey: "",
    selection: null
});
function toFiniteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function buildSelectionDisplay(meta = {}) {
    let startLine = toFiniteNumber(meta.startLine);
    let endLine = toFiniteNumber(meta.endLine ?? startLine);
    if (startLine === null && endLine !== null) {
        startLine = endLine;
    }
    if (endLine === null && startLine !== null) {
        endLine = startLine;
    }
    let startColumn = toFiniteNumber(meta.startColumn);
    let endColumn = toFiniteNumber(meta.endColumn);
    if (startLine !== null && endLine !== null && endLine < startLine) {
        const tempLine = startLine;
        startLine = endLine;
        endLine = tempLine;
        const tempColumn = startColumn;
        startColumn = endColumn;
        endColumn = tempColumn;
    }
    const metaLineCount = toFiniteNumber(meta.lineCount);
    const hasStartLine = startLine !== null;
    const hasEndLine = endLine !== null;
    const isSingleLine = hasStartLine && hasEndLine && startLine === endLine;
    const computedLineCount = hasStartLine && hasEndLine ? Math.abs(endLine - startLine) + 1 : hasStartLine || hasEndLine ? 1 : 0;
    const lineCount = Number.isFinite(metaLineCount) && metaLineCount > 0 ? Math.max(1, Math.floor(metaLineCount)) : computedLineCount;

    const lineText = (() => {
        if (hasStartLine && hasEndLine) {
            return startLine === endLine ? `第 ${startLine} 行` : `第 ${startLine}-${endLine} 行`;
        }
        if (hasStartLine) return `第 ${startLine} 行`;
        if (hasEndLine) return `第 ${endLine} 行`;
        return "";
    })();

    const columnText = (() => {
        if (isSingleLine) {
            if (startColumn !== null && endColumn !== null) {
                if (endColumn < startColumn) {
                    return `字元 ${endColumn}-${startColumn}`;
                }
                return startColumn === endColumn ? `字元 ${startColumn}` : `字元 ${startColumn}-${endColumn}`;
            }
            if (startColumn !== null) {
                return `字元 ${startColumn} 起`;
            }
            if (endColumn !== null) {
                return `字元 ${endColumn} 止`;
            }
            return "";
        }
        const parts = [];
        if (startColumn !== null) parts.push(`起始字元 ${startColumn}`);
        if (endColumn !== null) parts.push(`結束字元 ${endColumn}`);
        return parts.join("，");
    })();

    let summary = "已選取文字";
    if (lineText && columnText) {
        summary = `已選取 ${lineText}（${columnText}）`;
    } else if (lineText) {
        summary = `已選取 ${lineText}`;
    } else if (columnText) {
        summary = `已選取 ${columnText}`;
    }

    return {
        summary,
        lineText,
        columnText,
        lineCount,
        startLine,
        endLine,
        startColumn,
        endColumn,
        isSingleLine
    };
}

function formatSelectionRangeDetails(display) {
    if (!display) return "";
    const parts = [];
    if (display.lineText) parts.push(display.lineText);
    if (display.columnText) parts.push(display.columnText);
    if (display.lineCount > 0) parts.push(`共 ${display.lineCount} 行`);
    return parts.join("，");
}

const hasSnippetSelection = computed(() => {
    if (!snippetSelection.text) return false;
    return snippetSelection.text.trim().length > 0;
});
const snippetSelectionDisplay = computed(() => {
    if (!hasSnippetSelection.value) {
        return {
            summary: "尚未選取任何內容",
            lineText: "",
            columnText: "",
            lineCount: 0,
            lineCountText: "",
            startLine: null,
            endLine: null,
            startColumn: null,
            endColumn: null
        };
    }
    const display = buildSelectionDisplay(snippetSelection);
    const lineCountText = display.lineCount > 0 ? `共 ${display.lineCount} 行` : "";
    return {
        ...display,
        lineCountText
    };
});
const snippetResultDisplay = computed(() => {
    if (!snippetState.selection) return null;
    return buildSelectionDisplay(snippetState.selection);
});
const snippetResultDetailsText = computed(() => formatSelectionRangeDetails(snippetResultDisplay.value));
const snippetHighlightMap = computed(() => {
    if (!hasSnippetSelection.value) return new Map();
    const display = buildSelectionDisplay(snippetSelection);
    const startLine = toFiniteNumber(display.startLine);
    const endLine = toFiniteNumber(display.endLine);
    if (startLine === null || endLine === null) {
        return new Map();
    }
    const fromLine = Math.min(startLine, endLine);
    const toLine = Math.max(startLine, endLine);
    const startColumn = toFiniteNumber(display.startColumn) ?? 1;
    const endColumn = toFiniteNumber(display.endColumn);
    const lineLookup = new Map();
    for (const line of previewLineItems.value) {
        lineLookup.set(line.number, line);
    }
    const map = new Map();
    for (let lineNumber = fromLine; lineNumber <= toLine; lineNumber += 1) {
        const item = lineLookup.get(lineNumber);
        const rawText = typeof item?.raw === "string" ? item.raw : (item?.content || "").replace(/\u00A0/g, " ");
        const lineLength = rawText.length;
        const maxColumn = Math.max(1, lineLength);
        let highlightStart = 1;
        let highlightEnd = maxColumn;
        if (lineNumber === startLine) {
            const baseStart = Number.isFinite(startColumn) ? startColumn : 1;
            highlightStart = Math.min(Math.max(baseStart, 1), maxColumn);
        }
        if (lineNumber === endLine) {
            const baseEnd = Number.isFinite(endColumn) ? endColumn : maxColumn;
            highlightEnd = Math.min(Math.max(baseEnd, 1), maxColumn);
        }
        if (lineNumber !== startLine && lineNumber !== endLine) {
            highlightStart = 1;
            highlightEnd = maxColumn;
        }
        if (lineNumber === startLine && lineNumber === endLine) {
            const baseStart = Number.isFinite(startColumn) ? startColumn : 1;
            const baseEnd = Number.isFinite(endColumn) ? endColumn : maxColumn;
            highlightStart = Math.min(Math.max(baseStart, 1), maxColumn);
            highlightEnd = Math.min(Math.max(baseEnd, highlightStart), maxColumn);
        } else {
            highlightEnd = Math.max(highlightEnd, highlightStart);
        }
        if (lineLength === 0) {
            highlightStart = 1;
            highlightEnd = 1;
        }
        const coversFullLine = highlightStart <= 1 && (highlightEnd >= maxColumn || lineLength === 0);
        map.set(lineNumber, {
            startColumn: highlightStart,
            endColumn: highlightEnd,
            coversFullLine,
            lineLength
        });
    }
    return map;
});
function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function renderLineContent(line) {
    const entry = snippetHighlightMap.value.get(line.number);
    const rawText = typeof line?.raw === "string" ? line.raw : (line?.content || "").replace(/\u00A0/g, " ");
    if (!entry) {
        const safe = escapeHtml(rawText);
        return safe.length ? safe : "&nbsp;";
    }
    const text = rawText;
    const length = text.length;
    const startColumn = Number.isFinite(entry.startColumn) ? entry.startColumn : 1;
    const endColumn = Number.isFinite(entry.endColumn) ? entry.endColumn : length;
    const startIndex = Math.max(0, Math.min(length, startColumn - 1));
    const endExclusive = Math.max(startIndex, Math.min(length, endColumn));
    const before = escapeHtml(text.slice(0, startIndex));
    const highlightText = escapeHtml(text.slice(startIndex, endExclusive));
    const after = escapeHtml(text.slice(endExclusive));
    const highlightInner = highlightText.length ? highlightText : "&nbsp;";
    const highlightClass = entry.coversFullLine ? "codeLineHighlight codeLineHighlight--full" : "codeLineHighlight";
    const highlighted = `<span class="${highlightClass}">${highlightInner}</span>`;
    const combined = `${before}${highlighted}${after}`;
    if (!combined.trim()) {
        return `<span class="${highlightClass}">&nbsp;</span>`;
    }
    return combined || "&nbsp;";
}
const activeSnippetPath = computed(() => previewing.value.path || activeTreePath.value || "");
const snippetCurrentKey = computed(() => {
    if (!hasSnippetSelection.value) return "";
    const start = typeof snippetSelection.startLine === "number" ? snippetSelection.startLine : "";
    const end = typeof snippetSelection.endLine === "number" ? snippetSelection.endLine : start;
    const startColumn = typeof snippetSelection.startColumn === "number" ? snippetSelection.startColumn : "";
    const endColumn = typeof snippetSelection.endColumn === "number" ? snippetSelection.endColumn : startColumn;
    const text = snippetSelection.text || "";
    const hashPreview = text.slice(0, 64);
    const length = text.length;
    const path = activeSnippetPath.value || "";
    return `${path}::${start}-${end}::${startColumn}-${endColumn}::${length}::${hashPreview}`;
});
const snippetIsProcessing = computed(() => snippetState.status === "processing");
const snippetReportReady = computed(() => snippetState.status === "ready");
const snippetHasChunks = computed(() => Array.isArray(snippetState.chunks) && snippetState.chunks.length > 1);
const canGenerateSnippet = computed(
    () =>
        hasSnippetSelection.value &&
        previewing.value.kind === "text" &&
        !snippetIsProcessing.value
);
const canSendSnippetToChat = computed(
    () =>
        hasSnippetSelection.value &&
        previewing.value.kind === "text" &&
        snippetSelection.text.trim().length > 0
);
const snippetTrackingEnabled = computed(
    () => supportsSelectionTracking && previewing.value.kind === "text"
);

const supportsSelectionTracking =
    typeof document !== "undefined" && typeof window !== "undefined";
const TEXT_NODE = typeof Node !== "undefined" ? Node.TEXT_NODE : 3;

function clearSnippetSelection() {
    snippetSelection.startLine = null;
    snippetSelection.endLine = null;
    snippetSelection.startColumn = null;
    snippetSelection.endColumn = null;
    snippetSelection.lineCount = 0;
    snippetSelection.text = "";
    snippetSelection.path = "";
}

function resetSnippetResult() {
    snippetState.status = "idle";
    snippetState.error = "";
    snippetState.report = "";
    snippetState.chunks = [];
    snippetState.conversationId = "";
    snippetState.updatedAt = null;
    snippetState.updatedAtDisplay = "";
    snippetState.selection = null;
}

function clearSnippetSelectionAndResult() {
    resetSnippetPointerState();
    clearSnippetSelection();
    resetSnippetResult();
    snippetState.lastSelectionKey = "";
}

function isLineInSnippetSelection(lineNumber) {
    if (typeof lineNumber !== "number" || Number.isNaN(lineNumber)) return false;
    const entry = snippetHighlightMap.value.get(lineNumber);
    return Boolean(entry && entry.coversFullLine);
}

function containerContainsNode(container, node) {
    if (!container || !node) return false;
    if (container.contains(node)) return true;
    if (node.nodeType === TEXT_NODE) {
        return containerContainsNode(container, node.parentNode);
    }
    return false;
}

function getLineNumberFromNode(node) {
    const lineElement = getLineElementFromNode(node);
    if (!lineElement) return null;
    const value = Number(lineElement.getAttribute("data-line"));
    return Number.isFinite(value) ? value : null;
}

function getLineElementFromNode(node) {
    if (!node) return null;
    let current = node;
    if (current.nodeType === TEXT_NODE) {
        current = current.parentElement || current.parentNode;
    }
    if (!(current instanceof HTMLElement)) {
        return null;
    }
    const lineElement = current.closest("[data-line]");
    return lineElement instanceof HTMLElement ? lineElement : null;
}

function getLineContentElement(lineElement) {
    if (!lineElement) return null;
    const content = lineElement.querySelector(".codeLineContent");
    return content instanceof HTMLElement ? content : null;
}

function measureColumnOffset(lineElement, container, offset, inclusiveStart) {
    const content = getLineContentElement(lineElement);
    if (!content) return null;

    const SHOW_TEXT = typeof NodeFilter !== "undefined" ? NodeFilter.SHOW_TEXT : 4;

    const clamp = (value, min, max) => {
        if (!Number.isFinite(value)) return min;
        return Math.max(min, Math.min(max, value));
    };

    const accumulateFromTextNodes = (targetNode, targetOffset, includeStartColumn) => {
        const walker = document.createTreeWalker(content, SHOW_TEXT, null);
        let total = 0;
        while (walker.nextNode()) {
            const node = walker.currentNode;
            const length = typeof node.textContent === "string" ? node.textContent.length : 0;
            if (node === targetNode) {
                const safeOffset = clamp(targetOffset, 0, length);
                const base = total + safeOffset;
                return includeStartColumn ? base + 1 : base;
            }
            total += length;
        }
        return null;
    };

    if (container && container.nodeType === TEXT_NODE) {
        const measured = accumulateFromTextNodes(container, offset, inclusiveStart);
        if (measured !== null) {
            return measured;
        }
    }

    if (container === content && container.childNodes) {
        const children = Array.from(container.childNodes);
        const safeIndex = clamp(offset, 0, children.length);
        let count = 0;
        for (let index = 0; index < safeIndex; index += 1) {
            const child = children[index];
            if (child && typeof child.textContent === "string") {
                count += child.textContent.length;
            }
        }
        return inclusiveStart ? count + 1 : count;
    }

    try {
        const range = document.createRange();
        range.selectNodeContents(content);
        range.setEnd(container, offset);
        const text = range.toString();
        if (inclusiveStart) {
            return text.length + 1;
        }
        return text.length;
    } catch (_error) {
        return null;
    }
}

function applyRangeSelection(range) {
    if (!supportsSelectionTracking) return false;
    if (!range) return false;
    const container = codeEditorRef.value || codeScrollRef.value;
    if (!container) return false;
    const { startContainer, endContainer } = range;
    if (
        !containerContainsNode(container, startContainer) ||
        !containerContainsNode(container, endContainer)
    ) {
        return false;
    }
    const selectedText = range.toString();
    if (!selectedText || !selectedText.trim()) {
        clearSnippetSelection();
        return false;
    }
    let startLine = getLineNumberFromNode(startContainer);
    let endLine = getLineNumberFromNode(endContainer);
    if (startLine === null && endLine !== null) {
        startLine = endLine;
    }
    if (endLine === null && startLine !== null) {
        endLine = startLine;
    }
    const startLineElement = getLineElementFromNode(startContainer);
    const endLineElement = getLineElementFromNode(endContainer);
    let startColumnRaw = startLineElement
        ? measureColumnOffset(startLineElement, range.startContainer, range.startOffset, true)
        : null;
    let endColumnRaw = endLineElement
        ? measureColumnOffset(endLineElement, range.endContainer, range.endOffset, false)
        : null;
    if (startLine !== null && endLine !== null && endLine < startLine) {
        const tempLine = startLine;
        startLine = endLine;
        endLine = tempLine;
        const tempColumn = startColumnRaw;
        startColumnRaw = endColumnRaw;
        endColumnRaw = tempColumn;
    }
    let startColumn = Number.isFinite(startColumnRaw) ? Math.max(1, Math.floor(startColumnRaw)) : null;
    let endColumn = Number.isFinite(endColumnRaw) ? Math.max(0, Math.floor(endColumnRaw)) : null;
    if (
        endColumn === 0 &&
        endLine !== null &&
        startLine !== null &&
        endLine > startLine
    ) {
        const previousLineNumber = endLine - 1;
        const previousLine = previewLineItems.value.find((line) => line.number === previousLineNumber);
        if (previousLine) {
            const prevRaw = typeof previousLine.raw === "string" ? previousLine.raw : "";
            endLine = previousLineNumber;
            endColumn = prevRaw.length > 0 ? prevRaw.length : null;
        }
    }
    if (startLine !== null && endLine !== null && startLine === endLine) {
        if (startColumn !== null && endColumn !== null && endColumn < startColumn) {
            const temp = startColumn;
            startColumn = endColumn;
            endColumn = temp;
        }
    }

    snippetSelection.startLine = startLine;
    snippetSelection.endLine = endLine;
    snippetSelection.startColumn = startColumn;
    snippetSelection.endColumn = endColumn;
    const selectionDisplay = buildSelectionDisplay({
        startLine,
        endLine,
        startColumn,
        endColumn
    });
    snippetSelection.lineCount = selectionDisplay.lineCount;
    snippetSelection.text = selectedText;
    snippetSelection.path = activeSnippetPath.value || "";
    return true;
}

function resetSnippetPointerState() {
}

function syncSnippetSelectionFromNativeRange() {
    if (!snippetTrackingEnabled.value || !supportsSelectionTracking) return;
    if (previewing.value.kind !== "text") return;
    const container = codeEditorRef.value || codeScrollRef.value;
    if (!container) return;
    const selection = document.getSelection?.();
    if (!selection || selection.rangeCount === 0) {
        return;
    }
    const range = selection.getRangeAt(0);
    if (!range || range.collapsed) {
        return;
    }
    const { startContainer, endContainer } = range;
    if (!containerContainsNode(container, startContainer) || !containerContainsNode(container, endContainer)) {
        return;
    }
    applyRangeSelection(range);
}

function attachSelectionChangeListener() {
    if (typeof document === "undefined") return;
    if (typeof detachSelectionChangeListener === "function") {
        return;
    }
    const handler = () => {
        syncSnippetSelectionFromNativeRange();
    };
    document.addEventListener("selectionchange", handler);
    detachSelectionChangeListener = () => {
        document.removeEventListener("selectionchange", handler);
        detachSelectionChangeListener = null;
    };
}

function detachSelectionChangeListenerIfNeeded() {
    if (typeof detachSelectionChangeListener === "function") {
        detachSelectionChangeListener();
    }
}

function handleCodeEditorBeforeInput(event) {
    if (!event) return;
    event.preventDefault();
}

function handleCodeEditorKeydown(event) {
    if (!event) return;
    if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
    }
    const allowedKeys = new Set([
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "PageUp",
        "PageDown",
        "Home",
        "End",
        "Shift",
        "Escape",
        "Tab"
    ]);
    if (!allowedKeys.has(event.key)) {
        event.preventDefault();
    }
}

function handleCodeEditorKeyup() {
    syncSnippetSelectionFromNativeRange();
}

function handleCodeEditorMouseup() {
    syncSnippetSelectionFromNativeRange();
}

function handleCodeEditorPaste(event) {
    if (!event) return;
    event.preventDefault();
}

function handleCodeEditorDrop(event) {
    if (!event) return;
    event.preventDefault();
}

watch(snippetCurrentKey, (key) => {
    if (!key) {
        if (snippetSelection.text) {
            clearSnippetSelection();
        }
        resetSnippetResult();
        snippetState.lastSelectionKey = "";
        return;
    }
    if (snippetState.status === "processing") {
        return;
    }
    if (snippetState.lastSelectionKey && snippetState.lastSelectionKey === key) {
        return;
    }
    resetSnippetResult();
});

watch(
    () => previewing.value.kind,
    (kind) => {
        if (kind !== "text") {
            clearSnippetSelectionAndResult();
        }
    }
);

watch(
    () => previewing.value.path,
    () => {
        clearSnippetSelectionAndResult();
    }
);

watch(
    snippetTrackingEnabled,
    (enabled) => {
        if (!supportsSelectionTracking) return;
        if (!enabled) {
            resetSnippetPointerState();
            clearSnippetSelection();
            resetSnippetResult();
        }
    },
    { immediate: true }
);

watch(
    () => snippetTrackingEnabled.value && previewing.value.kind === "text",
    (enabled) => {
        if (!supportsSelectionTracking) return;
        if (enabled) {
            attachSelectionChangeListener();
        } else {
            detachSelectionChangeListenerIfNeeded();
        }
    },
    { immediate: true }
);

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
        updatedAtDisplay: null,
        error: "",
        chunks: [],
        segments: [],
        conversationId: ""
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
            expandedPaths: [],
            hydratedReports: false,
            hydratingReports: false,
            reportHydrationError: ""
        };
    }
    return reportTreeCache[key];
}

function ensureProjectBatchState(projectId) {
    const key = normaliseProjectId(projectId);
    if (!key) return null;
    if (!Object.prototype.hasOwnProperty.call(reportBatchStates, key)) {
        reportBatchStates[key] = {
            running: false,
            processed: 0,
            total: 0
        };
    }
    return reportBatchStates[key];
}

function getProjectBatchState(projectId) {
    const key = normaliseProjectId(projectId);
    if (!key) return null;
    return reportBatchStates[key] || null;
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
        case "error":
            return "失敗";
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

function parseHydratedTimestamp(value) {
    if (!value) return null;
    if (value instanceof Date) return value;
    if (typeof value === "number" && Number.isFinite(value)) {
        return new Date(value);
    }
    if (typeof value === "string" && value.trim()) {
        const parsed = Date.parse(value);
        if (!Number.isNaN(parsed)) {
            return new Date(parsed);
        }
    }
    return null;
}

async function hydrateReportsForProject(projectId) {
    const entry = ensureReportTreeEntry(projectId);
    if (!entry) return;
    if (entry.hydratedReports || entry.hydratingReports) return;
    entry.hydratingReports = true;
    entry.reportHydrationError = "";
    try {
        const records = await fetchProjectReports(projectId);
        for (const record of records) {
            if (!record || !record.path) continue;
            const state = ensureFileReportState(projectId, record.path);
            if (!state) continue;
            state.status = record.report ? "ready" : "idle";
            state.report = record.report || "";
            state.error = "";
            state.chunks = Array.isArray(record.chunks) ? record.chunks : [];
            state.segments = Array.isArray(record.segments) ? record.segments : [];
            state.conversationId = record.conversationId || "";
            const timestamp = parseHydratedTimestamp(record.generatedAt || record.updatedAt || record.createdAt);
            state.updatedAt = timestamp;
            state.updatedAtDisplay = timestamp ? timestamp.toLocaleString() : null;
        }
        entry.hydratedReports = true;
    } catch (error) {
        console.error("[Report] Failed to hydrate saved reports", { projectId, error });
        entry.reportHydrationError = error?.message ? String(error.message) : String(error);
    } finally {
        entry.hydratingReports = false;
    }
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
        await hydrateReportsForProject(projectId);
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

async function generateReportForFile(project, node, options = {}) {
    const { autoSelect = true, silent = false } = options;
    if (!project || !node || node.type !== "file") {
        return { status: "skipped" };
    }
    const projectId = normaliseProjectId(project.id);
    const state = ensureFileReportState(projectId, node.path);
    if (!state || state.status === "processing") {
        return { status: "processing" };
    }

    state.status = "processing";
    state.error = "";
    state.report = "";
    state.chunks = [];
    state.segments = [];
    state.conversationId = "";

    try {
        const root = await getProjectRootHandleById(project.id);
        const fileHandle = await fileSystemService.getFileHandleByPath(root, node.path);
        const file = await fileHandle.getFile();
        const mime = node.mime || file.type || "";
        if (!preview.isTextLike(node.name, mime)) {
            throw new Error("目前僅支援純文字或程式碼檔案的審查");
        }
        const text = await file.text();
        if (!text.trim()) {
            throw new Error("檔案內容為空");
        }

        const payload = await generateReportViaDify({
            projectId,
            projectName: project.name,
            path: node.path,
            content: text
        });

        const completedAt = payload?.generatedAt ? new Date(payload.generatedAt) : new Date();
        state.status = "ready";
        state.updatedAt = completedAt;
        state.updatedAtDisplay = completedAt.toLocaleString();
        state.report = payload?.report || "";
        state.chunks = Array.isArray(payload?.chunks) ? payload.chunks : [];
        state.segments = Array.isArray(payload?.segments) ? payload.segments : [];
        state.conversationId = payload?.conversationId || "";
        state.error = "";

        if (autoSelect) {
            activeReportTarget.value = {
                projectId,
                path: node.path
            };
        }

        return { status: "ready" };
    } catch (error) {
        const message = error?.message ? String(error.message) : String(error);
        state.status = "error";
        state.error = message;
        state.report = "";
        state.chunks = [];
        state.segments = [];
        state.conversationId = "";
        const now = new Date();
        state.updatedAt = now;
        state.updatedAtDisplay = now.toLocaleString();

        console.error("[Report] Failed to generate report", {
            projectId,
            path: node?.path,
            error
        });

        if (autoSelect) {
            activeReportTarget.value = {
                projectId,
                path: node.path
            };
        }

        if (!silent) {
            if (error?.name === "SecurityError" || error?.name === "NotAllowedError" || error?.name === "TypeError") {
                await safeAlertFail("生成報告失敗", error);
            } else {
                alert(`生成報告失敗：${message}`);
            }
        }

        return { status: "error", error };
    }
}

async function generateProjectReports(project) {
    if (!project) return;
    const projectId = normaliseProjectId(project.id);
    const batchState = ensureProjectBatchState(projectId);
    if (!batchState || batchState.running) return;

    const entry = ensureReportTreeEntry(project.id);
    if (!entry.nodes.length) {
        await loadReportTreeForProject(project.id);
    }

    if (entry.loading) {
        await new Promise((resolve) => {
            const stop = watch(
                () => entry.loading,
                (loading) => {
                    if (!loading) {
                        stop();
                        resolve();
                    }
                }
            );
        });
    }

    if (entry.error) {
        console.warn("[Report] Cannot start batch generation due to tree error", entry.error);
        alert(`無法生成報告：${entry.error}`);
        return;
    }

    const nodes = collectFileNodes(entry.nodes);
    if (!nodes.length) {
        alert("此專案尚未索引可供審查的檔案");
        return;
    }

    batchState.running = true;
    batchState.processed = 0;
    batchState.total = nodes.length;

    try {
        for (const node of nodes) {
            await generateReportForFile(project, node, { autoSelect: false, silent: true });
            batchState.processed += 1;
        }
    } finally {
        batchState.running = false;
        if (nodes.length) {
            activeReportTarget.value = {
                projectId,
                path: nodes[nodes.length - 1].path
            };
        }
    }
}

async function generateSnippetAnalysis() {
    if (snippetIsProcessing.value) return;
    if (!hasSnippetSelection.value) {
        alert("請先在預覽中選取要分析的程式碼段落。");
        return;
    }
    if (previewing.value.kind !== "text") {
        alert("僅支援對純文字或程式碼檔案進行區塊審查。");
        return;
    }
    const projectIdRaw = selectedProjectId.value;
    if (!projectIdRaw) {
        alert("請先選擇一個專案。");
        return;
    }
    const path = activeSnippetPath.value;
    if (!path) {
        alert("請先從左側檔案樹選擇要分析的檔案。");
        return;
    }

    const projectId = normaliseProjectId(projectIdRaw);
    const projectList = Array.isArray(projects.value) ? projects.value : [];
    const project = projectList.find((item) => normaliseProjectId(item.id) === projectId);

    snippetState.status = "processing";
    snippetState.error = "";
    snippetState.report = "";
    snippetState.chunks = [];
    snippetState.conversationId = "";
    snippetState.updatedAt = null;
    snippetState.updatedAtDisplay = "";
    snippetState.selection = null;

    try {
        const payload = await generateSnippetReportViaDify({
            projectId,
            projectName: project?.name,
            path,
            selection: {
                startLine: snippetSelection.startLine,
                endLine: snippetSelection.endLine,
                startColumn: snippetSelection.startColumn,
                endColumn: snippetSelection.endColumn,
                lineCount: snippetSelection.lineCount,
                content: snippetSelection.text
            }
        });
        const completedAt = payload?.generatedAt ? new Date(payload.generatedAt) : new Date();
        snippetState.status = "ready";
        snippetState.report = payload?.report || "";
        snippetState.chunks = Array.isArray(payload?.chunks) ? payload.chunks : [];
        snippetState.conversationId = payload?.conversationId || "";
        snippetState.updatedAt = completedAt;
        snippetState.updatedAtDisplay = completedAt.toLocaleString();
        const responseSelection = payload?.selection || {};
        snippetState.selection = {
            startLine:
                typeof responseSelection.startLine === "number"
                    ? responseSelection.startLine
                    : snippetSelection.startLine,
            endLine:
                typeof responseSelection.endLine === "number"
                    ? responseSelection.endLine
                    : snippetSelection.endLine,
            startColumn:
                typeof responseSelection.startColumn === "number"
                    ? responseSelection.startColumn
                    : snippetSelection.startColumn,
            endColumn:
                typeof responseSelection.endColumn === "number"
                    ? responseSelection.endColumn
                    : snippetSelection.endColumn,
            lineCount:
                typeof responseSelection.lineCount === "number"
                    ? responseSelection.lineCount
                    : snippetSelectionDisplay.value.lineCount,
            label: responseSelection.label || "",
            path
        };
        snippetState.error = "";
        snippetState.lastSelectionKey = snippetCurrentKey.value;
    } catch (error) {
        const message = error?.message ? String(error.message) : String(error);
        snippetState.status = "error";
        snippetState.error = message;
        snippetState.report = "";
        snippetState.chunks = [];
        snippetState.conversationId = "";
        const now = new Date();
        snippetState.updatedAt = now;
        snippetState.updatedAtDisplay = now.toLocaleString();
        snippetState.selection = null;
        console.error("[Snippet] Failed to generate snippet report", {
            projectId,
            path,
            error
        });
        if (error?.name === "SecurityError" || error?.name === "NotAllowedError" || error?.name === "TypeError") {
            await safeAlertFail("生成區塊報告失敗", error);
        } else {
            alert(`生成區塊報告失敗：${message}`);
        }
    }
}

async function sendSnippetToChat() {
    if (!canSendSnippetToChat.value) {
        alert("請先在預覽中選取要分享給 Chat AI 的程式碼段落。");
        return;
    }
    const projectIdRaw = selectedProjectId.value;
    if (!projectIdRaw) {
        alert("請先選擇一個專案。");
        return;
    }
    const path = snippetSelection.path || activeSnippetPath.value || "";
    if (!path) {
        alert("請先從左側檔案樹選擇要分享的檔案。");
        return;
    }

    const startLine = typeof snippetSelection.startLine === "number" ? snippetSelection.startLine : null;
    const endLine = typeof snippetSelection.endLine === "number" ? snippetSelection.endLine : startLine;
    const startColumn = typeof snippetSelection.startColumn === "number" ? snippetSelection.startColumn : null;
    const endColumn = typeof snippetSelection.endColumn === "number" ? snippetSelection.endColumn : null;
    const selectionDisplay = buildSelectionDisplay({
        startLine,
        endLine,
        startColumn,
        endColumn,
        lineCount: snippetSelection.lineCount
    });
    const lineCount = selectionDisplay.lineCount || 0;
    const snippetText = snippetSelection.text || "";
    if (!snippetText.trim()) {
        alert("目前沒有可用的程式碼選取。");
        return;
    }

    const labelSegments = [];
    const projectList = Array.isArray(projects.value) ? projects.value : [];
    const projectId = normaliseProjectId(projectIdRaw);
    const project = projectList.find((item) => normaliseProjectId(item.id) === projectId);
    if (project) {
        labelSegments.push(project.name);
    }
    labelSegments.push(path);
    if (selectionDisplay.lineText) {
        labelSegments.push(selectionDisplay.lineText);
    }
    if (selectionDisplay.columnText) {
        labelSegments.push(selectionDisplay.columnText);
    }
    const label = labelSegments.join(" / ");

    const success = await addSnippetContext({
        id: `snippet-${Date.now()}`,
        label,
        path,
        startLine,
        endLine,
        lineCount,
        startColumn,
        endColumn,
        content: snippetText
    });

    if (success) {
        openChatWindow();
    }
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
            if (
                isReportToolActive.value &&
                entry &&
                !entry.hydratedReports &&
                !entry.hydratingReports
            ) {
                hydrateReportsForProject(project.id);
            }
        });

        Object.keys(reportTreeCache).forEach((projectId) => {
            if (!currentIds.has(projectId)) {
                delete reportTreeCache[projectId];
            }
        });

        Object.keys(reportBatchStates).forEach((projectId) => {
            if (!currentIds.has(projectId)) {
                delete reportBatchStates[projectId];
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
            if (entry && !entry.hydratedReports && !entry.hydratingReports) {
                hydrateReportsForProject(project.id);
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
    window.addEventListener("resize", clampReportSidebarWidth);
});

onBeforeUnmount(() => {
    window.removeEventListener("resize", ensureChatWindowInView);
    window.removeEventListener("resize", clampReportSidebarWidth);
    stopChatDrag();
    stopChatResize();
    detachSelectionChangeListenerIfNeeded();
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
                :mode="panelMode"
                :projects="projects"
                :selected-project-id="selectedProjectId"
                :on-select-project="handleSelectProject"
                :on-delete-project="deleteProject"
                :is-tree-collapsed="isTreeCollapsed"
                :show-content="isProjectToolActive || isReportToolActive"
                :tree="tree"
                :active-tree-path="activeTreePath"
                :is-loading-tree="isLoadingTree"
                :open-node="openNode"
                :select-tree-node="selectTreeNode"
                @resize-start="startPreviewResize"
            >
                <template v-if="isReportToolActive">
                    <ReportPanel
                        :style-width="{ flex: '1 1 auto', width: '100%' }"
                        :entries="reportProjectEntries"
                        :normalise-project-id="normaliseProjectId"
                        :is-node-expanded="isReportNodeExpanded"
                        :toggle-node="toggleReportNode"
                        :get-report-state="getReportStateForFile"
                        :on-generate="generateReportForFile"
                        :on-select="selectReport"
                        :get-status-label="getStatusLabel"
                        :on-reload-project="loadReportTreeForProject"
                        :on-generate-project="generateProjectReports"
                        :get-project-batch-state="getProjectBatchState"
                        :active-target="activeReportTarget"
                        :is-resizing="false"
                        :enable-resize-edge="false"
                    />
                </template>
            </PanelRail>

            <section class="workSpace" :class="{ 'workSpace--reports': isReportToolActive }">
                <template v-if="isReportToolActive">
                    <div class="panelHeader">報告檢視</div>
                    <template v-if="hasReadyReports || viewerHasContent">
                        <div v-if="readyReports.length" class="reportTabs">
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
                        <div class="reportViewerContent">
                            <template v-if="activeReport">
                                <div class="reportViewerHeader">
                                    <h3 class="reportTitle">{{ activeReport.project.name }} / {{ activeReport.path }}</h3>
                                    <p class="reportViewerTimestamp">更新於 {{ activeReport.state.updatedAtDisplay || '-' }}</p>
                                </div>
                                <div v-if="activeReport.state.status === 'error'" class="reportErrorPanel">
                                    <p class="reportErrorText">生成失敗：{{ activeReport.state.error || '未知原因' }}</p>
                                    <p class="reportErrorHint">請檢查檔案權限、Dify 設定或稍後再試。</p>
                                </div>
                                <template v-else>
                                    <pre class="reportBody codeScroll">{{ activeReport.state.report }}</pre>
                                    <details v-if="hasChunkDetails" class="reportChunks">
                                        <summary>分段輸出（{{ activeReport.state.chunks.length }}）</summary>
                                        <ol class="reportChunkList">
                                            <li
                                                v-for="chunk in activeReport.state.chunks"
                                                :key="`${chunk.index}-${chunk.total}`"
                                            >
                                                <h4 class="reportChunkTitle">第 {{ chunk.index }} 段</h4>
                                                <pre class="reportChunkBody codeScroll">{{ chunk.answer }}</pre>
                                            </li>
                                        </ol>
                                    </details>
                                </template>
                            </template>
                            <template v-else>
                                <div class="reportViewerPlaceholder">請從左側選擇檔案報告。</div>
                            </template>
                        </div>
                    </template>
                    <p v-else class="reportViewerPlaceholder">尚未生成任何報告，請先於左側檔案中啟動生成。</p>
                </template>
                <template v-else-if="previewing.kind && previewing.kind !== 'error'">
                    <div class="pvHeader">
                        <div class="pvName">{{ previewing.name }}</div>
                        <div class="pvMeta">{{ previewing.mime || '-' }} | {{ (previewing.size / 1024).toFixed(1) }} KB</div>
                    </div>

                    <template v-if="previewing.kind === 'text'">
                        <div class="snippetInlinePanel">
                            <div class="snippetInlinePanel__info">
                                <h3 class="snippetInlinePanel__title">程式碼選取</h3>
                                <p class="snippetInlinePanel__hint">拖曳以選取程式碼段落，可直接送交 Dify 或 Chat AI。</p>
                                <p
                                    class="snippetInlinePanel__status"
                                    :class="{ 'snippetInlinePanel__status--empty': !hasSnippetSelection }"
                                >
                                    {{ snippetSelectionDisplay.summary }}
                                </p>
                                <p
                                    v-if="hasSnippetSelection && snippetSelectionDisplay.lineCountText"
                                    class="snippetInlinePanel__meta"
                                >
                                    {{ snippetSelectionDisplay.lineCountText }}
                                </p>
                            </div>
                            <div class="snippetInlinePanel__actions">
                                <button
                                    type="button"
                                    class="btn"
                                    :disabled="!canGenerateSnippet"
                                    @click="generateSnippetAnalysis"
                                >
                                    {{ snippetIsProcessing ? "分析中…" : "分析選取段落" }}
                                </button>
                                <button
                                    type="button"
                                    class="btn outline"
                                    :disabled="!canSendSnippetToChat"
                                    @click="sendSnippetToChat"
                                >
                                    加入 Chat AI
                                </button>
                                <button
                                    type="button"
                                    class="btn ghost"
                                    :disabled="!hasSnippetSelection"
                                    @click="clearSnippetSelectionAndResult"
                                >
                                    清除選取
                                </button>
                            </div>
                        </div>

                        <div class="pvBox codeBox">
                            <div class="codeScroll" ref="codeScrollRef">
                                <div
                                    class="codeEditor"
                                    ref="codeEditorRef"
                                    contenteditable="true"
                                    spellcheck="false"
                                    autocorrect="off"
                                    autocapitalize="off"
                                    @beforeinput="handleCodeEditorBeforeInput"
                                    @keydown="handleCodeEditorKeydown"
                                    @keyup="handleCodeEditorKeyup"
                                    @mouseup="handleCodeEditorMouseup"
                                    @paste="handleCodeEditorPaste"
                                    @drop="handleCodeEditorDrop"
                                >
                                    <div
                                        v-for="line in previewLineItems"
                                        :key="line.number"
                                        class="codeLine"
                                        :data-line="line.number"
                                        :class="{ 'codeLine--selected': isLineInSnippetSelection(line.number) }"
                                    >
                                        <span class="codeLineNo">{{ line.number }}</span>
                                        <span class="codeLineContent" v-html="renderLineContent(line)"></span>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div v-if="snippetState.status !== 'idle'" class="snippetResultCard">
                            <div class="snippetResultCard__header">
                                <h3>區塊分析</h3>
                                <p v-if="snippetState.updatedAtDisplay" class="snippetResultCard__timestamp">
                                    更新於 {{ snippetState.updatedAtDisplay }}
                                </p>
                            </div>
                            <p v-if="snippetState.status === 'processing'" class="snippetResultCard__hint">
                                正在生成區塊報告，請稍候…
                            </p>
                            <div v-else-if="snippetState.status === 'error'" class="reportErrorPanel">
                                <p class="reportErrorText">生成失敗：{{ snippetState.error || '未知原因' }}</p>
                                <p class="reportErrorHint">請檢查 Dify 設定或稍後再試。</p>
                            </div>
                            <template v-else-if="snippetReportReady">
                                <p v-if="snippetState.selection" class="snippetResultSelection">
                                    來源：
                                    <span class="snippetResultPath">{{ snippetState.selection.path || '-' }}</span>
                                    <span v-if="snippetResultDetailsText" class="snippetResultRange">
                                        （{{ snippetResultDetailsText }}）
                                    </span>
                                </p>
                                <pre class="reportBody codeScroll snippetReportBody">{{ snippetState.report }}</pre>
                                <details v-if="snippetHasChunks" class="reportChunks">
                                    <summary>分段輸出（{{ snippetState.chunks.length }}）</summary>
                                    <ol class="reportChunkList">
                                        <li
                                            v-for="chunk in snippetState.chunks"
                                            :key="`${chunk.index}-${chunk.total}`"
                                        >
                                            <h4 class="reportChunkTitle">第 {{ chunk.index }} 段</h4>
                                            <pre class="reportChunkBody codeScroll">{{ chunk.answer }}</pre>
                                        </li>
                                    </ol>
                                </details>
                            </template>
                        </div>
                    </template>

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
    .snippetInlinePanel {
        flex-direction: column;
        align-items: stretch;
    }
    .snippetInlinePanel__actions {
        justify-content: flex-start;
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
    padding: 16px;
    gap: 16px;
    background: #202020;
    border-color: #323232;
    overflow: auto;
}

.snippetInlinePanel {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    background: #1b1b1b;
    border: 1px solid #2f2f2f;
    border-radius: 6px;
    padding: 12px;
}

.snippetInlinePanel__info {
    flex: 1 1 280px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    color: #e2e8f0;
}

.snippetInlinePanel__title {
    margin: 0;
    font-size: 16px;
    font-weight: 700;
}

.snippetInlinePanel__hint {
    margin: 0;
    font-size: 13px;
    color: #94a3b8;
}

.snippetInlinePanel__meta {
    margin: 0;
    font-size: 12px;
    color: #9ca3af;
}

.snippetInlinePanel__status {
    margin: 0;
    font-size: 13px;
    color: #38bdf8;
}

.snippetInlinePanel__status--empty {
    color: #cbd5e1;
}

.snippetInlinePanel__actions {
    flex: 0 0 auto;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: flex-end;
}

.snippetResultCard {
    background: #191919;
    border: 1px solid #323232;
    border-radius: 6px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.snippetResultCard__header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 8px;
}

.snippetResultCard__header h3 {
    margin: 0;
    font-size: 16px;
    color: #e2e8f0;
}

.snippetResultCard__timestamp {
    margin: 0;
    font-size: 12px;
    color: #94a3b8;
}

.snippetResultCard__hint {
    margin: 0;
    font-size: 13px;
    color: #cbd5e1;
}

.snippetResultSelection {
    margin: 0;
    font-size: 13px;
    color: #a5b4fc;
}

.snippetResultPath {
    font-weight: 600;
}

.snippetResultRange {
    margin-left: 6px;
    color: #9ca3af;
}

.snippetReportBody {
    min-height: 160px;
}

.codeLine--selected .codeLineContent {
    background: rgba(59, 130, 246, 0.22);
}

.codeLine--selected .codeLineNo {
    background: #1f2937;
    color: #bfdbfe;
}

.codeLineHighlight {
    background: rgba(59, 130, 246, 0.32);
    border-radius: 3px;
    padding: 0 1px;
    color: inherit;
    user-select: text;
}

.codeLineHighlight--full {
    display: inline-block;
    min-width: 100%;
}

.panelHeader {
    font-weight: 700;
    color: #cbd5e1;
    font-size: 14px;
}

.reportViewerContent {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
    overflow: hidden;
    background: #191919;
    border: 1px solid #323232;
    border-radius: 0;
    padding: 16px;
    box-sizing: border-box;
    min-width: 0;
}

.reportViewerHeader {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.reportTabs {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}

.reportTab {
    border: 1px solid rgba(148, 163, 184, 0.4);
    border-radius: 0;
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
    background: #1b1b1b;
    border: 1px solid #2f2f2f;
    color: #d1d5db;
    font-family: Consolas, "Courier New", monospace;
    font-size: 13px;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
    overflow: auto;
}

.reportErrorPanel {
    margin: 0;
    padding: 16px;
    border-radius: 6px;
    border: 1px solid rgba(248, 113, 113, 0.3);
    background: rgba(248, 113, 113, 0.08);
    color: #fda4af;
}

.reportErrorText {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
}

.reportErrorHint {
    margin: 8px 0 0;
    font-size: 12px;
    color: #fecaca;
}

.reportChunks {
    margin-top: 16px;
    border-radius: 6px;
    border: 1px solid #2f2f2f;
    background: #111827;
    padding: 12px 16px;
    color: #e2e8f0;
}

.reportChunks > summary {
    cursor: pointer;
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 8px;
}

.reportChunkList {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.reportChunkTitle {
    margin: 0 0 6px;
    font-size: 12px;
    color: #94a3b8;
}

.reportChunkBody {
    margin: 0;
    padding: 12px;
    border-radius: 4px;
    border: 1px solid #2f2f2f;
    background: #1b1b1b;
    color: #d1d5db;
    font-family: Consolas, "Courier New", monospace;
    font-size: 12px;
    line-height: 1.45;
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

.pvBox.codeBox {
    padding: 0;
    overflow: hidden;
}

.codeScroll {
    flex: 1 1 auto;
    overflow: auto;
    font-family: Consolas, "Courier New", monospace;
    font-size: 13px;
    line-height: 1.45;
    color: #d1d5db;
    background: #1b1b1b;
    cursor: text;
    user-select: text;
}

.codeEditor {
    min-width: max-content;
    display: inline-block;
    outline: none;
    user-select: text;
    caret-color: transparent;
}

.codeEditor:focus {
    outline: none;
}

.codeEditor::selection,
.codeEditor *::selection {
    background: rgba(56, 189, 248, 0.35);
    color: #f8fafc;
}

.codeLine {
    display: flex;
    min-width: max-content;
    user-select: text;
}

.codeLineNo {
    flex: 0 0 auto;
    width: 48px;
    padding: 0 12px;
    text-align: right;
    color: #6b7280;
    background: #141414;
    border-right: 1px solid #2f2f2f;
    user-select: none;
    font-variant-numeric: tabular-nums;
}

.codeLineContent {
    flex: 1 1 auto;
    padding: 0 12px;
    white-space: pre;
    min-width: max-content;
    user-select: text;
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






































































