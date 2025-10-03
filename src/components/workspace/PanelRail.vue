<script setup>
import { computed, toRefs } from "vue";
import ChatAiWindow from "../ChatAiWindow.vue";
import TreeNode from "../../scripts/components/TreeNode.js";

const props = defineProps({
    activeTool: {
        type: String,
        required: true
    },
    styleWidth: {
        type: Object,
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
    }
});

const { activeTool } = toRefs(props);

const isProjectTab = computed(() => activeTool.value === "project");
const isAiTab = computed(() => activeTool.value === "ai");
</script>

<template>
    <section class="panelRail" :style="styleWidth">
        <div v-if="isProjectTab" class="treeArea">
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
    min-height: 0;
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

.loading {
    padding: 10px;
    opacity: 0.8;
}

:deep(.treeRoot) {
    list-style: none;
    margin: 0;
    padding: 0 8px 8px 0;
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
