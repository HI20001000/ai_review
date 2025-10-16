<template>
    <div
        v-if="visible"
        class="chatFloating"
        :style="[floatingStyle, resizeCursorStyle]"
        role="dialog"
        aria-modal="false"
        aria-label="Chat AI"
        @pointerdown.capture="handleResizePointerDown"
        @pointermove="handleResizePointerMove"
        @pointerleave="clearResizeHover"
        @mousedown.capture="handleResizePointerDown"
        @mousemove="handleResizePointerMove"
    >
        <div
            class="chatFloating__header"
            @pointerdown="emit('drag-start', $event)"
            @mousedown="emit('drag-start', $event)"
        >
            <div class="chatFloating__title">Chat AI</div>
            <div class="chatFloating__actions">
                <button
                    type="button"
                    class="chatFloating__iconBtn"
                    title="Close"
                    @click="emit('close')"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M7 7l10 10m0-10-10 10" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                    </svg>
                </button>
            </div>
        </div>

        <div class="chatFloating__body">
            <div class="chatWindow">
                <section class="chatWindow__context">
                    <div class="chatWindow__contextHeader">
                        <span>Context</span>
                        <div class="chatWindow__contextBtns">
                            <button
                                type="button"
                                class="chatWindow__btn"
                                :disabled="controlsDisabled"
                                @click="emit('add-active')"
                            >
                                Add active file
                            </button>
                            <button
                                type="button"
                                class="chatWindow__btn"
                                :disabled="controlsDisabled"
                                @click="emit('add-selection')"
                            >
                                Add selection
                            </button>
                            <button
                                type="button"
                                class="chatWindow__btn ghost"
                                :disabled="clearDisabled"
                                @click="emit('clear-context')"
                            >
                                Clear
                            </button>
                        </div>
                    </div>
                    <div class="chatWindow__chips">
                        <template v-if="contextItems.length">
                            <span
                                v-for="item in contextItems"
                                :key="item.id"
                                class="chatWindow__chip"
                                :title="chipTitle(item)"
                            >
                                <span class="chatWindow__chipType">{{ formatChipType(item.type) }}</span>
                                <span class="chatWindow__chipLabel">{{ item.label }}</span>
                                <button
                                    type="button"
                                    class="chatWindow__chipRemove"
                                    @click="emit('remove-context', item.id)"
                                >
                                    &times;
                                </button>
                            </span>
                        </template>
                        <p v-else class="chatWindow__chipsPlaceholder">No context yet. Select a file and press "Add active file".</p>
                    </div>
                </section>

                <section ref="messagesRef" class="chatWindow__messages themed-scrollbar">
                    <template v-if="messages.length">
                        <article
                            v-for="msg in messages"
                            :key="msg.id"
                            :class="[
                                'chatWindow__message',
                                'is-' + msg.role,
                                { 'is-pending': msg.status === 'pending', 'is-error': msg.status === 'error', 'is-info': msg.status === 'info' }
                            ]"
                        >
                            <header
                                class="chatWindow__messageMeta"
                                :class="{ 'is-user': msg.role === 'user' }"
                            >
                                <span class="chatWindow__messageAuthor">{{ msg.role === 'assistant' ? 'AI' : 'User' }}</span>
                                <span class="chatWindow__messageTime">{{ formatTime(msg.timestamp) }}</span>
                            </header>
                            <div class="chatWindow__messageBody" v-html="renderMessageContent(msg)"></div>
                        </article>
                    </template>
                    <div v-else class="chatWindow__messagesEmpty">No messages yet. Start typing!</div>
                </section>

                <footer class="chatWindow__footer">
                    <textarea
                        ref="textareaRef"
                        v-model="draft"
                        class="chatWindow__input"
                        :disabled="disabled"
                        placeholder="Type a message, Shift+Enter for newline"
                        @keydown.enter.exact.prevent="send"
                        @keydown.enter.shift.stop
                    ></textarea>
                    <div class="chatWindow__footerActions">
                        <span class="chatWindow__status" :style="statusStyle">{{ statusText }}</span>
                        <button
                            type="button"
                            class="chatWindow__send"
                            :disabled="!draft.trim() || loading || disabled"
                            :aria-busy="loading ? 'true' : 'false'"
                            @click="send"
                        >
                            Send
                        </button>
                    </div>
                </footer>
            </div>
        </div>

    </div>
</template>

