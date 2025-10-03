<script setup>
import { toRefs } from "vue";

const props = defineProps({
    activeTool: {
        type: String,
        required: true
    },
    isChatLocked: {
        type: Boolean,
        default: false
    }
});

const emit = defineEmits(["select"]);

const { activeTool, isChatLocked } = toRefs(props);

function handleSelect(tool) {
    if (activeTool.value !== tool) {
        emit("select", tool);
    }
}
</script>

<template>
    <aside class="toolRail">
        <button
            type="button"
            class="toolRail__btn"
            :class="{ active: activeTool === 'project' }"
            @click="handleSelect('project')"
        >
            Projects
        </button>
        <button
            type="button"
            class="toolRail__btn"
            :class="{ active: activeTool === 'ai', disabled: isChatLocked && activeTool !== 'ai' }"
            @click="handleSelect('ai')"
            :disabled="isChatLocked && activeTool !== 'ai'"
        >
            Chat AI
        </button>
    </aside>
</template>

<style scoped>
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
    transition: background 0.2s ease, color 0.2s ease, transform 0.2s ease;
    text-align: left;
    width: 100%;
}

.toolRail__btn:hover:not(.disabled):not(:disabled) {
    background: #334155;
    color: #f8fafc;
    transform: translateY(-1px);
}

.toolRail__btn.active {
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.3), rgba(14, 165, 233, 0.3));
    color: #e0f2fe;
}

.toolRail__btn.disabled,
.toolRail__btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
}

@media (max-width: 900px) {
    .toolRail {
        flex-direction: row;
        flex-wrap: wrap;
        gap: 8px;
        width: 100%;
        flex: 0 0 auto;
        overflow-x: auto;
    }

    .toolRail__btn {
        flex: 1 1 140px;
    }
}
</style>
