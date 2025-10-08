# 連接到您自己的 MySQL 數據庫

下列步驟說明如何把此專案的後端 API 指向您自己的 MySQL 伺服器，並初始化所需的資料表。

## 1. 準備資料庫
1. 建立一個空的資料庫（例如 `ai_platform`）。
2. 確認您擁有可讀寫該資料庫的帳號與密碼。

## 2. 設定環境變數
1. 在專案根目錄建立一份 `.env` 檔案，填入您資料庫的連線資訊：
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
專案提供 `server/sql/schema.sql` 的建表腳本與 `server/scripts/initDatabase.js` 的初始化指令。執行以下命令會讀取 `.env` 並套用 schema；它僅會在您指定的資料庫中建立 `projects`、`nodes` 與 `reports` 等必要資料表，不會另外建立新的資料庫：
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
前端透過 `src/scripts/services/apiService.js` 讀取 `VITE_API_BASE_URL` 來決定 API 位址；若沒有設定，則預設以目前網頁的來源 + `/api` 為基底。

若瀏覽器載入的前端與後端服務不同主機／Port，請在前端可讀取的環境檔案中設定 `VITE_API_BASE_URL`。常見做法如下：

```bash
# 以本地開發為例，在專案根目錄建立 .env.local
echo "VITE_API_BASE_URL=https://your-api-host:3001/api" >> .env.local
```

Vite 會在開發模式讀取 `.env.local`、`.env.development` 等檔案；若您是在部署前就要寫死連線資訊，也可以直接在部署流程產生對應的環境檔案。設定後重新啟動 `npm run dev` 或重新建置前端，即可讓所有 API 呼叫指向新的後端。

> **提示**：若您在本地同時啟動 `npm run dev` 與後端，還可以設定 `VITE_BACKEND_URL` 以改變 Vite 開發伺服器的 proxy 目標（預設為 `http://localhost:3001`）。

## 6. 常見 npm 指令說明

| 指令 | 作用 | 實際執行的腳本 |
| --- | --- | --- |
| `npm run db:init` | 套用 `server/sql/schema.sql`，在目前設定的資料庫中建立 `projects`、`nodes`、`reports` 等資料表。 | `node server/scripts/initDatabase.js` |
| `npm run db:dev` | 與 `db:init` 等效，提供在開發流程中更直覺的命名。 | `node server/scripts/initDatabase.js` |

完成上述步驟後，應用程式就會改為使用您指定的 MySQL 資料庫儲存專案與節點資料。

## 6.1 本地開發執行順序示例

若要在本機端完整啟動前後端，可依照下列順序操作：

1. 設定 `.env` 與 `.env.local` 等環境檔案，確認資料庫與 API 位址皆正確。
2. 執行 `npm run db:init`（或 `npm run db:dev`）建立 `projects` 與 `nodes` 資料表。
3. 在第一個終端視窗啟動後端 API：
   ```bash
   npm run server
   ```
4. 在第二個終端視窗啟動前端開發伺服器：
   ```bash
   npm run dev
   ```

保持兩個指令持續執行，前端就會透過 `VITE_API_BASE_URL` 指向已啟動的 API 服務。

## 7. 排錯：看到「Table '...projects' doesn't exist」

若 API 回傳錯誤訊息 `Table 'ai_platform.projects' doesn't exist`（或其他資料庫名稱），表示已成功連線到 MySQL，但目前的 `MYSQL_DATABASE` 中尚未建立必要的資料表。請確認下列事項：

1. `.env` 檔案中的 `MYSQL_DATABASE` 是否指向您初始化 schema 的那個資料庫。
2. 是否已執行 `npm run db:init`（或 `npm run db:dev`）來套用 `server/sql/schema.sql`。
3. API 伺服器啟動時的日誌是否顯示 `MySQL schema ensured successfully.`；如果沒有，請檢查使用者帳號是否具有 `CREATE TABLE` 權限，或手動執行 `schema.sql`。

完成以上檢查後，再次重啟 API 伺服器，錯誤即可排除。

## 8. 排錯：出現「Access denied for user '...' (using password: NO)」

如果初始化或啟動時看到 `ER_ACCESS_DENIED_ERROR`，且訊息中寫著 `using password: NO`，代表 Node.js 並沒有從環境變數取得密碼。請檢查下列步驟：

1. 確認 `.env` 檔案中 `MYSQL_PASSWORD` 已填入正確的密碼，若密碼包含特殊符號可使用引號包起來（例如 `MYSQL_PASSWORD="p@ss word"`）。
2. `npm run db:init` 與 `npm run server` 會在日誌中列印目前使用的主機、使用者、資料庫與「password=set/empty」提示，可用來確認是否成功載入 `.env`。
3. 若您透過 shell 直接匯出環境變數，請重新開啟終端或確保在執行指令的同一個視窗中匯出。例如：

   ```bash
   export MYSQL_PASSWORD=your-password
   npm run db:init
   ```

完成後重新執行初始化或啟動流程，即可使用帶密碼的帳號連線。
