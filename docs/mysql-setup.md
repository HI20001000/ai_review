# 連接到您自己的 MySQL 數據庫

下列步驟說明如何把此專案的後端 API 指向您自己的 MySQL 伺服器，並初始化所需的資料表。

## 1. 準備資料庫
1. 建立一個空的資料庫（例如 `ai_platform`）。
2. 確認您擁有可讀寫該資料庫的帳號與密碼。

## 2. 設定環境變數
1. 複製 `.env.example` 為 `.env`：
   ```bash
   cp .env.example .env
   ```
2. 編輯 `.env`，填入您資料庫的連線資訊：
   ```ini
   MYSQL_HOST=your-db-host
   MYSQL_PORT=3306
   MYSQL_USER=your-db-user
   MYSQL_PASSWORD=your-db-password
   MYSQL_DATABASE=ai_platform
   MYSQL_POOL_SIZE=10
   ```
   * `MYSQL_HOST` 可以是本機或遠端主機名稱／IP。
   * 若您使用雲端資料庫，請同時確認防火牆／安全群組允許 API 伺服器的 IP 連線。
   * 其他欄位請依需求調整。

## 3. 初始化資料表
專案提供 `server/sql/schema.sql` 的建表腳本與 `server/scripts/initDatabase.js` 的初始化指令。執行以下命令會讀取 `.env` 並套用 schema；它僅會在您指定的資料庫中建立 `projects` 與 `nodes` 兩張資料表，不會另外建立新的資料庫：
```bash
npm run db:init
```
如果您想手動操作，也可以直接在 MySQL 客戶端執行 `server/sql/schema.sql` 內容。

## 4. 啟動 API 伺服器
確保 `.env` 中的 `PORT`、`HOST`、`CORS_ALLOWED_ORIGINS` 等設定符合您的環境，然後啟動後端：
```bash
npm run server
```
啟動時會自動確認資料表是否存在（參考 `server/index.js` 的 `ensureSchema` 呼叫）。

## 5. 前端連線設定
若前端與後端不在同一個主機／Port，請設定 `VITE_API_BASE_URL` 指向後端 API，例如在 `.env` 或 `.env.local` 中加入：
```ini
VITE_API_BASE_URL=https://your-api-host:3001/api
```
前端使用 `src/scripts/services/apiService.js` 透過 `fetch` 連線後端 API。

## 6. 常見 npm 指令說明

| 指令 | 作用 | 實際執行的腳本 |
| --- | --- | --- |
| `npm run db:init` | 套用 `server/sql/schema.sql`，在目前設定的資料庫中建立 `projects` 與 `nodes` 資料表。 | `node server/scripts/initDatabase.js` |
| `npm run db:dev` | 與 `db:init` 等效，提供在開發流程中更直覺的命名。 | `node server/scripts/initDatabase.js` |

完成上述步驟後，應用程式就會改為使用您指定的 MySQL 資料庫儲存專案與節點資料。
