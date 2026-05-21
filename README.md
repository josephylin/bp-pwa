# 🩺 離線版血壓紀錄 PWA — 完整開發手冊

> **目標**：用最低成本 (零 Google Cloud 專案、零 OAuth、零 API Key) 打造一個可在 iPhone Safari「加入主畫面」、**離線可寫入、恢復連線後自動同步至 Google Sheet** 的血壓紀錄應用。
>
> **技術選型**：HTML + Vanilla JS PWA（`localStorage` + Service Worker）＋ Google Apps Script Web App (`doPost`) ＋ Google Sheet。

---

## 0. 架構總覽

```
 [iPhone / Safari PWA]                      [Google]
 ┌────────────────────────┐                ┌─────────────────────────┐
 │ index.html             │  fetch(text/   │ Apps Script Web App     │
 │  ├─ HTML5 表單         │  plain) POST   │  doPost(e)              │
 │  ├─ localStorage 佇列  │ ──────────────▶│   └─ 寫入 Spreadsheet   │
 │  ├─ Service Worker     │                │                          │
 │  └─ manifest.json      │                │  doGet(e) 健康檢查       │
 └────────────────────────┘                └─────────────────────────┘
        │   ▲                                       │
        │   └── 離線時：寫入 localStorage 佇列      │
        └────── 上線/可見時：批次同步並去重 ────────┘
```

**為什麼不需要 Google Cloud 專案 / OAuth / API Key？**
- Web App 部署時將「存取權限」設為 **任何人**，等同公開 endpoint。
- 前端用 `Content-Type: text/plain` 送 JSON，瀏覽器**不會發 CORS preflight**，Apps Script 預設即可回應，免設定 CORS。
- 安全靠 `SHARED_SECRET`（前後端共用的隨機字串）阻擋陌生人亂寫。

---

## 1. 檔案清單

```
bp-pwa/
├── Code.gs               ← Google Apps Script 後端（貼到 Apps Script 編輯器）
├── index.html            ← 前端主頁（表單 + localStorage + 同步邏輯）
├── manifest.json         ← PWA Manifest
├── service-worker.js     ← Service Worker（離線快取）
└── icons/
    ├── icon-180.png      ← Safari apple-touch-icon
    ├── icon-192.png
    ├── icon-512.png
    └── icon-512-maskable.png
```

---

## 2. Code.gs — Apps Script 後端

完整內容見同資料夾 `Code.gs`。重點：

- `doPost(e)`：接收 JSON `{ secret, records:[...] }`，驗證 `SHARED_SECRET` 後批次寫入。
- 內建 **clientId 去重**：前端每筆紀錄都帶 UUID，重複上傳也只會寫一次（離線→上線重試很重要）。
- `LockService.getDocumentLock()` 防止並發寫入打架。
- `doGet(e)` 提供健康檢查，部署完直接用瀏覽器打開部署網址應回傳 `{"ok":true,...}`。

⚠️ **部署前請改兩個常數**：

```js
const SHEET_NAME    = '血壓紀錄';
const SHARED_SECRET = 'CHANGE_ME_to_a_random_string'; // 換成你自己的隨機字串
```

---

## 3. 前端 index.html — 重點說明

### 3.1 表單欄位
量測時間、收縮壓、舒張壓、心率、手臂、姿勢、備註。

### 3.2 localStorage Schema

| Key         | 內容                                                     |
| ----------- | -------------------------------------------------------- |
| `bp.queue`  | 尚未成功同步的紀錄陣列（離線時累積在此）                 |
| `bp.synced` | 已成功同步的紀錄（保留最近 200 筆給 UI 顯示，可清空）    |

每筆紀錄結構：
```json
{
  "clientId": "uuid-v4",
  "recordedAt": "2026-05-21T07:30:00.000Z",
  "systolic": 128, "diastolic": 82, "pulse": 72,
  "arm": "left", "position": "sitting", "note": ""
}
```

### 3.3 離線/上線同步流程

1. **送出表單** → 一律先 `push` 進 `bp.queue`（離線、線上皆同），UI 立即更新。
2. **若 `navigator.onLine === true`** → 立刻呼叫 `sync()`。
3. **`sync()`** 將整個 `bp.queue` 以 `fetch(... text/plain ...)` 批次送到 Apps Script。
4. 伺服器回 `{ acceptedIds, skippedIds }` → 前端從 `bp.queue` 移除這些 ID，移入 `bp.synced`。
5. **事件監聽**：
   - `window.addEventListener('online', sync)`：斷網→恢復連線自動同步。
   - `visibilitychange`：從背景回到前景且在線→自動同步。
