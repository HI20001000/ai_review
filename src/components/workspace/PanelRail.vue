<script setup>
import { computed, ref, useSlots } from "vue";
import TreeNode from "./TreeNode.vue";

const props = defineProps({
    styleWidth: {
        type: Object,
        required: true
    },
    mode: {
        type: String,
        default: "projects"
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
    isTreeCollapsed: {
        type: Boolean,
        default: false
    },
    showContent: {
        type: Boolean,
        default: true
    }
});

const emit = defineEmits(["resizeStart"]);

const slots = useSlots();

const isProjectsMode = computed(() => props.mode === "projects");
const hasCustomContent = computed(() => !!slots.default);

const hasProjects = computed(() => (props.projects || []).length > 0);
const hasSelectedProject = computed(
    () => props.selectedProjectId !== null && props.selectedProjectId !== undefined
);
const hasTreeNodes = computed(() => Array.isArray(props.tree) && props.tree.length > 0);
const shouldShowTreeList = computed(
    () =>
        isProjectsMode.value &&
        hasSelectedProject.value &&
        !props.isTreeCollapsed &&
        hasTreeNodes.value &&
        !props.isLoadingTree
);
const shouldShowTreeLoading = computed(
    () =>
        isProjectsMode.value &&
        hasSelectedProject.value &&
        !props.isTreeCollapsed &&
        props.isLoadingTree
);
const shouldShowEmptyTree = computed(
    () =>
        isProjectsMode.value &&
        hasSelectedProject.value &&
        !props.isTreeCollapsed &&
        !props.isLoadingTree &&
        !hasTreeNodes.value
);

const isHoveringResizeEdge = ref(false);

const EDGE_THRESHOLD = 8;

function updateResizeHoverState(event) {
    const panel = event.currentTarget;
    if (!panel) return false;
    const rect = panel.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const hovering = rect.width - offsetX <= EDGE_THRESHOLD;
    if (isHoveringResizeEdge.value !== hovering) {
        isHoveringResizeEdge.value = hovering;
    }
    return hovering;
}

function handlePointerMove(event) {
    updateResizeHoverState(event);
}

function handlePointerLeave() {
    isHoveringResizeEdge.value = false;
}

function handlePointerDown(event) {
    const hovering = updateResizeHoverState(event);
    if (!hovering) return;
    emit("resizeStart", event);
}
</script>

<template>
    <section
        class="panelRail"
        :class="{ 'panelRail--resizeEdge': isHoveringResizeEdge }"
        :style="styleWidth"
        @pointermove="handlePointerMove"
        @pointerleave="handlePointerLeave"
        @pointerdown="handlePointerDown"
    >
        <template v-if="showContent">
            <template v-if="!isProjectsMode && hasCustomContent">
                <slot />
            </template>
            <template v-else>
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

                <div
                    v-if="hasSelectedProject"
                    class="treeArea"
                    :class="{ collapsed: isTreeCollapsed }"
                >
                    <div class="panelHeader">Project Files</div>
                    <div v-if="isTreeCollapsed" class="collapsedNotice">檔案樹已折疊，點擊專案可再次展開。</div>
                    <div v-else-if="shouldShowTreeLoading" class="loading">Loading...</div>
                    <ul v-else-if="shouldShowTreeList" class="treeRoot">
                        <TreeNode
                            v-for="n in tree"
                            :key="n.path"
                            :node="n"
                            :active-path="activeTreePath"
                            @open="openNode"
                            @select="selectTreeNode"
                        />
                    </ul>
                    <p v-else-if="shouldShowEmptyTree" class="emptyTree">尚未載入任何檔案。</p>
                </div>

                <div v-else class="treePlaceholder">
                    <div class="panelHeader">Project Files</div>
                    <p class="emptyTree">請先選擇左側的專案以載入檔案。</p>
                </div>
            </template>
        </template>

        <div v-else class="panelEmpty">
            <div class="panelHeader">工具列</div>
            <p class="emptyTree">選擇左側的工具以顯示內容。</p>
        </div>
    </section>
</template>

<style scoped>
.panelRail {
    flex: 0 0 320px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 16px;
    min-height: 0;
    height: 100%;
    background: var(--panel-surface-alt);
    border: 1px solid var(--panel-border);
    border-radius: 12px;
    box-sizing: border-box;
    overflow: hidden;
    position: relative;
    box-shadow: 0 20px 35px rgba(15, 23, 42, 0.25);
}

.panelRail--resizeEdge {
    cursor: col-resize;
}

.panelHeader {
    font-weight: 700;
    color: var(--panel-heading);
    margin-bottom: 12px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-size: 12px;
}

.projectPanel {
    flex: 0 0 auto;
    background: var(--panel-surface);
    border: 1px solid var(--panel-border);
    border-radius: 12px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.02);
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
    scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-track);
}

