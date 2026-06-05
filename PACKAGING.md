# 血壓紀錄 PWA — 打包成可安裝 App 的完整指南

本指南使用微軟維護的 **PWABuilder.com**（免費），把同一個 PWA 一次出包成
iOS、Android、Windows、macOS 四個平台的安裝檔。

---

## 1. 先決條件（必須先完成）

| 項目 | 為什麼 | 怎麼確認 |
|---|---|---|
| **網站已部署到 https** | PWABuilder 必須能用 `https://` 抓到你的 manifest 與 service worker | 用 iPhone Safari 打開該網址，能看到 PWA 即可 |
| **service-worker.js 已升到 v2.7** | 確保 manifest 補欄位、screenshots 都已上線 | 部署後到 `https://your-domain/manifest.json` 看到 `id` 與 `screenshots` 欄位 |
| **icons 與 screenshots 都能被取到** | PWABuilder 會跨網域驗證 | 在瀏覽器直接打開 `https://your-domain/icons/icon-512.png`、`/screenshots/screen-home.png` 確認沒 404 |

### 1.1 部署到 GitHub Pages（如果還沒做）

```bash
cd ~/bp-pwa
# 假設 main branch 已 push
git push

# 啟用 GitHub Pages（一次性）
# 1) 到 https://github.com/<你的帳號>/bp-pwa/settings/pages
# 2) Source 選 "Deploy from a branch"
# 3) Branch 選 main / root，按 Save
# 4) 等 1-2 分鐘，網址會出現在頁面上方
#    形如 https://<你的帳號>.github.io/bp-pwa/
```

> ⚠️ GitHub Pages 的根目錄不是 `/`，是 `/bp-pwa/`，所以 `start_url` 用 `./index.html` 是對的。

### 1.2 在 GitHub Pages 開啟「Service Worker 必須走 HTTPS」

GitHub Pages 已內建 HTTPS，無須額外設定。如果你用 Cloudflare、Netlify、Vercel 等也都自動 HTTPS。

---

## 2. iOS（iPhone）打包

### 2A. 最快路徑（推薦）：直接用 Safari「加入主畫面」

iPhone 上 PWA 就是 App。免簽署、免上架、免帳號。

1. iPhone 用 **Safari** 打開 `https://你的網址/`
2. 點下方分享 ⎙ → **加入主畫面**
3. 改名稱 → 加入
4. 主畫面就出現 App 圖示了

> Safari 會自動使用 manifest 裡的 `icons/icon-180.png`（已存在）做 App 圖示。

### 2B. 進階路徑：包成真正的 IPA 安裝（不推薦自用）

需要 macOS + Xcode + 自己的 Apple ID（**免費**），但簽署 7 天就要重簽，很麻煩。
若你真的需要，做法：

