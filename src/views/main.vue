<script setup>
import { ref, watch, onMounted, computed } from "vue";
import ChatAiWindow from "../components/ChatAiWindow.vue";
import TreeNode from "../scripts/components/TreeNode.js";
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
const middlePaneWidth = ref(360);
const mainContentRef = ref(null);

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

function selectTool(tool) {
    if (activeTool.value !== tool) {
        activeTool.value = tool;
    }
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function startPreviewResize(event) {
    if (event.button !== 0) return;
    event.preventDefault();

    const startX = event.clientX;
    const startWidth = middlePaneWidth.value;
    const containerWidth = mainContentRef.value?.getBoundingClientRect().width || window.innerWidth;
    const minWidth = 260;
    const maxWidth = Math.max(minWidth, containerWidth - 320);

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
        activeTool.value = "ai";
    }
}

async function handleSendMessage(content) {
    const text = (content || "").trim();
    if (!text) return;
    activeTool.value = "ai";
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

        <div class="mainContent">
            <div class="projectPanel">
                <div class="wsHeader">Projects</div>
                <ul class="projectList">
                    <li
                        v-for="p in projects"
                        :key="p.id"
                        :class="['projectItem', { active: p.id === selectedProjectId }]"
                    >
                        <div class="projectHeader" @click="openProject(p)">
                            <span class="projName">{{ p.name }}</span>
                            <span class="rightSide">
                                <span class="badge" :title="p.mode">{{ p.mode }}</span>
                                <button class="delBtn" title="Delete project (DB only)" @click.stop="deleteProject($event, p)">❌</button>
                            </span>
                        </div>

                        <div v-if="p.id === selectedProjectId" class="projectBody">
                            <div class="workspaceShell" ref="mainContentRef">
                                <aside class="toolRail">
                                    <button
                                        type="button"
                                        class="toolRail__btn"
                                        :class="{ active: activeTool === 'project' }"
                                        @click="selectTool('project')"
                                    >
                                        Projects
                                    </button>
                                    <button
                                        type="button"
                                        class="toolRail__btn"
                                        :class="{ active: activeTool === 'ai', disabled: isChatLocked && activeTool !== 'ai' }"
                                        @click="selectTool('ai')"
                                        :disabled="isChatLocked && activeTool !== 'ai'"
                                    >
                                        Chat AI
                                    </button>
                                </aside>

                                <section class="panelRail" :style="middlePaneStyle">
                                    <div v-if="activeTool === 'project'" class="treeArea">
                                        <div v-if="isLoadingTree" class="loading">Loading...</div>
                                        <ul v-else class="treeRoot">
                                            <TreeNode
                                                v-for="n in tree"
                                                :key="n.path"
                                                :node="n"
                                                :active-path="activeTreePath"
                                                @open="openNode"
                                                @select="selectTreeNode"
                                            />
                                        </ul>
                                    </div>
                                    <div v-else class="aiArea">
                                        <ChatAiWindow
                                            :visible="activeTool === 'ai'"
                                            :context-items="contextItems"
                                            :messages="messages"
                                            :loading="isProcessing"
                                            :disabled="isChatLocked"
                                            :connection="connection"
                                            @add-active="handleAddActiveContext"
                                            @clear-context="clearContext"
                                            @remove-context="removeContext"
                                            @send-message="handleSendMessage"
                                        />
                                    </div>
                                </section>

                                <div class="paneDivider" @pointerdown="startPreviewResize"></div>

                                <section class="workSpace">
                                    <template v-if="previewing.kind && previewing.kind !== 'error'">
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

                                    <div v-else-if="previewing.kind === 'error'" class="pvError">
                                        Cannot preview: {{ previewing.error }}
                                    </div>

                                    <div v-else class="pvPlaceholder">Select a file to see its preview here.</div>
                                </section>
                            </div>
                        </div>
                    </li>
                </ul>
            </div>
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

.topBar_actions {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 12px;
}

.topBar_aiButton {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border-radius: 8px;
    border: 1px solid transparent;
    background: #1f1f1f;
    color: #94a3b8;
    cursor: pointer;
    transition: background 0.2s ease, color 0.2s ease, border-color 0.2s ease;
}

.topBar_aiButton:hover {
    color: #f8fafc;
    border-color: #3b82f6;
}

.topBar_aiButton:focus-visible {
    outline: 2px solid #3b82f6;
    outline-offset: 2px;
}

.topBar_aiButton.active {
    background: rgba(59, 130, 246, 0.15);
    color: #bfdbfe;
    border-color: #3b82f6;
}
.topBar_aiButton.loading {
    border-color: #facc15;
    color: #fde68a;
}

.topBar_aiButton.loading svg {
    animation: chat-spin 0.9s linear infinite;
}



.topBar_aiButton svg {
    width: 20px;
    height: 20px;
}

@keyframes chat-spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
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
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    background-color: #1e1e1e;
    padding: 16px;
    overflow: hidden;
}

