/**
 * 血壓紀錄 PWA v2 — Google Apps Script 後端
 * ============================================================
 * v2 變更：
 *   1) 新增 session (morning/evening/other) 與 pairIndex 欄位
 *   2) doGet(?action=stats&range=week|month) 提供分析資料
 *   3) doGet(?action=list&limit=N) 提供前端對齊用清單
 *   4) 自動配對：同日同 session 內依 recordedAt 排序給 pairIndex 1/2/3...
 *   5) 寫入時自動計算每日早晚平均並寫到「每日彙整」工作表
 *
 * 維持不變：
 *   - 不需 GCP 專案 / OAuth scope
 *   - 用 text/plain 規避 CORS preflight
 *   - SHARED_SECRET 保護寫入
 *
 * ⚠ 從 v1 升級：請執行 migrateFromV1() 一次性補上 session/pairIndex 欄位
 */

// ============ 設定 ============
const SHEET_NAME       = '血壓紀錄';
const SUMMARY_SHEET    = '每日彙整';
const SHARED_SECRET    = 'CHANGE_LIN_to_a_random_string';

// ⏰ 時區：所有寫入 Sheet 的時間都以此為準（不受 Apps Script 預設或試算表時區影響）
//    台灣請保留 'Asia/Taipei'；如出差到日本可暫時改為 'Asia/Tokyo'
const TIMEZONE = 'Asia/Taipei';
const TIME_FMT = 'yyyy-MM-dd HH:mm:ss';

/** 把任意 Date / ISO 字串轉成「台北時區」的字串 yyyy-MM-dd HH:mm:ss
 *  防呆版：時區字串寫死，不依賴任何全域常數；同時 fallback 用手動 +8 計算 */