6. **CORS 規避**：刻意使用 `Content-Type: text/plain`，避免瀏覽器發 OPTIONS preflight（Apps Script 不支援自訂 CORS header）。

### 3.4 必須修改

打開 `index.html`，找到設定區塊：

```js
const ENDPOINT = 'https://script.google.com/macros/s/REPLACE_WITH_YOUR_DEPLOYMENT_ID/exec';
const SECRET   = 'CHANGE_ME_to_a_random_string'; // 與 Code.gs 一致
```

---

## 4. manifest.json — PWA 設定要點

| 欄位                 | 說明                                                                             |
| -------------------- | -------------------------------------------------------------------------------- |
| `name` / `short_name`| App 顯示名稱（主畫面 icon 下方）                                                  |
| `start_url: "./index.html"` | 點主畫面 icon 開啟的頁面                                                    |
| `display: "standalone"`     | 開啟後**無 Safari 網址列**，像原生 App                                       |
| `theme_color` / `background_color` | 啟動畫面顏色                                                         |
| `icons[]`            | 192 / 512 / maskable 三種尺寸供 Android、Chrome 使用                              |

> **iOS Safari 特別注意**：iOS 對 manifest 支援有限，因此 `index.html` 內**還必須**保留以下 `<meta>` 與 `<link>`，否則加入主畫面後體驗會掉漆：
>
> ```html
> <meta name="apple-mobile-web-app-capable" content="yes">
> <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
> <meta name="apple-mobile-web-app-title" content="血壓紀錄">
> <link rel="apple-touch-icon" href="icons/icon-180.png">
> ```

---

## 5. service-worker.js — 離線策略

- **靜態檔（同網域）**：Cache First → 離線也能開啟 PWA。
- **Apps Script API**：Network Only → 不快取寫入請求。
- 離線 fallback：找不到資源時回退到 `index.html`。

---

## 6. 完整部署步驟

### Step 1 — 建立 Google Sheet 並掛上 Apps Script