.projectItem {
    background: var(--panel-surface-alt);
    border: 1px solid var(--panel-border);
    border-radius: 10px;
    padding: 10px 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    transition: border-color 0.2s ease, background-color 0.2s ease, transform 0.2s ease;
}

.projectItem:hover {
    border-color: var(--panel-border-strong);
    transform: translateY(-1px);
}

.projectItem.active {
    border-color: var(--panel-border-strong);
    background: rgba(148, 163, 184, 0.18);
}

.projectHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    color: var(--tree-text);
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
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--panel-muted);
}

.delBtn {
    background: rgba(239, 68, 68, 0.12);
    border: 1px solid rgba(239, 68, 68, 0.3);
    color: #fca5a5;
    font-size: 12px;
    line-height: 1;
    padding: 4px 6px;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.2s ease, border-color 0.2s ease;
}

.delBtn:hover {
    background: rgba(239, 68, 68, 0.2);
    border-color: rgba(239, 68, 68, 0.45);
}

.emptyProjects {
    margin: 0;
    font-size: 13px;
    color: var(--panel-muted);
}

.treeArea,
.treePlaceholder {
    flex: 1 1 auto;
    min-width: 0;
    background: var(--panel-surface);
    border: 1px solid var(--panel-border);
    border-radius: 12px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    min-height: 0;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.015);
}

.panelEmpty {
    flex: 1 1 auto;
    min-width: 0;
    background: var(--panel-surface);
    border: 1px solid var(--panel-border);
    border-radius: 12px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 8px;
    text-align: center;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.015);
}

.treeArea.collapsed {
    justify-content: flex-start;
}

.treeArea .panelHeader,
.treePlaceholder .panelHeader {
    margin-bottom: 12px;
}

.treeArea .loading {
    padding: 10px;
    opacity: 0.8;
    color: var(--panel-muted);
}

.emptyTree {
    margin: 0;
    color: var(--panel-muted);
}

.collapsedNotice {
    margin: 0;
    color: var(--panel-muted);
    line-height: 1.4;
}

.treeArea .treeRoot {
    list-style: none;
    margin: 0;
    padding: 0 8px 8px 0;
    overflow: auto;
    scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-track);
}

.treeArea .treeRoot::-webkit-scrollbar,
.projectList::-webkit-scrollbar {
    width: 8px;
}

.treeArea .treeRoot::-webkit-scrollbar-track,
.projectList::-webkit-scrollbar-track {
    background: var(--scrollbar-track);
}

.treeArea .treeRoot::-webkit-scrollbar-thumb,
.projectList::-webkit-scrollbar-thumb {
    background: var(--scrollbar-thumb);
    border-radius: 999px;
}

.treeArea .treeRoot::-webkit-scrollbar-thumb:hover,
.projectList::-webkit-scrollbar-thumb:hover {
    background: rgba(148, 163, 184, 0.65);
}

@media (max-width: 900px) {
    .panelRail {
        width: 100% !important;
        flex: 1 1 auto !important;
    }
}
</style>