function _fmtTime(input) {
  const d = (input instanceof Date) ? input : new Date(input || Date.now());
  try {
    const out = Utilities.formatDate(d, 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
    if (out && out.length === 19) return out;
  } catch (e) { /* fallthrough to manual */ }
  // 手動 fallback：絕對不受 Apps Script 環境影響
  const tp = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const pad = function(n) { return (n < 10 ? '0' : '') + n; };
  return tp.getUTCFullYear() + '-' + pad(tp.getUTCMonth() + 1) + '-' + pad(tp.getUTCDate()) +
         ' ' + pad(tp.getUTCHours()) + ':' + pad(tp.getUTCMinutes()) + ':' + pad(tp.getUTCSeconds());
}
/** 取台北時區的 yyyy-MM-dd 日期鍵 */
function _dateKey(input) {
  return _fmtTime(input).substring(0, 10);
}

/** 診斷函式：手動執行，看下面各種時區輸出，貼給我 */
function _debugTimezone() {
  const now = new Date();
  Logger.log('1. toISOString (UTC):       ' + now.toISOString());
  Logger.log('2. _fmtTime (期望台北):    ' + _fmtTime(now));
  Logger.log('3. 寫死 Asia/Taipei:        ' + Utilities.formatDate(now, 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss'));
  Logger.log('4. 試算表時區:              ' + SpreadsheetApp.getActive().getSpreadsheetTimeZone());
  Logger.log('5. Apps Script 時區:        ' + Session.getScriptTimeZone());
  Logger.log('6. 由 ISO 轉回顯示:          ' + new Date(now.toISOString()).toString());
}

// 時段判定 (24h)
const MORNING_START = 5;   // 05:00
const MORNING_END   = 11;  // 11:00 (不含)
const EVENING_START = 18;  // 18:00
const EVENING_END   = 26;  // 02:00 隔日 (用 24+2 表達)

// 血壓達標門檻（家庭量測標準，依台灣高血壓學會 2022 指引）
// 達標定義：日均 SBP ≦ 130 且 DBP ≦ 80
const TARGET_SBP = 130;
const TARGET_DBP = 80;
// =============================

const HEADERS = [
  'recordedAt', 'session', 'pairIndex',
  'systolic', 'diastolic', 'pulse',
  'arm', 'position', 'note',
  'clientId', 'syncedAt'
];

const SUMMARY_HEADERS = [
  'date',
  'morningSBP', 'morningDBP', 'morningPulse', 'morningCount',
  'eveningSBP', 'eveningDBP', 'eveningPulse', 'eveningCount',
  'dailySBP',   'dailyDBP',
  'morningSurge',          // 晨峰 = morningSBP - eveningSBP
  'targetMet'              // 兩個時段平均皆 < 目標 → TRUE
];

/* ============ 入口 ============ */

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'ping';
  try {
    if (action === 'ping')  return _json({ ok:true, service:'bp-pwa', version:'v2', time:new Date().toISOString() });
    if (action === 'stats') return _json(_buildStats(e.parameter));
    if (action === 'list')  return _json(_buildList(e.parameter));
    return _json({ ok:false, error:'UNKNOWN_ACTION' });
  } catch (err) {
    return _json({ ok:false, error:String(err && err.message || err) });
  }
}

function doPost(e) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(20 * 1000);
  try {
    if (!e || !e.postData || !e.postData.contents) return _json({ ok:false, error:'NO_BODY' });
    const body = JSON.parse(e.postData.contents);
    if (!body.secret || body.secret !== SHARED_SECRET) return _json({ ok:false, error:'UNAUTHORIZED' });

    const records = Array.isArray(body.records) ? body.records
                  : (body.record ? [body.record] : []);
    if (records.length === 0) return _json({ ok:false, error:'NO_RECORDS' });

    const sheet = _getOrCreateSheet();
    const existingIds = _getExistingClientIds(sheet);
    const accepted = [], skipped = [], rows = [];
    const nowDate = new Date();
    const nowStr  = _fmtTime(nowDate);   // 台北時區字串

    records.forEach(function(r) {
      const cid = String(r.clientId || '').trim();
      if (!cid) return;
      if (existingIds[cid]) { skipped.push(cid); return; }

      const dt = r.recordedAt ? new Date(r.recordedAt) : nowDate;
      const session = r.session || _detectSession(dt);
      // pairIndex 由前端送，若沒給就在這裡推算
      const pairIndex = r.pairIndex || _nextPairIndex(sheet, dt, session);

      rows.push([
        _fmtTime(dt),               // ✅ 以 Asia/Taipei 寫入，避免 Sheet 二次解讀時區
        session, pairIndex,
        Number(r.systolic) || '', Number(r.diastolic) || '',
        r.pulse ? Number(r.pulse) : '',
        r.arm || '', r.position || '', r.note || '',
        cid,
        nowStr                      // ✅ 同上
      ]);
      accepted.push(cid);
      existingIds[cid] = true;
    });

    if (rows.length > 0) {
      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, HEADERS.length).setValues(rows);
      _rebuildSummary();  // 每次寫入後重算「每日彙整」
    }

    return _json({ ok:true, acceptedIds:accepted, skippedIds:skipped, count:accepted.length });
  } catch (err) {
    return _json({ ok:false, error:String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch(_) {}
  }
}

/* ============ 分析 API ============ */

/**
 * GET ?action=stats&range=week|month|all
 * 回傳：{
 *   ok, range, generatedAt,
 *   summary: { count, avgMorningSBP, avgMorningDBP, avgEveningSBP, avgEveningDBP,
 *              avgDailySBP, avgDailyDBP, maxSBP, minSBP, targetMetDays, totalDays,
 *              targetMetRate, avgMorningSurge },
 *   daily:   [ { date, morningSBP, morningDBP, eveningSBP, eveningDBP, dailySBP, dailyDBP, targetMet } ... ]
 * }
 */
function _buildStats(params) {
  // 支援三種區間指定方式：
  //   1) range=week|month|all（舊接口）
  //   2) from=YYYY-MM-DD & to=YYYY-MM-DD（新：自訂區間）
  //   3) 兩者同存時以 from/to 為主
  const range = params.range || 'week';
  let cutoffFrom, cutoffTo;
  if (params.from || params.to) {
    cutoffFrom = params.from ? _parseDateOnly(params.from, false) : new Date(1970,0,1);
    cutoffTo   = params.to   ? _parseDateOnly(params.to,   true)  : _parseDateOnly(Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd'), true);
  } else {
    const days = range === 'month' ? 30 : (range === 'all' ? 9999 : 7);
    cutoffFrom = new Date(); cutoffFrom.setDate(cutoffFrom.getDate() - days + 1);
    cutoffFrom.setHours(0,0,0,0);
    cutoffTo = new Date(); cutoffTo.setHours(23,59,59,999);
  }

  const sh = _getOrCreateSheet();
  const last = sh.getLastRow();
  if (last < 2) return { ok:true, range, from:Utilities.formatDate(cutoffFrom,TIMEZONE,'yyyy-MM-dd'), to:Utilities.formatDate(cutoffTo,TIMEZONE,'yyyy-MM-dd'), daily:[], summary:_emptySummary() };

  const data = sh.getRange(2, 1, last - 1, HEADERS.length).getValues();
  const byDay = {}; // date -> { morning:[{s,d,p}], evening:[{s,d,p}] }

  data.forEach(function(row) {
    const dt = _parseTime(row[0]);
    if (!dt || dt < cutoffFrom || dt > cutoffTo) return;
    const dateKey = Utilities.formatDate(dt, TIMEZONE, 'yyyy-MM-dd');
    const session = row[1];
    const s = Number(row[3]), d = Number(row[4]), p = Number(row[5]);
    if (!s || !d) return;
    if (session !== 'morning' && session !== 'evening') return;

    if (!byDay[dateKey]) byDay[dateKey] = { morning:[], evening:[] };
    byDay[dateKey][session].push({ s, d, p });
  });

  const daily = Object.keys(byDay).sort().map(function(date) {
    const m = byDay[date].morning, ev = byDay[date].evening;
    const mAvg  = _avg(m);
    const evAvg = _avg(ev);
    const dailySBP = (mAvg.s && evAvg.s) ? Math.round((mAvg.s + evAvg.s)/2) : (mAvg.s || evAvg.s || null);
    const dailyDBP = (mAvg.d && evAvg.d) ? Math.round((mAvg.d + evAvg.d)/2) : (mAvg.d || evAvg.d || null);
    const dailyPulse = (mAvg.p && evAvg.p) ? Math.round((mAvg.p + evAvg.p)/2) : (mAvg.p || evAvg.p || null);
    // 完整日：早晚兩段都有量，可供嚴格達標率及晨峰計算
    const isComplete = (mAvg.s !== null && evAvg.s !== null);
    return {
      date,
      morningSBP:mAvg.s, morningDBP:mAvg.d, morningPulse:mAvg.p, morningCount:m.length,
      eveningSBP:evAvg.s, eveningDBP:evAvg.d, eveningPulse:evAvg.p, eveningCount:ev.length,
      dailySBP, dailyDBP, dailyPulse,
      isComplete,
      morningSurge: isComplete ? (mAvg.s - evAvg.s) : null,
      // 達標：「小於或等於」130/80（台灣高血壓學會 2022）
      targetMet: (dailySBP !== null && dailyDBP !== null && dailySBP <= TARGET_SBP && dailyDBP <= TARGET_DBP),
      // 心跳達標：那一日的日均心跳在 60–100 bpm（AHA 靜息心率）
      pulseMet:  (dailyPulse !== null && dailyPulse >= 60 && dailyPulse <= 100)
    };
  });

  // 彙總
  const sumOf = function(arr, key) {
    const vs = arr.map(function(x){return x[key];}).filter(function(v){return typeof v === 'number';});
    if (vs.length === 0) return null;
    return Math.round(vs.reduce(function(a,b){return a+b;}, 0) / vs.length);
  };
  const maxOf = function(arr, key) {
    const vs = arr.map(function(x){return x[key];}).filter(function(v){return typeof v === 'number';});
    return vs.length ? Math.max.apply(null, vs) : null;
  };
  const minOf = function(arr, key) {
    const vs = arr.map(function(x){return x[key];}).filter(function(v){return typeof v === 'number';});
    return vs.length ? Math.min.apply(null, vs) : null;
  };

  // 静息心跳參考範圍：60–100 bpm（成人）
  const PULSE_LOW = 60, PULSE_HIGH = 100;
  const dailyPulseValues = daily.map(function(d){return d.dailyPulse;}).filter(function(v){return typeof v === 'number';});
  const pulseInRangeDays = dailyPulseValues.filter(function(v){return v >= PULSE_LOW && v <= PULSE_HIGH;}).length;

  // 紀錄筆數——只算這個期間中實際屬於早晨/晚間的量測筆數（daily 已經過期間過濾）
  // 不使用 data.length（那是整張試算表的列數，包含全部歷史資料）
  const rangeRecordCount = daily.reduce(function(sum, d) {
    return sum + (d.morningCount || 0) + (d.eveningCount || 0);
  }, 0);

  const summary = {
    count: rangeRecordCount,
    totalDays: daily.length,
    avgMorningSBP: sumOf(daily, 'morningSBP'),
    avgMorningDBP: sumOf(daily, 'morningDBP'),
    avgEveningSBP: sumOf(daily, 'eveningSBP'),
    avgEveningDBP: sumOf(daily, 'eveningDBP'),
    avgDailySBP:   sumOf(daily, 'dailySBP'),
    avgDailyDBP:   sumOf(daily, 'dailyDBP'),
    avgMorningPulse: sumOf(daily, 'morningPulse'),
    avgEveningPulse: sumOf(daily, 'eveningPulse'),
    avgDailyPulse:   sumOf(daily, 'dailyPulse'),
    maxSBP: maxOf(daily, 'dailySBP'),
    minSBP: minOf(daily, 'dailySBP'),
    maxPulse: maxOf(daily, 'dailyPulse'),
    minPulse: minOf(daily, 'dailyPulse'),
    pulseInRangeDays: pulseInRangeDays,
    pulseDays: dailyPulseValues.length,
    pulseLow: PULSE_LOW,
    pulseHigh: PULSE_HIGH,
    avgMorningSurge: sumOf(daily, 'morningSurge'),
    // 達標率：提供「嚴格」與「寬鬆」兩種口徑
    //   strict: 只計完整量測日（早晚都有）
    //   loose:  計所有有量測的日子（原本行為）
    completeDays:    daily.filter(function(d){return d.isComplete;}).length,
    partialDays:     daily.filter(function(d){return !d.isComplete;}).length,
    targetMetDays:        daily.filter(function(d){return d.targetMet && d.isComplete;}).length,
    targetMetDaysLoose:   daily.filter(function(d){return d.targetMet;}).length,
    targetMetRate:        (function(){ var c = daily.filter(function(d){return d.isComplete;}).length; return c ? Math.round(daily.filter(function(d){return d.targetMet && d.isComplete;}).length / c * 100) : 0; })(),
    targetMetRateLoose:   daily.length ? Math.round(daily.filter(function(d){return d.targetMet;}).length / daily.length * 100) : 0,
    // 心跳達標率（與血壓達標率平行，同樣提供嚴格/寬鬆兩口徑）
    pulseMetDays:         daily.filter(function(d){return d.pulseMet && d.isComplete;}).length,
    pulseMetDaysLoose:    daily.filter(function(d){return d.pulseMet;}).length,
    pulseMetRate:         (function(){ var c = daily.filter(function(d){return d.isComplete;}).length; return c ? Math.round(daily.filter(function(d){return d.pulseMet && d.isComplete;}).length / c * 100) : 0; })(),
    pulseMetRateLoose:    daily.length ? Math.round(daily.filter(function(d){return d.pulseMet;}).length / daily.length * 100) : 0,
    targetSBP: TARGET_SBP,
    targetDBP: TARGET_DBP
  };

  return {
    ok:true, range,
    from: Utilities.formatDate(cutoffFrom, TIMEZONE, 'yyyy-MM-dd'),
    to:   Utilities.formatDate(cutoffTo,   TIMEZONE, 'yyyy-MM-dd'),
    generatedAt: new Date().toISOString(),
    summary, daily
  };
}

/* 容錯解析：接受 Date / ISO / 'yyyy-MM-dd HH:mm:ss' / 'yyyy/MM/dd HH:mm:ss' */
function _parseTime(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  const s = String(v).trim();
  // 先試 ISO、再試 'YYYY-MM-DD HH:mm:ss' 表達式
  const m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})[ T](\d{1,2}):(\d{1,2}):(\d{1,2})/);
  if (m) {
    // 以 TIMEZONE 本地時間解讀：透過 Utilities.parseDate 避免 UTC 偏移
    try {
      return Utilities.parseDate(
        m[1]+'-'+_pad(m[2])+'-'+_pad(m[3])+' '+_pad(m[4])+':'+_pad(m[5])+':'+_pad(m[6]),
        TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
    } catch (e) { /* fallthrough */ }
  }
  const d = new Date(s);
  return isNaN(d) ? null : d;
}
function _pad(n) { return String(n).length === 1 ? '0'+n : String(n); }

/* 接受 'YYYY-MM-DD'，回傳本時区 00:00 (start) 或 23:59:59 (end) */
function _parseDateOnly(s, isEnd) {
  const m = String(s).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return isEnd ? new Date(2999,0,1) : new Date(1970,0,1);
  const tag = m[1]+'-'+_pad(m[2])+'-'+_pad(m[3])+' '+(isEnd?'23:59:59':'00:00:00');
  return Utilities.parseDate(tag, TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
}

function _emptySummary() {
  return { count:0, totalDays:0, targetMetDays:0, targetMetRate:0,
           targetSBP:TARGET_SBP, targetDBP:TARGET_DBP };
}

function _buildList(params) {
  const limit = Math.min(Number(params.limit) || 50, 500);
  const sh = _getOrCreateSheet();
  const last = sh.getLastRow();
  if (last < 2) return { ok:true, records:[] };
  const start = Math.max(2, last - limit + 1);
  const rows = sh.getRange(start, 1, last - start + 1, HEADERS.length).getValues();
  return { ok:true, records: rows.map(function(r){
    var o = {}; HEADERS.forEach(function(h,i){ o[h] = r[i]; }); return o;
  })};
}

/* ============ 每日彙整工作表 ============ */

function _rebuildSummary() {
  const stats = _buildStats({ range:'all' });
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SUMMARY_SHEET);
  if (!sh) sh = ss.insertSheet(SUMMARY_SHEET);
  sh.clear();
  sh.getRange(1, 1, 1, SUMMARY_HEADERS.length).setValues([SUMMARY_HEADERS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  if (stats.daily.length === 0) return;
  const rows = stats.daily.map(function(d) {
    return [d.date, d.morningSBP, d.morningDBP, d.morningPulse, d.morningCount,
            d.eveningSBP, d.eveningDBP, d.eveningPulse, d.eveningCount,
            d.dailySBP, d.dailyDBP, d.morningSurge, d.targetMet];
  });
  sh.getRange(2, 1, rows.length, SUMMARY_HEADERS.length).setValues(rows);
}

/* ============ 工具 ============ */

function _avg(arr) {
  if (!arr || arr.length === 0) return { s:null, d:null, p:null };
  // 兩次量測取平均（醫療常規）；若超過兩次也取所有平均
  const sum = arr.reduce(function(acc, x) {
    return { s:acc.s+x.s, d:acc.d+x.d, p:acc.p+(x.p||0), pn:acc.pn+(x.p?1:0) };
  }, { s:0, d:0, p:0, pn:0 });
  return {
    s: Math.round(sum.s / arr.length),
    d: Math.round(sum.d / arr.length),
    p: sum.pn ? Math.round(sum.p / sum.pn) : null
  };
}

function _detectSession(dt) {
  const h = dt.getHours();
  if (h >= MORNING_START && h < MORNING_END) return 'morning';
  if (h >= EVENING_START || h < (EVENING_END - 24)) return 'evening';
  return 'other';
}

/** 推算當日同 session 下一個 pairIndex（用於前端沒帶來時的 fallback） */
function _nextPairIndex(sheet, dt, session) {
  const last = sheet.getLastRow();
  if (last < 2) return 1;
  const dateKey = Utilities.formatDate(dt, TIMEZONE, 'yyyy-MM-dd');
  const data = sheet.getRange(2, 1, last - 1, 3).getValues(); // recordedAt, session, pairIndex
  let max = 0;
  data.forEach(function(r) {
    const rd = new Date(r[0]);
    if (isNaN(rd)) return;
    const rk = Utilities.formatDate(rd, TIMEZONE, 'yyyy-MM-dd');
    if (rk === dateKey && r[1] === session) {
      const n = Number(r[2]) || 0;
      if (n > max) max = n;
    }
  });
  return max + 1;
}

function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function _getOrCreateSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  } else if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function _getExistingClientIds(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return {};
  const idCol = HEADERS.indexOf('clientId') + 1;
  const ids = sheet.getRange(2, idCol, last - 1, 1).getValues();
  const map = {};
  for (let i = 0; i < ids.length; i++) {
    const v = String(ids[i][0] || '').trim();
    if (v) map[v] = true;
  }
  return map;
}

/* ============ 維護工具（在編輯器手動執行）============ */

/** 首次安裝/升級時手動執行一次 */
function setupSheet() {
  _getOrCreateSheet();
  _rebuildSummary();
}

/**
 * 🔧 一次性修護：把已存在的 recordedAt / syncedAt 欄位
 * 重新格式化為 TIMEZONE（例如 Asia/Taipei）的 yyyy-MM-dd HH:mm:ss。
 * 適用時機：之前寫入的資料在 Sheet 上顕示時間有誤（差 8 小時、UTC、烘組 ISO 字串等）。
 * 執行方式：Apps Script 編輯器 → 選 fixTimezoneInExistingRows → 執行。
 */
function fixTimezoneInExistingRows() {
  const sh = _getOrCreateSheet();
  const last = sh.getLastRow();
  if (last < 2) { Logger.log('沒有資料需要修護'); return; }

  const headerRow = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const colRecorded = headerRow.indexOf('recordedAt') + 1;   // 1-based
  const colSynced   = headerRow.indexOf('syncedAt') + 1;
  if (colRecorded < 1) { Logger.log('找不到 recordedAt 欄'); return; }

  const recValues = sh.getRange(2, colRecorded, last - 1, 1).getValues();
  const newRec = recValues.map(function(row) {
    const v = row[0];
    if (!v) return [''];
    // 如果已是 yyyy-MM-dd HH:mm:ss 按台北時區重格；Date 物件也能吃
    const d = (v instanceof Date) ? v : new Date(v);
    if (isNaN(d.getTime())) return [String(v)];   // 無法解讀就保留原樣
    return [_fmtTime(d)];
  });
  sh.getRange(2, colRecorded, last - 1, 1).setValues(newRec);

  if (colSynced > 0) {
    const synValues = sh.getRange(2, colSynced, last - 1, 1).getValues();
    const newSyn = synValues.map(function(row) {
      const v = row[0];
      if (!v) return [''];
      const d = (v instanceof Date) ? v : new Date(v);
      if (isNaN(d.getTime())) return [String(v)];
      return [_fmtTime(d)];
    });
    sh.getRange(2, colSynced, last - 1, 1).setValues(newSyn);
  }

  // 讓儲存格按「純文字」顯示，避免 Sheet 再把它当成日期重新解讀
  sh.getRange(2, colRecorded, last - 1, 1).setNumberFormat('@');
  if (colSynced > 0) sh.getRange(2, colSynced, last - 1, 1).setNumberFormat('@');

  _rebuildSummary();
  Logger.log('已修護 ' + (last - 1) + ' 筆資料的時間為 ' + TIMEZONE);
}

/**
 * 從 v1 升級：補上 session / pairIndex 欄位
 * v1 欄位：recordedAt, systolic, diastolic, pulse, arm, position, note, clientId, syncedAt
 * v2 欄位：recordedAt, session, pairIndex, systolic, diastolic, pulse, arm, position, note, clientId, syncedAt
 */
function migrateFromV1() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) { Logger.log('找不到工作表，請先 setupSheet()'); return; }

  const header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  if (header.indexOf('session') !== -1) { Logger.log('已是 v2 格式，無需遷移'); return; }

  // 插入兩個新欄位於 recordedAt 之後 (B, C)
  sh.insertColumnsAfter(1, 2);
  sh.getRange(1, 2, 1, 2).setValues([['session', 'pairIndex']]).setFontWeight('bold');

  const last = sh.getLastRow();
  if (last < 2) return;

  // 讀取 recordedAt 並回填 session
  const dates = sh.getRange(2, 1, last - 1, 1).getValues();
  const sessions = dates.map(function(r) {
    const dt = new Date(r[0]);
    return [isNaN(dt) ? 'other' : _detectSession(dt), 1]; // pairIndex 暫設 1，下方重算
  });
  sh.getRange(2, 2, sessions.length, 2).setValues(sessions);

  // 依日期+session 重算 pairIndex
  _recomputePairIndex();
  _rebuildSummary();
  Logger.log('遷移完成');
}

/** 重新計算所有 pairIndex（依 recordedAt 時間升序） */
function _recomputePairIndex() {
  const sh = _getOrCreateSheet();
  const last = sh.getLastRow();
  if (last < 2) return;
  const data = sh.getRange(2, 1, last - 1, HEADERS.length).getValues();
  const counters = {}; // key: yyyy-MM-dd|session -> n
  const indexed = data
    .map(function(r, i) { return { i, r, t: new Date(r[0]).getTime() || 0 }; })
    .sort(function(a,b){ return a.t - b.t; });

  indexed.forEach(function(item) {
    const dt = new Date(item.r[0]);
    const key = Utilities.formatDate(dt, TIMEZONE, 'yyyy-MM-dd') + '|' + item.r[1];
    counters[key] = (counters[key] || 0) + 1;
    item.r[2] = counters[key];
  });

  sh.getRange(2, 1, data.length, HEADERS.length).setValues(data);
}
