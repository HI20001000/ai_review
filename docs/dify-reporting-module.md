# Dify 驅動的代碼審查報告模塊設計

## 目標

* 允許使用者針對當前項目或指定提交請求代碼審查報告。
* 通過調用 Dify Workflow 對代碼進行分析，返回審查建議與風險評估。
* 在現有工作區介面中提供報告的觸發、狀態反饋與結果展示。

## 系統結構

```
+-------------------+        +--------------------------+
| Vue Workspace UI  | ---->  | Reporting Service (FE)   |
+-------------------+        +--------------------------+
           |                              |
           v                              v
+-------------------+        +--------------------------+
| Backend API (新)   | ---->  | Dify Workflow Endpoint   |
+-------------------+        +--------------------------+
```

### 前端

* **報告觸發器 (ReportTrigger.vue)**
  * 放置於現有 top bar 或專案工具列。
  * 提供下拉選單選擇審查範圍（整個專案、指定檔案、Git diff）。
  * 可選擇報告類型（安全、性能、風格、自定義模板）。
* **報告狀態面板 (ReportPanel.vue)**
  * 顯示正在執行的工作流狀態、隊列位置、耗時。
  * 允許取消尚未完成的請求。
* **報告結果視圖 (ReportResult.vue)**
  * 模組化呈現 Dify 回傳的結構化數據：概要、問題列表、建議、置信度。
  * 支援將建議轉化為待辦事項或直接在 IDE 中定位。

### 狀態管理

* 建立 `useReportStore`（Pinia）管理請求、結果與錯誤。
* 透過 `useProjectStore`/`useChatStore` 的現有模式注入依賴。
* 報告請求結構：

```ts
interface ReportRequest {
  id: string;
  projectId: string;
  target: 'project' | 'files' | 'diff';
  payload: {
    files?: string[];
    diff?: string;
    branch?: string;
  };
  templateId: string;
  createdAt: number;
}
```

### 後端 API

* 新增 Node/Express 或現有後端服務的 `/api/reports` 路由。
* **POST /api/reports**：接收 `ReportRequest`，轉發給 Dify Workflow。
* **GET /api/reports/:id**：輪詢或 SSE 推送結果。
* **DELETE /api/reports/:id**：取消執行。
* 後端負責：
  * 封裝 Dify API Key，避免前端暴露。
  * 對 Dify Workflow 請求/回應進行驗證與格式化。
  * 管理超時、重試及錯誤映射。

### 與 Dify 的整合

* 選擇使用 Dify Workflow v2 HTTP API。
* 發送 payload：

```json
{
  "inputs": {
    "project_name": "...",
    "code_context": "...", // 打包的檔案或 diff
    "report_type": "security",
    "metadata": { "user": "...", "branch": "..." }
  },
  "response_mode": "stream"
}
```

* 使用 Webhook 或輪詢 `workflow_runs/{id}` 取得狀態。
* 將回傳資料整理為：

```ts
interface ReportResult {
  id: string;
  summary: string;
  issues: Array<{
    title: string;
    severity: 'low' | 'medium' | 'high';
    description: string;
    file?: string;
    line?: number;
    suggestion: string;
  }>;
  metrics: Record<string, number>;
  raw: unknown;
}
```

## UX 流程

1. 使用者在 top bar 點擊「生成報告」。
2. 彈出設定對話框選擇審查範圍與模板。
3. 前端呼叫 `/api/reports` 建立請求；`useReportStore` 紀錄狀態為 `pending`。
4. 後端呼叫 Dify Workflow，使用 SSE 將進度推送給前端。
5. 完成後 `ReportPanel` 自動顯示結果摘要，並可進一步展開詳情。
6. 使用者可將建議加入待辦、複製或導出為 Markdown/PDF。

## 權限與設定

* 在專案設定頁加入 Dify API Key 與 Workflow ID 的管理介面。
* 支援多 Workflow（不同審查模板），可在組織層級配置。
* 針對不同角色限制報告請求權限。

## 錯誤處理

* 顯示清晰的錯誤訊息（認證失敗、工作流異常、超時）。
* 提供重試機制與可操作建議。
* 在 Console 記錄完整錯誤以協助除錯。

## 後續擴展

* 導入自動化排程（每日/每次合併）生成報告。
* 與版本控制整合（Git Hooks）在 PR 建立時自動生成報告。
* 對報告內容引入 AI 輔助修復建議，一鍵應用補丁。

