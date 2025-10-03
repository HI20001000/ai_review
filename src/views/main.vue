<script setup>
import { ref, watch, onMounted, computed } from "vue";
import ToolRail from "../components/workspace/ToolRail.vue";
import PanelRail from "../components/workspace/PanelRail.vue";
import ProjectPanel from "../components/workspace/ProjectPanel.vue";
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
            <ToolRail :active-tool="activeTool" :is-chat-locked="isChatLocked" @select="selectTool" />

            <PanelRail
                :active-tool="activeTool"
                :style-width="middlePaneStyle"
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

            <ProjectPanel
                :projects="projects"
                :selected-project-id="selectedProjectId"
                :previewing="previewing"
                :on-open-project="openProject"
                :on-delete-project="deleteProject"
            />
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

.mainContent > * {
    min-height: 0;
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
    .mainContent {
        flex-direction: column;
    }

    .paneDivider {
        display: none;
    }
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






































































