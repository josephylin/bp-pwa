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
const SHARED_SECRET    = 'CHANGE_ME_to_a_random_string';

// 時段判定 (24h)
const MORNING_START = 5;   // 05:00
const MORNING_END   = 11;  // 11:00 (不含)
const EVENING_START = 18;  // 18:00
const EVENING_END   = 26;  // 02:00 隔日 (用 24+2 表達)

// 血壓達標門檻（家庭量測標準，依台灣高血壓學會 2022 指引）
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
    const now = new Date().toISOString();

    records.forEach(function(r) {
      const cid = String(r.clientId || '').trim();
      if (!cid) return;
      if (existingIds[cid]) { skipped.push(cid); return; }

      const dt = new Date(r.recordedAt || now);
      const session = r.session || _detectSession(dt);
      // pairIndex 由前端送，若沒給就在這裡推算
      const pairIndex = r.pairIndex || _nextPairIndex(sheet, dt, session);

      rows.push([
        r.recordedAt || now, session, pairIndex,
        Number(r.systolic) || '', Number(r.diastolic) || '',
        r.pulse ? Number(r.pulse) : '',
        r.arm || '', r.position || '', r.note || '',
        cid, now
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
  const range = params.range || 'week';
  const days = range === 'month' ? 30 : (range === 'all' ? 9999 : 7);
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - days + 1);
  cutoff.setHours(0,0,0,0);

  const sh = _getOrCreateSheet();
  const last = sh.getLastRow();
  if (last < 2) return { ok:true, range, daily:[], summary:_emptySummary() };

  const data = sh.getRange(2, 1, last - 1, HEADERS.length).getValues();
  const byDay = {}; // date -> { morning:[{s,d,p}], evening:[{s,d,p}] }

  data.forEach(function(row) {
    const dt = new Date(row[0]);
    if (isNaN(dt) || dt < cutoff) return;
    const dateKey = Utilities.formatDate(dt, Session.getScriptTimeZone(), 'yyyy-MM-dd');
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
    return {
      date,
      morningSBP:mAvg.s, morningDBP:mAvg.d, morningPulse:mAvg.p, morningCount:m.length,
      eveningSBP:evAvg.s, eveningDBP:evAvg.d, eveningPulse:evAvg.p, eveningCount:ev.length,
      dailySBP, dailyDBP,
      morningSurge: (mAvg.s && evAvg.s) ? (mAvg.s - evAvg.s) : null,
      targetMet: (dailySBP !== null && dailyDBP !== null && dailySBP < TARGET_SBP && dailyDBP < TARGET_DBP)
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

  const summary = {
    count: data.length,
    totalDays: daily.length,
    avgMorningSBP: sumOf(daily, 'morningSBP'),
    avgMorningDBP: sumOf(daily, 'morningDBP'),
    avgEveningSBP: sumOf(daily, 'eveningSBP'),
    avgEveningDBP: sumOf(daily, 'eveningDBP'),
    avgDailySBP:   sumOf(daily, 'dailySBP'),
    avgDailyDBP:   sumOf(daily, 'dailyDBP'),
    maxSBP: maxOf(daily, 'dailySBP'),
    minSBP: minOf(daily, 'dailySBP'),
    avgMorningSurge: sumOf(daily, 'morningSurge'),
    targetMetDays: daily.filter(function(d){return d.targetMet;}).length,
    targetMetRate: daily.length ? Math.round(daily.filter(function(d){return d.targetMet;}).length / daily.length * 100) : 0,
    targetSBP: TARGET_SBP,
    targetDBP: TARGET_DBP
  };

  return { ok:true, range, generatedAt:new Date().toISOString(), summary, daily };
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
  const dateKey = Utilities.formatDate(dt, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const data = sheet.getRange(2, 1, last - 1, 3).getValues(); // recordedAt, session, pairIndex
  let max = 0;
  data.forEach(function(r) {
    const rd = new Date(r[0]);
    if (isNaN(rd)) return;
    const rk = Utilities.formatDate(rd, Session.getScriptTimeZone(), 'yyyy-MM-dd');
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
    const key = Utilities.formatDate(dt, Session.getScriptTimeZone(), 'yyyy-MM-dd') + '|' + item.r[1];
    counters[key] = (counters[key] || 0) + 1;
    item.r[2] = counters[key];
  });

  sh.getRange(2, 1, data.length, HEADERS.length).setValues(data);
}