1. 到 [https://www.pwabuilder.com/](https://www.pwabuilder.com/)
2. 輸入你的網址 → 按 Start
3. 等驗證跑完 → 點右上角 **Package For Stores**
4. 選 **iOS** → 下載 zip
5. 解開後得到 Xcode 專案
6. Mac 上：
   ```bash
   open BloodPressure.xcodeproj
   # Xcode → Signing & Capabilities → 選你的 Apple ID
   # 接 iPhone USB → 選裝置 → Cmd+R 跑起來
   ```

> 真心建議：**iPhone 直接 2A 路徑**，效果一樣，省 99% 麻煩。

---

## 3. Android（APK）打包

### 3A. 用 PWABuilder（推薦，5 分鐘）

1. 打開 [https://www.pwabuilder.com/](https://www.pwabuilder.com/)
2. 輸入你的網址 → Start
3. 等三項分數（Manifest / Service Worker / Security）都通過
4. 點右上角 **Package For Stores**
5. 選 **Android** 卡片 → **Generate Package**
6. 選項：
   - **Package ID**：例如 `tw.joseph.bppwa`（自己設一個唯一 ID，反向網域）
   - **App name**：血壓紀錄
   - **Version**：1.0.0 / Version code：1
   - **Display mode**：standalone
   - **Signing key**：選 **Use mine** 或 **Generate new**
     - 選 Generate new 會給你一個 `.keystore` 檔，**務必保存好**（之後升級新版必須用同一把 key 簽，否則 Android 視為不同 App 拒絕覆蓋）
7. 下載得到一個 zip，內含：
   - `app-release-signed.apk` ← **就是這個給人安裝**
   - `signing.keystore` ← **備份起來**
   - `next-steps.html` ← 上 Play Store 教學（你不需要）

### 3B. 安裝 APK 到手機

把 `.apk` 傳到 Android：

- **方法 1**：用 Gmail / LINE 把檔案傳給自己
- **方法 2**：USB 接上電腦複製進去
- **方法 3**：放到 Google Drive 下載

點 apk → 系統會問「允許從此來源安裝」→ 設定打勾 → 回來繼續安裝。

### 3C. 升級新版本

PWABuilder 重做一份新 APK 時：
1. **Version code 必須 +1**（例如從 1 → 2）
2. **Signing key 用同一把 .keystore**（選 Use mine 上傳你保存的那個檔）

---

## 4. Windows 桌面 App

### 4A. 用 PWABuilder 出 MSIX

1. PWABuilder 同上 → **Package For Stores** → **Windows**
2. 選項：
   - **Package ID**：例如 `tw.joseph.bppwa`
   - **Publisher display name**：你的名字
   - **Publisher ID**：`CN=YourName`（自簽用）
   - **Generate package**
3. 下載得到 `.msix` 跟一張 `.cer` 憑證

### 4B. 在 Windows 上安裝

1. 先安裝憑證：雙擊 `.cer` → 安裝憑證 → 本機 → 受信任的根目錄
2. 雙擊 `.msix` → 安裝
3. 「開始」選單就會出現「血壓紀錄」App

> 沒有 Windows？這步可以跳過。

### 4C. 簡單替代：直接「邊瀏覽邊安裝」

如果 Windows 上有 Microsoft Edge：

1. Edge 開你的網址
2. 網址列右邊出現 ⊕「安裝應用程式」圖示
3. 點下去 → 安裝
4. App 出現在「開始」選單，本機桌面也可建捷徑

這個方式 **不需要 PWABuilder 也不需要憑證**，效果一樣，是 PWA 的標配。

---

## 5. macOS 桌面 App

### 5A. 用 Safari「加入 Dock」

macOS Sonoma (14) 以後 Safari 內建：

1. Safari 開你的網址
2. 選單：**檔案 → 加入 Dock…**
3. App 出現在 Dock，獨立視窗
4. Cmd+Q 關閉、Spotlight 搜得到

### 5B. 用 Chrome / Edge「安裝為應用程式」

如果你用 Chrome 或 Edge：

1. 網址列右邊 ⊕「安裝」圖示
2. 點下去 → 安裝
3. Launchpad / Spotlight 找得到

### 5C. 真的要 .dmg？

PWABuilder 不直接出 macOS 套件。要的話用 [Nativefier](https://github.com/nativefier/nativefier)：

```bash
npm install -g nativefier
nativefier --name "血壓紀錄" "https://你的網址/" ~/Desktop
# 會在桌面產生 血壓紀錄-darwin-arm64/ 資料夾
# 拖進 /Applications 就是 App
```

> 注意：Nativefier 本質是 Electron 包裝，檔案大（~150 MB），不太建議自用。**5A 或 5B 才是正解。**

---

## 6. 四平台一次出包速查表

| 平台 | 推薦方式 | 時間 | 需要工具 |
|---|---|---|---|
| **iPhone** | Safari「加入主畫面」 | 30 秒 | 無 |
| **iPad** | Safari「加入主畫面」 | 30 秒 | 無 |
| **Android** | PWABuilder → APK | 5 分鐘 | 瀏覽器 |
| **Windows** | Edge「安裝應用程式」 | 30 秒 | Edge |
| **Windows (MSIX)** | PWABuilder → MSIX | 5 分鐘 | 瀏覽器 + Windows |
| **macOS** | Safari「加入 Dock」 | 30 秒 | macOS 14+ |

---

## 7. 開始打包前的最後檢查清單

- [ ] 網址用 https 打開沒問題
- [ ] `https://你的網址/manifest.json` 看得到 `id`、`screenshots`、`shortcuts`
- [ ] `https://你的網址/icons/icon-512.png` 顯示得出來
- [ ] `https://你的網址/screenshots/screen-home.png` 顯示得出來
- [ ] iPhone Safari 開能看到頁面正常
- [ ] 已在 Apps Script 把 `_fmtTime` 部署成 v2.1+（時間正確寫入 Sheet）

打勾完就丟 [https://www.pwabuilder.com/](https://www.pwabuilder.com/) 開始打包。

---

## 8. 升級新版 App 怎麼辦？

**iOS / macOS / Windows 邊瀏覽邊裝的 PWA**：
- 不用做任何事。Service Worker 自動更新快取，下次開 App 就是新版。

**Android APK / Windows MSIX**：
- 修改網頁 → PWABuilder 重新出包（version code +1）→ 用戶手動安裝新 APK / MSIX
- 已安裝的 App 內部 webview 也會跟著抓新的 service-worker.js，所以 **網頁邏輯改動不用重打包**，只有 manifest / 圖示 / Package ID 改了才需要重出 APK
