<script setup>
import { computed, toRefs } from "vue";

const props = defineProps({
    projects: {
        type: Array,
        default: () => []
    },
    selectedProjectId: {
        type: [String, Number],
        default: null
    },
    previewing: {
        type: Object,
        required: true
    },
    onOpenProject: {
        type: Function,
        required: true
    },
    onDeleteProject: {
        type: Function,
        required: true
    }
});

const { previewing } = toRefs(props);

const previewMeta = computed(() => {
    if (!previewing.value || !previewing.value.size) return "-";
    return `${(previewing.value.size / 1024).toFixed(1)} KB`;
});
</script>

<template>
    <div class="projectPanel">
        <div class="wsHeader">Projects</div>
        <ul class="projectList">
            <li
                v-for="p in projects"
                :key="p.id"
                :class="['projectItem', { active: p.id === selectedProjectId }]"
            >
                <div class="projectHeader" @click="onOpenProject(p)">
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

                <div v-if="p.id === selectedProjectId" class="projectBody">
                    <section class="workSpace">
                        <template v-if="previewing.kind && previewing.kind !== 'error'">
                            <div class="pvHeader">
                                <div class="pvName">{{ previewing.name }}</div>
                                <div class="pvMeta">{{ previewing.mime || '-' }} | {{ previewMeta }}</div>
                            </div>

                            <div v-if="previewing.kind === 'text'" class="pvBox">
                                <pre class="pvPre">{{ previewing.text }}</pre>
                            </div>

                            <div v-else-if="previewing.kind === 'image'" class="pvBox imgBox">
                                <img :src="previewing.url" :alt="previewing.name" />
                            </div>

                            <div v-else-if="previewing.kind === 'pdf'" class="pvBox pdfBox">
                                <iframe :src="previewing.url" title="PDF Preview"></iframe>
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
            </li>
        </ul>
    </div>
</template>

<style scoped>
.projectPanel {
    flex: 1 1 auto;
    background-color: #252526;
    border: 1px solid #3d3d3d;
    border-radius: 10px;
    padding: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
}

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
    cursor: pointer;
    color: #e5e7eb;
    padding: 4px 0;
    border-radius: 8px;
    transition: background 0.2s ease;
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

.btn {
    padding: 8px 14px;
    border-radius: 8px;
    border: 1px solid #3d3d3d;
    background: #007acc;
    color: #fff;
    cursor: pointer;
    text-align: center;
}

.btn:hover {
    filter: brightness(1.1);
}

.btn.outline {
    background: transparent;
    color: #e5e7eb;
    border-color: #4b5563;
}

@media (max-width: 900px) {
    .workSpace {
        width: 100%;
    }
}
</style>
