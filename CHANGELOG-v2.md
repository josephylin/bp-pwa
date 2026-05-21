# 🆕 v2 升級說明 — 雙次平均 + 週月分析

> 版本：**v2**（在 v1 基礎上新增，未破壞既有資料，提供一鍵遷移工具）

---

## 1. 新功能總覽

### 1.1 醫療標準雙次量測

依台灣高血壓學會 2022 居家血壓監測 (HBPM) 指引：

- **早晨**：起床後 1 小時內、排尿後、服藥前，**間隔 1-2 分鐘量兩次**取平均。
- **晚間**：就寢前同樣兩次取平均。
- **連續至少 7 天**才能做為臨床判讀依據。

App 內實作：

- 上方 **☀️早晨 / 🌙晚間 tab**，依目前時間自動預選。
- 「今日早晨第 N 次量測」提示語會動態更新。
- 量第二次後，畫面下方 **「今日早晨平均 128/82」** 即時顯示。

### 1.2 自動時段判定

| 量測時間 (24h) | 自動歸類 |
| -------------- | -------- |
| 05:00 – 10:59  | morning  |
| 18:00 – 隔日 01:59 | evening  |
| 其他           | other（仍儲存，但不納入早晚分析）|

使用者可手動切換 tab 覆寫自動判定。

### 1.3 週 / 月 / 全部 分析頁 (`stats.html`)

- **期間摘要 KPI**：早晨平均、晚間平均、日均、達標率、晨峰 (Morning Surge)
- **趨勢圖**：Chart.js 折線圖，早晨/晚間/日均三條線 + 目標虛線
- **每日明細表**：日期、早/晚平均、晨峰、達標標記
- **匯出 CSV**：給家醫科醫師印出來看診用
- **離線可用**：API 失敗時改用 localStorage 自己算

### 1.4 自動晨峰計算

`晨峰 = 早晨 SBP - 晚間 SBP`，> 20 mmHg 會出現警示文字。
（晨峰過大與心血管事件風險上升相關，是 HBPM 的關鍵指標。）

### 1.5 「每日彙整」工作表

Apps Script 每次寫入後，自動在 Google Sheet 新建 **「每日彙整」** 分頁，內容：
日期、早晨平均、晚間平均、日均、晨峰、是否達標 — 醫師可直接看。

---

## 2. 資料模型變更

### 原 v1 欄位（保留）
`recordedAt, systolic, diastolic, pulse, arm, position, note, clientId, syncedAt`

### v2 新增欄位
- `session`: `morning` / `evening` / `other`
- `pairIndex`: 同日同 session 內的第幾次（1, 2, 3…）

最終 v2 欄位順序：
```
recordedAt, session, pairIndex, systolic, diastolic, pulse, arm, position, note, clientId, syncedAt
```

---

## 3. 從 v1 升級的詳細步驟

### Step 1：替換程式碼

1. 用本資料夾的新版檔覆蓋舊版：
   - `Code.gs`、`index.html`、`service-worker.js`、`manifest.json`
   - 新增：`stats.html`
2. 重新填入 `ENDPOINT` 與 `SECRET`（與 v1 相同即可）。

### Step 2：更新 Apps Script

**選項 A — 用 clasp（Mac 推薦）**：
```bash
cd ~/Projects/bp-pwa/gas
cp ../Code.gs ./Code.gs
clasp push
clasp deployments                              # 找出 v1 的 deploymentId
clasp deploy --deploymentId <id> -d "v2"       # 沿用同一個 URL
```

**選項 B — 用瀏覽器**：
1. 打開 Apps Script 編輯器 → 貼上新 `Code.gs` → 儲存。
2. 部署 → 管理部署作業 → 編輯 (鉛筆) → 版本：**新版本** → 部署。

### Step 3：一次性執行遷移（補上 session/pairIndex 欄位）

在 Apps Script 編輯器：

1. 函式下拉選 **`migrateFromV1`** → 點 ▶ 執行 → 授權。
2. 完成後，到 Google Sheet 查看：
   - `血壓紀錄` 分頁多了 `session` 與 `pairIndex` 欄。
   - `每日彙整` 分頁自動建立。

> ⚠️ 此函式具備冪等性：再執行一次也不會壞，會偵測「已是 v2」就跳過。

### Step 4：更新前端 PWA

iPhone：

1. 重新發佈到 GitHub Pages / Netlify（git push 即可）。
2. **iPhone Safari**：到主畫面 → 長按舊的「血壓紀錄」icon → 刪除。
3. 重新打開新網址 → 加入主畫面（這步是為了確保 Service Worker 從 v1 升到 v2）。

> 也可以不刪 icon，但需要等 Service Worker 自動偵測新版（最多一兩天）；強制更新最快還是重裝。

### Step 5：驗證

1. 開啟 PWA → 應看到上方 tab 與時段提示。
2. 連量兩筆 → 下方出現「今日早晨平均」。
3. 切換到 `📊 週/月分析` → 應載入 KPI 與趨勢圖。
4. 飛航模式 → 分析頁仍可顯示（用本機資料）。

---

## 4. 醫師回診時的使用建議

1. 回診前一晚開啟 `stats.html` → 切到「本月」。
2. 確認 **達標率** 是否 ≥ 70%（指引建議目標）。
3. 看 **晨峰** 是否 > 20 mmHg。
4. 點「📥 匯出 CSV」或「🖨️ 列印給醫師」。
5. Google Sheet 的「每日彙整」分頁可直接分享給醫師（共用權限設為「檢視」）。

---

## 5. 關鍵指標說明

| 指標 | 計算方式 | 醫療意義 |
| ---- | -------- | -------- |
| 早晨平均 | 該日早晨所有量測之 SBP/DBP 平均 | 反映「服藥前」基礎血壓控制 |
| 晚間平均 | 該日晚間所有量測之 SBP/DBP 平均 | 反映「日間活動後」血壓恢復 |
| 日均血壓 | (早晨平均 + 晚間平均) / 2 | HBPM 主要判讀依據 |
| 晨峰 Morning Surge | 早晨 SBP − 晚間 SBP | > 20 mmHg 與心血管風險上升相關 |
| 達標率 | 日均 < 130/80 的天數比例 | 治療效果指標，建議 ≥ 70% |

> 門檻 `130/80` 為台灣 HTA 2022 指引的家庭血壓目標；若您有特殊狀況（糖尿病、慢性腎臟病、年齡 ≥ 75 歲），可自行修改 `Code.gs` 內 `TARGET_SBP` / `TARGET_DBP`。

---

## 6. 後續可加的功能（保留鉤子）

- **服藥標記**：`note` 欄目前可手動輸入，可改為下拉選單。
- **多人多檔**：在 record 加 `user` 欄，stats API 加 `?user=joseph` 過濾。
- **PDF 報告**：用 `window.print()` 已可印；要更漂亮可加 jsPDF。
- **LINE Notify 每週推播**：用 Apps Script `installable trigger` 每週日晚上 20:00 觸發，把週摘要送到 LINE。
- **Apple Health 同步**：iOS 16+ 可用 Shortcuts 把血壓寫進 Health.app（但需離開瀏覽器，留作下一階段）。
