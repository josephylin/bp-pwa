# 🍎 macOS 開發補充手冊 — 血壓紀錄 PWA

> 本文件補充於 `README.md`，專門針對 **MacBook 開發者**，包含本機 HTTPS 測試、iPhone 真機調試、用 `clasp` 從終端機部署 Apps Script、Safari 開發者工具、以及 macOS 常踩的雷。

---

## 0. 一次安裝完整工具鏈（5 分鐘）

打開 **終端機 (Terminal)**：

```bash
# 1) 安裝 Homebrew（已裝可跳過）
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 2) 必備工具
brew install git node               # Node 也會一併帶 npm
brew install --cask visual-studio-code   # 編輯器（已用其他編輯器可略）
brew install --cask google-chrome        # 開發時用 Chrome DevTools 較順手

# 3) Apps Script 命令列工具 clasp（可選但強烈推薦）
npm install -g @google/clasp

# 4) 本機 HTTPS 伺服器（PWA / Service Worker 測試用）
npm install -g http-server
brew install mkcert nss             # 產生本機受信任的 HTTPS 憑證
mkcert -install
```

驗證：

```bash
node -v && npm -v && git --version && clasp --version
```

---

## 1. 專案放哪？建議目錄結構

```bash
mkdir -p ~/Projects/bp-pwa
cd ~/Projects/bp-pwa
# 把先前下載的 bp-pwa.zip 解壓到此處
unzip ~/Downloads/bp-pwa.zip -d ~/Projects/
cd ~/Projects/bp-pwa
code .   # 用 VS Code 打開
```

---

## 2. 本機開發伺服器（兩種模式）

### 模式 A — 純 http (僅用桌機 Chrome 測試)
Service Worker 在 `http://localhost` 是被允許的，**桌機開發最簡單**：

```bash
cd ~/Projects/bp-pwa
npx http-server -p 8000 -c-1          # -c-1 = 關閉快取，方便改檔即時看效果
# 或用 Python 內建：
python3 -m http.server 8000
```

打開 Chrome：`http://localhost:8000/`

### 模式 B — 本機 HTTPS（要在 **iPhone 真機**測試「加入主畫面」必用）

iPhone Safari **不接受 http**，必須 HTTPS。用 `mkcert` 簽一張本機憑證：

```bash
cd ~/Projects/bp-pwa
mkcert localhost 127.0.0.1 $(ipconfig getifaddr en0)
# 會產生 localhost+2.pem 與 localhost+2-key.pem
http-server -p 8443 -S \
  -C localhost+2.pem -K localhost+2-key.pem -c-1
```

- 找出 Mac 區網 IP：
  ```bash
  ipconfig getifaddr en0     # Wi-Fi
  # 或
  ipconfig getifaddr en1
  ```
- iPhone 與 Mac 連同一 Wi-Fi，Safari 開：
  `https://<Mac 的 IP>:8443/`
- **首次會跳憑證警告** → 進階 → 仍要前往。
  - 若想完全免警告：把 `mkcert` 產生的 root CA (`~/Library/Application Support/mkcert/rootCA.pem`) AirDrop 到 iPhone → 設定 → 一般 → VPN 與裝置管理 → 安裝描述檔 → 設定 → 一般 → 關於 → 憑證信任設定 → 啟用該 root CA。

---

## 3. 在 iPhone 真機 Debug（Mac 連線 USB）

1. iPhone：**設定 → Safari → 進階 → Web 檢閱器** 打開。
2. Mac Safari：**設定 → 進階 → 顯示網頁開發者功能**。
3. iPhone 用 USB-C / Lightning 線接 Mac，**信任此電腦**。
4. 在 iPhone Safari 開啟 PWA 網址。
5. Mac Safari 選單列 → **開發 → [你的 iPhone 名稱] → [PWA 頁面]** → 打開 Web Inspector。
   - 可即時看 `console.log`、`localStorage`、Service Worker 狀態、Network 請求。
6. **重點檢查項**：
   - **儲存空間 → 本機儲存空間**：確認 `bp.queue` / `bp.synced` 真的有寫入。
   - **服務工作行程**：應顯示 `service-worker.js` 為 **activated**。
   - **網路**：飛航模式下重新整理頁面，應仍能載入（Cache 命中）。

---

## 4. 用 clasp 從終端機管理 Apps Script（取代瀏覽器手動貼程式碼）

### 4.1 第一次登入

```bash
clasp login
# 會自動開 Safari，登入您要綁定 Sheet 的 Google 帳號 → 授權
```

### 4.2 啟用 Apps Script API（一次性）