.projectPanel {
    flex: 1 1 auto;
    background-color: #252526;
    border: 1px solid #3d3d3d;
    border-radius: 10px;
    padding: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
}

/* project panel */
.wsHeader {
    padding: 10px 12px;
    font-weight: 700;
    color: #cbd5e1;
    border-bottom: 1px solid #3d3d3d;
}

.projectList {
    list-style: none;
    margin: 0;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    overflow: auto;
    min-height: 0;
    flex: 1 1 auto;
}

.projectItem {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px;
    border-radius: 12px;
    border: 1px solid #303134;
    background: #202020;
    transition: border-color .2s ease, background-color .2s ease;
}

.projectItem.active {
    border-color: #2b4b63;
    background: #1f2d3c;
}

.projectHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    cursor: pointer;
    color: #e5e7eb;
    padding: 4px 0;
    border-radius: 8px;
    transition: background .2s ease;
}

.projectItem:not(.active) .projectHeader:hover {
    background: rgba(255, 255, 255, 0.05);
}

.projectBody {
    padding: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
}

.workspaceShell {
    display: flex;
    gap: 16px;
    min-height: 0;
    flex: 1 1 auto;
    padding: 16px;
    box-sizing: border-box;
    height: 100%;
}

.toolRail {
    flex: 0 0 72px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px;
    background: #202020;
    border: 1px solid #323232;
    border-radius: 10px;
    overflow: auto;
}

.toolRail__btn {
    border: none;
    border-radius: 8px;
    padding: 10px 12px;
    background: #2a2a2a;
    color: #cbd5e1;
    font-weight: 600;
    cursor: pointer;
    transition: background .2s ease, color .2s ease, transform .2s ease;
    text-align: left;
    width: 100%;
}

.toolRail__btn:hover:not(.disabled):not(:disabled) {
    background: #334155;
    color: #f8fafc;
    transform: translateY(-1px);
}

.toolRail__btn.active {
    background: linear-gradient(135deg, rgba(59, 130, 246, .3), rgba(14, 165, 233, .3));
    color: #e0f2fe;
}

.toolRail__btn.disabled,
.toolRail__btn:disabled {
    opacity: .6;
    cursor: not-allowed;
}

.panelRail {
    flex: 0 0 320px;
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
    background: #202020;
    border: 1px solid #323232;
    border-radius: 10px;
    padding: 12px;
    box-sizing: border-box;
    overflow: hidden;
}

.treeArea {
    flex: 1 1 auto;
    min-width: 0;
    padding-right: 8px;
    overflow: auto;
}

.aiArea {
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
}

.aiArea :deep(.chatWindow) {
    height: 100%;
}

.paneDivider {
    flex: 0 0 6px;
    cursor: col-resize;
    background: linear-gradient(180deg, rgba(59, 130, 246, .25), rgba(14, 165, 233, 0));
    border-radius: 8px;
    align-self: stretch;
}

.paneDivider:hover {
    background: linear-gradient(180deg, rgba(59, 130, 246, .45), rgba(14, 165, 233, .15));
}

@media (max-width: 900px) {
    .workspaceShell {
        flex-direction: column;
        height: auto;
    }
    .toolRail,
    .panelRail,
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

.treeChildren {
    list-style: none;
    margin: 0;
    padding-left: 16px;
}

.treeRow {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 2px 0;
    cursor: pointer;
}
.treeRow.active {
    background: rgba(255, 255, 255, 0.08);
    border-radius: 6px;
}

.treeRow .icon {
    width: 20px;
    text-align: center;
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

.imgBox {
    justify-content: center;
    align-items: center;
    padding: 12px;
}

.imgBox img {
    max-width: 100%;
    height: auto;
    border-radius: 6px;
}

.pdfBox {
    padding: 0;
}

.pdfBox iframe {
    width: 100%;
    height: 100%;
    border: none;
    border-radius: 6px;
}

.pvError {
    color: #f87171;
    font-size: 13px;
}

.pvPlaceholder {
    font-size: 13px;
    color: #94a3b8;
}

.projName {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding-right: 8px;
}

.rightSide {
    display: inline-flex;
    align-items: center;
    gap: 6px;
}

.badge {
    font-size: 12px;
    opacity: .6;
}

/* 刪除按鈕 */
.delBtn {
    background: transparent;
    border: none;
    color: #fca5a5;
    font-size: 14px;
    line-height: 1;
    padding: 4px 6px;
    border-radius: 6px;
    cursor: pointer;
}

.delBtn:hover {
    background: #3a2a2a;
    color: #fecaca;
}

/* Modal */
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






































