<script setup>
import { ref, computed, watch, nextTick } from "vue";

const DEFAULT_STATUS_MESSAGE = "連接中...";

import { renderMarkdown } from "../scripts/utils/renderMarkdown.js";

const props = defineProps({
    visible: { type: Boolean, default: false },
    floatingStyle: { type: Object, default: () => ({}) },
    contextItems: { type: Array, default: () => [] },
    messages: { type: Array, default: () => [] },
    loading: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false },
    connection: { type: Object, default: () => ({ status: "checking", message: "" }) }
});

const emit = defineEmits([
    "remove-context",
    "clear-context",
    "add-active",
    "add-selection",
    "send-message",
    "close",
    "drag-start",
    "resize-start"
]);

const draft = ref("");
const messagesRef = ref(null);
const textareaRef = ref(null);
const resizeCursor = ref("");
const isResizing = ref(false);

const resizeCursorStyle = computed(() => (resizeCursor.value ? { cursor: resizeCursor.value } : {}));

const statusText = computed(() => props.connection?.message || DEFAULT_STATUS_MESSAGE);
const statusStyle = computed(() => {
    const base = { color: "#64748b" };
    const state = props.connection?.status || "checking";
    if (state === "ready") return { ...base, color: "#86efac" };
    if (state === "error") return { ...base, color: "#fca5a5" };
    if (state === "checking") return { ...base, color: "#fde68a" };
    return base;
});
const controlsDisabled = computed(() => props.disabled || props.loading);
const clearDisabled = computed(() => controlsDisabled.value || !(props.contextItems || []).length);

function formatChipType(type) {
    if (type === "dir") return "DIR";
    if (type === "snippet") return "SNIP";
    return "FILE";
}

function chipTitle(item) {
    if (!item) return "";
    if (item.type === "snippet" && item.snippet) {
        const { path, startLine, endLine, startColumn, endColumn, lineCount } = item.snippet;
        const parts = [];
        if (item.label) parts.push(item.label);
        if (path && (!item.label || !item.label.includes(path))) {
            parts.push(path);
        }
        if (Number.isFinite(startLine)) {
            const range = Number.isFinite(endLine) && endLine !== startLine ? `${startLine}-${endLine}` : `${startLine}`;
            parts.push(`行 ${range}`);
        }
        const hasStartColumn = Number.isFinite(startColumn);
        const hasEndColumn = Number.isFinite(endColumn);
        const isSingleLine = Number.isFinite(startLine) && Number.isFinite(endLine) && startLine === endLine;
        if (isSingleLine) {
            if (hasStartColumn && hasEndColumn) {
                parts.push(`字元 ${startColumn === endColumn ? startColumn : `${startColumn}-${endColumn}`}`);
            } else if (hasStartColumn) {
                parts.push(`字元 ${startColumn} 起`);
            } else if (hasEndColumn) {
                parts.push(`字元 ${endColumn} 止`);
            }
        } else {
            if (hasStartColumn) parts.push(`起始字元 ${startColumn}`);
            if (hasEndColumn) parts.push(`結束字元 ${endColumn}`);
        }
        if (Number.isFinite(lineCount) && lineCount > 0) {
            parts.push(`共 ${lineCount} 行`);
        }
        return parts.join(" | ") || item.label || "Snippet";
    }
    return item.path || item.label;
}

watch(
    () => props.messages,
    () => {
        scrollToBottom();
    },
    { deep: true }
);

watch(
    () => props.visible,
    (visible) => {
        if (visible) {
            focusInput();
            scrollToBottom();
        } else {
            isResizing.value = false;
            resizeCursor.value = "";
        }
    },
    { immediate: true }
);

function scrollToBottom() {
    nextTick(() => {
        const el = messagesRef.value;
        if (el) {
            el.scrollTop = el.scrollHeight;
        }
    });
}

function focusInput() {
    nextTick(() => {
        textareaRef.value?.focus();
    });
}

function handleResizePointerDown(event) {
    if (event.button !== 0) return;
    const hit = detectResizeEdges(event);
    if (!hit) return;

    const isHeaderTarget = event.target?.closest?.(".chatFloating__header");
    if (isHeaderTarget && hit.edges.top && !hit.edges.left && !hit.edges.right) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    const cursor = getCursorForEdges(hit.edges);
    if (cursor) {
        resizeCursor.value = cursor;
    }

    isResizing.value = true;
    const stop = () => {
        isResizing.value = false;
        clearResizeHover();
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);

    emit("resize-start", { originalEvent: event, edges: hit.edges });
}

