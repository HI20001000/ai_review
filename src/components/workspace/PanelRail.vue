<script setup>
import { computed, toRefs } from "vue";
import ChatAiWindow from "../ChatAiWindow.vue";
import TreeNode from "./TreeNode.vue";

const props = defineProps({
    activeTool: {
        type: String,
        required: true
    },
    styleWidth: {
        type: Object,
        required: true
    },
    projects: {
        type: Array,
        default: () => []
    },
    selectedProjectId: {
        type: [String, Number],
        default: null
    },
    onSelectProject: {
        type: Function,
        required: true
    },
    onDeleteProject: {
        type: Function,
        required: true
    },
    tree: {
        type: Array,
        default: () => []
    },
    activeTreePath: {
        type: String,
        default: ""
    },
    isLoadingTree: {
        type: Boolean,
        default: false
    },
    openNode: {
        type: Function,
        required: true
    },
    selectTreeNode: {
        type: Function,
        required: true
    },
    contextItems: {
        type: Array,
        default: () => []
    },
    messages: {
        type: Array,
        default: () => []
    },
    isProcessing: {
        type: Boolean,
        default: false
    },
    isChatLocked: {
        type: Boolean,
        default: false
    },
    connection: {
        type: Object,
        default: null
    },
    onAddActiveContext: {
        type: Function,
        required: true
    },
    onRemoveContext: {
        type: Function,
        required: true
    },
    onClearContext: {
        type: Function,
        required: true
    },
    onSendMessage: {
        type: Function,
        required: true
    },
    showProjectOverview: {
        type: Boolean,
        default: true
    }
});

const { activeTool, showProjectOverview } = toRefs(props);

const isProjectTab = computed(() => activeTool.value === "project");
const isAiTab = computed(() => activeTool.value === "ai");
const hasProjects = computed(() => (props.projects || []).length > 0);
const hasSelectedProject = computed(() => props.selectedProjectId !== null && props.selectedProjectId !== undefined);
const shouldShowTree = computed(
    () =>
        !showProjectOverview.value &&
        hasSelectedProject.value &&
        (props.isLoadingTree || (Array.isArray(props.tree) && props.tree.length > 0))
);
</script>

<template>
    <section class="panelRail" :style="styleWidth">
        <template v-if="isProjectTab">
            <div class="projectPanel">
                <div class="panelHeader">Projects</div>
                <template v-if="hasProjects">
                    <ul class="projectList">
                        <li
                            v-for="p in projects"
                            :key="p.id"
                            :class="['projectItem', { active: p.id === selectedProjectId }]"
                        >
                            <div class="projectHeader" @click="onSelectProject(p)">
                                <span class="projName">{{ p.name }}</span>
                                <span class="rightSide">
                                    <span class="badge" :title="p.mode">{{ p.mode }}</span>
                                    <button
                                        class="delBtn"
                                        title="Delete project (DB only)"
                                        @click.stop="onDeleteProject($event, p)"
                                    >
                                        ❌
                                    </button>
                                </span>
                            </div>
                        </li>
                    </ul>
                </template>
                <p v-else class="emptyProjects">尚未匯入任何專案。</p>
            </div>

            <div v-if="shouldShowTree" class="treeArea">
                <div class="panelHeader">Project Files</div>
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

            <div v-else-if="hasSelectedProject && !showProjectOverview" class="treePlaceholder">
                <div class="panelHeader">Project Files</div>
                <p class="emptyTree">載入專案中...</p>
            </div>
        </template>
        <div v-else-if="isAiTab" class="aiArea">
            <ChatAiWindow
                :visible="true"
                :context-items="contextItems"
                :messages="messages"
                :loading="isProcessing"
                :disabled="isChatLocked"
                :connection="connection"
                @add-active="onAddActiveContext"
                @clear-context="onClearContext"
                @remove-context="onRemoveContext"
                @send-message="onSendMessage"
            />
        </div>
    </section>
</template>

<style scoped>
.panelRail {
    flex: 0 0 320px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-height: 0;
    background: #202020;
    border: 1px solid #323232;
    border-radius: 10px;
    padding: 16px;
    box-sizing: border-box;
    overflow: hidden;
}

.panelHeader {
    font-weight: 700;
    color: #cbd5e1;
    margin-bottom: 12px;
}

.projectPanel {
    flex: 0 0 auto;
    background: #252526;
    border: 1px solid #3d3d3d;
    border-radius: 10px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.projectList {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-height: 220px;
    overflow: auto;
}

.projectItem {
    background: #202020;
    border: 1px solid #303134;
    border-radius: 10px;
    padding: 10px 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    transition: border-color 0.2s ease, background-color 0.2s ease;
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
    width: 100%;
    color: #e5e7eb;
    cursor: pointer;
}

.projName {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.rightSide {
    display: inline-flex;
    align-items: center;
    gap: 6px;
}

.badge {
    font-size: 12px;
    opacity: 0.6;
}

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

.emptyProjects {
    margin: 0;
    font-size: 14px;
    color: rgba(255, 255, 255, 0.7);
}

.treeArea,
.treePlaceholder {
    flex: 1 1 auto;
    min-width: 0;
    background: #252526;
    border: 1px solid #3d3d3d;
    border-radius: 10px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    min-height: 0;
}

.treeArea .panelHeader,
.treePlaceholder .panelHeader {
    margin-bottom: 12px;
}

.treeArea .loading {
    padding: 10px;
    opacity: 0.8;
}

.emptyTree {
    margin: 0;
    color: rgba(255, 255, 255, 0.7);
}

.treeArea .treeRoot {
    list-style: none;
    margin: 0;
    padding: 0 8px 8px 0;
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

:deep(.treeChildren) {
    list-style: none;
    margin: 0;
    padding-left: 16px;
}

:deep(.treeRow) {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 2px 0;
    cursor: pointer;
}

:deep(.treeRow.active) {
    background: rgba(255, 255, 255, 0.08);
    border-radius: 6px;
}

:deep(.treeRow .icon) {
    width: 20px;
    text-align: center;
}

@media (max-width: 900px) {
    .panelRail {
        width: 100% !important;
        flex: 1 1 auto !important;
    }
}
</style>