開啟 [https://script.google.com/home/usersettings](https://script.google.com/home/usersettings)
→ 將「Google Apps Script API」切到 **開啟**。

### 4.3 把現有 Sheet 的 Apps Script 拉到本機

1. 先依 README Step 1 在 Google Sheet 用「擴充功能 → Apps Script」建立空白專案、貼一次 Code.gs（或留空也行）。
2. 從該專案網址抓 Script ID：
   `https://script.google.com/d/<SCRIPT_ID>/edit` ← 中間那段。
3. 在 Mac 終端機：

```bash
cd ~/Projects/bp-pwa
mkdir gas && cd gas
clasp clone <SCRIPT_ID>
# 會下載 Code.gs、appsscript.json 到當前資料夾
```

### 4.4 把本專案的 Code.gs 推上去

```bash
cp ../Code.gs ./Code.gs       # 把開發中的版本覆蓋進來
clasp push                    # 上傳到 Apps Script
clasp deploy -d "BP PWA v1"   # 建立 Web App 部署
clasp deployments             # 列出所有部署、拿到 deploymentId
```

> 之後改 Code.gs → `clasp push && clasp deploy --deploymentId <id> -d "v2"` 就完成更新，**完全不用打開瀏覽器**。

### 4.5 即時看 Apps Script Log

```bash
clasp logs --watch
# 在前端送一筆資料，這裡會即時印出 Stackdriver log
```

---

## 5. 推到 GitHub Pages 做正式 HTTPS 託管

```bash
cd ~/Projects/bp-pwa

# 第一次：建 repo
gh auth login                          # 若有裝 GitHub CLI (brew install gh)
gh repo create bp-pwa --public --source=. --remote=origin --push

# 或傳統做法
git init && git add . && git commit -m "init"
git branch -M main
git remote add origin https://github.com/<你的帳號>/bp-pwa.git
git push -u origin main
```

到 GitHub repo → **Settings → Pages → Branch: main / root → Save**。
等 1～2 分鐘，網址 `https://<你的帳號>.github.io/bp-pwa/` 上線。

> **小撇步**：可在 `~/Projects/bp-pwa/.github/workflows/` 加 GitHub Actions，每次 push 自動部署（Pages 預設已自動，不需額外設定）。

---

## 6. 開發時的常用 macOS 指令小抄

| 任務                       | 指令                                                                   |
| -------------------------- | ---------------------------------------------------------------------- |
| 啟動本機 HTTP              | `npx http-server -p 8000 -c-1`                                         |
| 啟動本機 HTTPS             | `http-server -p 8443 -S -C localhost+2.pem -K localhost+2-key.pem`     |
| 查 Mac IP（Wi-Fi）         | `ipconfig getifaddr en0`                                               |
| 找佔用 8000 port 的程序    | `lsof -i :8000`                                                        |
| 終止某 PID                 | `kill -9 <pid>`                                                        |
| 監看 Apps Script log       | `clasp logs --watch`                                                   |
| 推 Code.gs                 | `clasp push`                                                           |
| 新增部署                   | `clasp deploy -d "說明"`                                               |
| 列出部署                   | `clasp deployments`                                                    |
| 強制清快取重新整理 Chrome  | ⌘ + ⇧ + R                                                              |
| Chrome DevTools 開應用頁籤 | F12 → Application → Service Workers / Storage                          |
| Safari DevTools            | ⌘ + ⌥ + I（需先開啟「顯示開發者功能」）                                |
| 解壓 zip                   | `unzip bp-pwa.zip -d ~/Projects/`                                      |
| 重新壓縮分享               | `cd ~/Projects && zip -r bp-pwa.zip bp-pwa -x "*.DS_Store"`            |

---

## 7. macOS 常見地雷

1. **Safari 顯示「無法建立安全連線」**
   → 本機 HTTPS 憑證未受信任。執行 `mkcert -install` 後重啟 Safari；或在 iPhone 安裝 root CA。

2. **Service Worker 卡舊版**
   → Chrome DevTools → Application → Service Workers → 勾「Update on reload」+「Bypass for network」；或直接 **Unregister** 再重新整理。
   → 正式環境改 `service-worker.js` 內 `CACHE = 'bp-pwa-v2'` 升版號。

3. **`clasp push` 報 `User has not enabled the Apps Script API`**
   → 到 [https://script.google.com/home/usersettings](https://script.google.com/home/usersettings) 把 API 切開。

4. **`clasp login` 一直跳回瀏覽器**
   → 終端機按 Ctrl+C 後重試；或 `clasp login --no-localhost` 改用裝置流程。

5. **iPhone 加到主畫面後打不開（白屏）**
   → 一定要先在「線上狀態」開過一次該網址，讓 SW 完成首次安裝快取。
   → 確認 `manifest.json` 內 `start_url` 為 `./index.html`（相對路徑），避免 GitHub Pages 子路徑出包。

6. **`http-server` 提示 EADDRINUSE**
   → `lsof -i :8000` 找出佔用，`kill -9 <pid>`，或改用其他 port。

7. **Mac 防火牆擋住 iPhone 連 Mac**
   → 系統設定 → 網路 → 防火牆 → 允許 `node` 接受傳入連線；或暫時關閉防火牆測試。

8. **企業/校園 Wi-Fi 隔離 Client**
   → 同 SSID 但裝置互不可見。改用 iPhone 個人熱點，讓 Mac 連 iPhone 熱點再開發。

---

## 8. 建議的日常開發節奏

```bash
# 終端機 1：本機 HTTPS server（給 iPhone 真機測）
cd ~/Projects/bp-pwa && http-server -p 8443 -S -C localhost+2.pem -K localhost+2-key.pem -c-1

# 終端機 2：Apps Script 即時 log
cd ~/Projects/bp-pwa/gas && clasp logs --watch

# VS Code：改 index.html / Code.gs
# 改完前端：iPhone Safari ⌘+R 即時看
# 改完 Code.gs：clasp push && clasp deploy --deploymentId <id> -d "patch"
```

完成上述環境後，您在 MacBook 上即可走完「**寫 → 真機測 → 部署 Apps Script → 上線 GitHub Pages**」的完整鏈路，全程在終端機與 VS Code 內完成。🎉