function handleResizePointerMove(event) {
    if (isResizing.value) return;
    const hit = detectResizeEdges(event);
    if (!hit) {
        clearResizeHover();
        return;
    }

    const cursor = getCursorForEdges(hit.edges);
    if (cursor) {
        resizeCursor.value = cursor;
    } else {
        clearResizeHover();
    }
}

function clearResizeHover() {
    if (isResizing.value) return;
    resizeCursor.value = "";
}

function detectResizeEdges(event) {
    const el = event.currentTarget;
    if (!(el instanceof HTMLElement)) return null;
    const rect = el.getBoundingClientRect();
    const threshold = 12;
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    const edges = {
        left: x <= threshold,
        right: rect.width - x <= threshold,
        top: y <= threshold,
        bottom: rect.height - y <= threshold
    };

    if (!edges.left && !edges.right && !edges.top && !edges.bottom) {
        return null;
    }

    return { edges };
}

function getCursorForEdges(edges) {
    if ((edges.left && edges.top) || (edges.right && edges.bottom)) {
        return "nwse-resize";
    }
    if ((edges.right && edges.top) || (edges.left && edges.bottom)) {
        return "nesw-resize";
    }
    if (edges.left || edges.right) {
        return "ew-resize";
    }
    if (edges.top || edges.bottom) {
        return "ns-resize";
    }
    return "";
}

function send() {
    if (controlsDisabled.value) return;
    const value = draft.value.trim();
    if (!value) return;
    emit("send-message", value);
    draft.value = "";
    scrollToBottom();
}

function formatTime(value) {
    if (!value) return "";
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleTimeString();
}

function renderMessageContent(msg) {
    if (!msg) return "";
    const content = msg.content ?? "";
    return renderMarkdown(content);
}
</script>

<style scoped>
.chatFloating {
    position: fixed;
    z-index: 40;
    background: #1f1f1f;
    border: 1px solid #2f2f2f;
    border-radius: 14px;
    box-shadow: 0 18px 40px rgba(0, 0, 0, 0.45);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-width: 320px;
    min-height: 320px;
}

.chatFloating__header {
    padding: 10px 12px;
    background: #262626;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    cursor: grab;
    user-select: none;
}

.chatFloating__header:active {
    cursor: grabbing;
}

.chatFloating__title {
    font-weight: 600;
    color: #e2e8f0;
    letter-spacing: 0.01em;
}

.chatFloating__actions {
    display: flex;
    align-items: center;
    gap: 8px;
}

.chatFloating__iconBtn {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    border: 1px solid #2f2f2f;
    background: #1f2937;
    color: #94a3b8;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background 0.2s ease, color 0.2s ease;
    padding: 0;
}

.chatFloating__iconBtn svg {
    width: 18px;
    height: 18px;
    pointer-events: none;
}

.chatFloating__iconBtn:hover:not(:disabled) {
    background: #2f3746;
    color: #f8fafc;
}

.chatFloating__iconBtn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.chatFloating__body {
    flex: 1 1 auto;
    min-height: 0;
}

.chatFloating__body .chatWindow {
    height: 100%;
    border-radius: 0;
}

.chatWindow {
    display: flex;
    flex-direction: column;
    background: #1f1f1f;
    border: 1px solid #2f2f2f;
    border-radius: 12px;
    color: #e2e8f0;
    height: 100%;
    min-height: 0;
    overflow: hidden;
}

.chatWindow__context {
    padding: 12px 14px 6px;
    border-bottom: 1px solid #2f2f2f;
    background: #262626;
}

.chatWindow__contextHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
}

.chatWindow__contextBtns {
    display: flex;
    gap: 6px;
}

.chatWindow__btn {
    padding: 4px 8px;
    border-radius: 6px;
    border: 1px solid #3b82f6;
    background: #2563eb;
    color: #fff;
    font-size: 12px;
    cursor: pointer;
}

.chatWindow__btn.ghost {
    background: transparent;
    border-color: #475569;
    color: #94a3b8;
}

.chatWindow__btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
}

.chatWindow__chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}

.chatWindow__chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: rgba(148, 163, 184, 0.15);
    border: 1px solid rgba(148, 163, 184, 0.25);
    border-radius: 999px;
    padding: 4px 8px;
    font-size: 12px;
}

