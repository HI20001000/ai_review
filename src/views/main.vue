<script setup>
import { ref, watch, onMounted, computed } from "vue";
import PanelRail from "../components/workspace/PanelRail.vue";
import { usePreview } from "../scripts/composables/usePreview.js";
import { useTreeStore } from "../scripts/composables/useTreeStore.js";
import { useProjectsStore } from "../scripts/composables/useProjectsStore.js";
import { useAiAssistant } from "../scripts/composables/useAiAssistant.js";
import * as fileSystemService from "../scripts/services/fileSystemService.js";

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
    open,
    close,
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

const activeTool = ref("project");
const showProjectOverview = ref(true);
const middlePaneWidth = ref(360);
const mainContentRef = ref(null);
const hasActiveProject = computed(() => selectedProjectId.value !== null && selectedProjectId.value !== undefined);

const middlePaneStyle = computed(() => ({
    flex: `0 0 ${middlePaneWidth.value}px`,
    width: `${middlePaneWidth.value}px`
}));

watch(activeTool, (tool) => {
    if (tool === "ai") {
        open();
        const shouldForce = connection.value.status === "error";
        retryHandshake({ force: shouldForce });
    } else {
        close();
    }
});

watch(selectedProjectId, (projectId) => {
    if (projectId !== null && projectId !== undefined && activeTool.value === "project") {
        showProjectOverview.value = false;
    }
});

function selectTool(tool) {
    if (activeTool.value !== tool) {
        activeTool.value = tool;
    }
}

function handleToolButton(tool) {
    if (tool === "project") {
        showProjectOverview.value = true;
    }
    selectTool(tool);
}

function handleSelectProject(project) {
    if (!project) return;
    selectTool("project");
    showProjectOverview.value = false;
    openProject(project);
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
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
        selectTool("ai");
    }
}

async function handleSendMessage(content) {
    const text = (content || "").trim();
    if (!text) return;
    selectTool("ai");
    await sendUserMessage(text);
}

onMounted(async () => {
    await cleanupLegacyHandles();
    updateCapabilityFlags();
    await loadProjectsFromDB();
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
            <aside class="toolColumn">
                <div class="toolColumn__section toolColumn__switcher">
                    <div class="toolColumn__header">工具</div>
                    <div class="toolColumn__buttons">
                        <button
                            type="button"
                            class="toolColumn__btn"
                            :class="{ active: activeTool === 'project' }"
                            @click="handleToolButton('project')"
                            aria-label="Projects"
                        >
                            <span class="toolColumn__emoji" aria-hidden="true">📂</span>
                            <span class="srOnly">Projects</span>
                        </button>
                        <button
                            type="button"
                            class="toolColumn__btn"
                            :class="{ active: activeTool === 'ai', disabled: isChatLocked && activeTool !== 'ai' }"
                            @click="handleToolButton('ai')"
                            :disabled="isChatLocked && activeTool !== 'ai'"
                            aria-label="Chat AI"
                        >
                            <span class="toolColumn__emoji" aria-hidden="true">🤖</span>
                            <span class="srOnly">Chat AI</span>
                        </button>
                    </div>
                </div>

            </aside>

            <PanelRail
                class="contentColumn"
                :style-width="middlePaneStyle"
                :active-tool="activeTool"
                :show-project-overview="showProjectOverview"
                :projects="projects"
                :selected-project-id="selectedProjectId"
                :on-select-project="handleSelectProject"
                :on-delete-project="deleteProject"
                :tree="tree"
                :active-tree-path="activeTreePath"
                :is-loading-tree="isLoadingTree"
                :open-node="openNode"
                :select-tree-node="selectTreeNode"
                :context-items="contextItems"
                :messages="messages"
                :is-processing="isProcessing"
                :is-chat-locked="isChatLocked"
                :connection="connection"
                :on-add-active-context="handleAddActiveContext"
                :on-remove-context="removeContext"
                :on-clear-context="clearContext"
                :on-send-message="handleSendMessage"
            />

            <div class="paneDivider" @pointerdown="startPreviewResize"></div>

            <section class="workSpace">
                <template v-if="hasActiveProject && previewing.kind && previewing.kind !== 'error'">
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

                <template v-else-if="hasActiveProject && previewing.kind === 'error'">
                    <div class="pvError">
                        Cannot preview: {{ previewing.error }}
                    </div>
                </template>

                <template v-else-if="hasActiveProject">
                    <div class="pvPlaceholder">Select a file to see its preview here.</div>
                </template>

                <template v-else>
                    <div class="pvPlaceholder">選擇一個專案以啟用預覽區域。</div>
                </template>
            </section>
        </div>

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
    gap: 16px;
    flex: 1 1 auto;
    min-height: 0;
    background-color: #1e1e1e;
    padding: 16px;
    overflow: hidden;
}

.toolColumn {
    flex: 0 0 280px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    height: 100%;
    background: #202020;
    border: 1px solid #323232;
    border-radius: 10px;
    padding: 16px;
    box-sizing: border-box;
}

.toolColumn__section {
    background: #252526;
    border: 1px solid #3d3d3d;
    border-radius: 10px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
}

.toolColumn__header {
    font-weight: 700;
    color: #cbd5e1;
}

.toolColumn__switcher {
    flex: 0 0 auto;
}

.toolColumn__buttons {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.toolColumn__btn {
    border: none;
    border-radius: 10px;
    padding: 12px;
    background: #2a2a2a;
    color: #cbd5e1;
    cursor: pointer;
    transition: background .2s ease, color .2s ease, transform .2s ease;
    display: flex;
    align-items: center;
    justify-content: center;
}

.toolColumn__btn:hover:not(.disabled):not(:disabled) {
    background: #334155;
    color: #f8fafc;
    transform: translateY(-1px);
}

.toolColumn__btn.active {
    background: linear-gradient(135deg, rgba(59, 130, 246, .35), rgba(14, 165, 233, .35));
    color: #e0f2fe;
}

.toolColumn__btn.disabled,
.toolColumn__btn:disabled {
    opacity: .6;
    cursor: not-allowed;
}

.toolColumn__emoji {
    font-size: 24px;
    line-height: 1;
}

.srOnly {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
}

.contentColumn {
    flex: 0 0 360px;
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
    background: #202020;
    border: 1px solid #323232;
    border-radius: 10px;
    padding: 16px;
    box-sizing: border-box;
    overflow: hidden;
}

.mainContent > * {
    min-height: 0;
}

.paneDivider {
    flex: 0 0 6px;
    cursor: col-resize;
    background: linear-gradient(180deg, rgba(59, 130, 246, .25), rgba(14, 165, 233, 0));
    border-radius: 8px;
    transition: background .2s ease;
}

.paneDivider:hover {
    background: linear-gradient(180deg, rgba(59, 130, 246, .45), rgba(14, 165, 233, .15));
}

@media (max-width: 900px) {
    .mainContent {
        flex-direction: column;
    }
    .toolColumn,
    .contentColumn,
    .workSpace {
        width: 100%;
        flex: 1 1 auto;
    }
}
.loading {
    padding: 10px;
    opacity: .8;
}

.workSpace {
    flex: 1 1 320px;
    min-width: 0;
    min-height: 0;
    background: #252526;
    border-radius: 8px;
    border: 1px solid #323232;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    overflow: auto;
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






































