1. 進入 [Google Sheets](https://sheets.google.com)，新建一個試算表，命名為例如「血壓紀錄資料庫」。
2. 選單列 **擴充功能 → Apps Script**，會開啟 Apps Script 編輯器。
3. 將編輯器內預設的 `Code.gs` 清空，貼上本專案的 `Code.gs` 內容。
4. 修改：
   - `SHEET_NAME` 對應的工作表分頁名稱（預設 `血壓紀錄`，與試算表底部分頁名一致即可）。
   - `SHARED_SECRET` 改成一組你自己生成的隨機字串（建議 24 字以上）。
5. 在編輯器內手動執行一次 `setupSheet`：選函式 `setupSheet` → 點 ▶ 執行 → 首次會跳「授權」→ 允許（這只是讓**你自己**的腳本可存取**你自己**的試算表，無需 GCP 專案）。
6. 執行成功後，回試算表會看到工作表已建立並寫入標題列。

### Step 2 — 部署為 Web App（拿到 endpoint URL）

1. Apps Script 編輯器右上角 **部署 → 新增部署作業**。
2. 類型選 **網頁應用程式 (Web app)**。
3. 設定：
   - **說明**：BP PWA v1
   - **執行身分**：**我** (`me@gmail.com`)
   - **存取權限**：**任何人** (anyone)
4. 點 **部署** → 複製「網頁應用程式網址」(`https://script.google.com/macros/s/XXXX/exec`)。
5. **測試**：用瀏覽器直接打開該網址，應該看到 `{"ok":true,"service":"bp-pwa", ...}`。

> 之後若修改 Code.gs，需 **部署 → 管理部署作業 → 編輯 (鉛筆圖示) → 版本：新版本 → 部署**，URL 不變。

### Step 3 — 將 endpoint 填進 index.html

打開 `index.html`，將：

```js
const ENDPOINT = 'https://script.google.com/macros/s/REPLACE_WITH_YOUR_DEPLOYMENT_ID/exec';
const SECRET   = 'CHANGE_ME_to_a_random_string';
```

替換為 Step 2 拿到的網址與 Step 1 的 `SHARED_SECRET`。

### Step 4 — 將前端託管於 HTTPS 站點

PWA + Service Worker **強制要求 HTTPS**（`localhost` 例外）。三種免費方案任選：

#### 方案 A：GitHub Pages（最推薦，免費 HTTPS）

```bash
# 在本機（或 Codespaces）
cd bp-pwa
git init
git add .
git commit -m "init bp pwa"
git branch -M main
git remote add origin https://github.com/<你的帳號>/bp-pwa.git
git push -u origin main
```

到 GitHub repo → **Settings → Pages** → Source 選 `main` / `(root)` → Save。
等一兩分鐘，會給你網址：`https://<你的帳號>.github.io/bp-pwa/`

#### 方案 B：Cloudflare Pages / Netlify / Vercel
拖曳整個 `bp-pwa/` 資料夾即可，自動分配 HTTPS 網址。

#### 方案 C：本地測試
```bash
cd bp-pwa
python3 -m http.server 8000
# 用桌機 Chrome 開 http://localhost:8000 測試（Service Worker 在 localhost 也能跑）
```

> ⚠️ 若用 IP 或 http:// 開啟，Service Worker 不會註冊，PWA 也無法被「加入主畫面」。

### Step 5 — 在 iPhone Safari「加入主畫面」

1. **務必用 Safari**（Chrome on iOS 無法安裝 PWA 到主畫面、也不會啟用 Service Worker）。
2. 開啟 `https://<你的網域>/bp-pwa/`（或 GitHub Pages 網址）。
3. 點底部 **分享 ⬆️** → **加入主畫面** → 確認名稱「血壓紀錄」→ **加入**。
4. 主畫面會出現藍色「BP」icon，點開即進入 **standalone 模式**（無網址列）。
5. **第一次必須在連線狀態下開啟一次**，讓 Service Worker 完成快取，之後才能完全離線使用。

### Step 6 — 驗證離線同步流程

1. 開啟主畫面 PWA，輸入一筆血壓資料 → 看到「已同步」。
2. **手機切換到飛航模式**。
3. 再輸入兩、三筆 → 上方狀態列顯示「離線 / 待同步：3 筆」，資料以「待同步」顯示。
4. 關閉飛航模式 → 應在數秒內自動同步，狀態恢復「線上 / 待同步：0 筆」，Google Sheet 出現新列。
5. **重複同步測試**：把同一筆送兩次（例如手動呼叫 `sync()`）→ Sheet **不會出現重複列**（靠 `clientId` 去重）。

---

## 7. 常見問題排查

| 症狀                                                | 可能原因 / 解法                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 「加入主畫面」選項沒出現                            | 必須用 Safari、必須 HTTPS、必須有有效 `manifest.json` 與 `apple-touch-icon`           |
| 點 icon 開啟仍有 Safari 網址列                      | `<meta name="apple-mobile-web-app-capable" content="yes">` 缺失，或 manifest 未載入   |
| 同步失敗、Console 顯示 CORS 錯誤                    | `Content-Type` 不能設成 `application/json`，**必須保留 `text/plain`**                 |
| Apps Script 回 `UNAUTHORIZED`                       | `SECRET` 兩邊不一致                                                                   |
| 修改 Code.gs 後沒生效                               | 必須 **管理部署 → 編輯 → 版本：新版本 → 部署**，否則 URL 仍指舊版本                   |
| 離線時可寫入，恢復連線後沒自動同步                  | 確認 `window.addEventListener('online', ...)` 有觸發；可手動點「立即同步」按鈕測試   |
| iPhone 主畫面 icon 是白底空白                       | 確認 `icons/icon-180.png` 存在且可由 HTTPS 取得；清掉主畫面 icon 重新加入             |
| Service Worker 更新後內容沒換                       | 改 `service-worker.js` 內的 `CACHE = 'bp-pwa-v2'` 升版號，重新部署                    |

---

## 8. 安全與資料保留建議

- `SHARED_SECRET` 雖然會出現在前端 JS 內，但因為部署網址本身也是公開的，**這層 secret 只是阻擋路過的爬蟲**。若要更嚴謹，可額外加上：
  - 限制 `recordedAt` 不可早於某日 / 不可未來。
  - 在 Apps Script 內用 `PropertiesService` 存白名單 IP 範圍（可從 `e.parameter` 抓不到，但可在 Sheet 端做事後稽核）。
- 醫療資料屬高敏個資；若分享給家人共同使用，建議：
  - 試算表 → 共用對象限定特定 Google 帳號。
  - 不要把 `SHARED_SECRET` 放在公開的 GitHub repo（可改用 build 時注入，或部署到 private Pages）。

---

## 9. 後續可擴充

- **趨勢圖**：用 Chart.js 讀 `bp.synced` 畫 7/30 日折線。
- **CSV 匯出**：直接讀 `localStorage` 產 Blob 下載。
- **iCloud 同步**：iOS 不支援，但因為主要資料源是 Google Sheet，可從任何裝置查閱。
- **WebAuthn / Passcode 鎖**：開啟 App 前要求 Touch ID（透過 WebAuthn）。
- **多人多檔**：在 `Code.gs` 加 `user` 欄位，不同人寫到不同 sheet 分頁。

---

完成上述步驟後，您即擁有一個 **零後端維運成本、可離線、可同步、可加入主畫面** 的個人血壓紀錄 PWA。🎉