.chatWindow__chipType {
    font-size: 11px;
    opacity: 0.7;
    text-transform: uppercase;
}

.chatWindow__chipRemove {
    border: none;
    background: transparent;
    color: #fca5a5;
    cursor: pointer;
}

.chatWindow__chipsPlaceholder {
    font-size: 12px;
    color: #94a3b8;
    margin: 0;
}

.chatWindow__messages {
    flex: 1 1 auto;
    padding: 12px 14px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: #1f1f1f;
}

.chatWindow__messagesEmpty {
    margin: auto;
    text-align: center;
    font-size: 13px;
    color: #94a3b8;
}

.chatWindow__message {
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid rgba(148, 163, 184, 0.25);
    background: rgba(148, 163, 184, 0.12);
}

.chatWindow__message.is-user {
    align-self: flex-end;
    background: rgba(20, 184, 166, 0.18);
    border-color: rgba(20, 184, 166, 0.35);
}

.chatWindow__message.is-pending {
    opacity: 0.75;
    border-style: dashed;
    color: #cbd5f5;
}

.chatWindow__message.is-error {
    border-color: rgba(248, 113, 113, 0.45);
    background: rgba(248, 113, 113, 0.16);
    color: #fecaca;
}

.chatWindow__message.is-info {
    border-style: dashed;
    border-color: rgba(147, 197, 253, 0.45);
    background: rgba(147, 197, 253, 0.12);
    color: #bfdbfe;
}

.chatWindow__messageMeta {
    font-size: 11px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    margin-bottom: 6px;
    opacity: 0.7;
}

.chatWindow__messageMeta.is-user {
    align-items: flex-end;
    text-align: right;
}

.chatWindow__messageAuthor {
    font-weight: 600;
}

.chatWindow__messageTime {
    font-size: 10px;
    opacity: 0.75;
}

.chatWindow__messageBody {
    font-size: 13px;
    line-height: 1.6;
    display: block;
}

.chatWindow__messageBody > *:last-child {
    margin-bottom: 0;
}

.chatWindow__messageBody p {
    margin: 0 0 0.75em;
}

.chatWindow__messageBody ul,
.chatWindow__messageBody ol {
    margin: 0 0 0.75em;
    padding-left: 1.4em;
}

.chatWindow__messageBody li + li {
    margin-top: 0.3em;
}

.chatWindow__messageBody code {
    font-family: "JetBrains Mono", "Fira Code", "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    background: rgba(148, 163, 184, 0.18);
    border-radius: 4px;
    padding: 0.1em 0.4em;
    font-size: 0.92em;
}

.chatWindow__messageBody pre {
    margin: 0 0 0.75em;
    background: #0f172a;
    border: 1px solid rgba(148, 163, 184, 0.25);
    border-radius: 8px;
    padding: 10px 12px;
    overflow-x: auto;
    font-family: "JetBrains Mono", "Fira Code", "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    font-size: 12px;
    line-height: 1.5;
}

.chatWindow__messageBody pre code {
    padding: 0;
    background: transparent;
    border-radius: 0;
}

.chatWindow__messageBody a {
    color: #60a5fa;
    text-decoration: underline;
}

.chatWindow__messageBody hr {
    border: none;
    border-top: 1px solid rgba(148, 163, 184, 0.3);
    margin: 0.75em 0;
}

.chatWindow__messageBody blockquote {
    margin: 0 0 0.75em;
    padding-left: 0.9em;
    border-left: 3px solid rgba(148, 163, 184, 0.35);
    color: #cbd5f5;
}

.chatWindow__footer {
    padding: 12px 14px;
    border-top: 1px solid #2f2f2f;
    background: #262626;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.chatWindow__input {
    background: #141414;
    border: 1px solid #333;
    border-radius: 8px;
    color: #e2e8f0;
    padding: 8px 10px;
    min-height: 90px;
    resize: none;
}

.chatWindow__input:focus {
    outline: 1px solid #3b82f6;
}

.chatWindow__footerActions {
    display: flex;
    justify-content: space-between;
    align-items: center;
}

.chatWindow__status {
    font-size: 11px;
}

.chatWindow__send {
    padding: 6px 14px;
    border-radius: 8px;
    border: none;
    background: #3b82f6;
    color: white;
    cursor: pointer;
    font-weight: 600;
}

.chatWindow__send:disabled {
    opacity: 0.4;
    cursor: not-allowed;
}
</style>
