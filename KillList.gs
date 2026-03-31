// ============================================================
//  THRESHOLD MANAGEMENT TOOL — Kill List Apps Script
//  Separate deployment from the Threshold Comparison script
// ============================================================

const KILL_SHEET_ID   = '1Eq5luSB6j-NNucgl-FaRNwfA35VeNHGNI-xUTVzUMdg';
const TAB_ALL_SKU2    = 'ALL SKU2';
const KILL_CACHE_FILE = 'kill_list_cache.json';
const EXCLUDE_FILE    = 'kill_list_excluded.json';

// ── SERVE ────────────────────────────────────────────────────
function doGet(e) {
  const callback = e && e.parameter && e.parameter.callback;
  const action   = e && e.parameter && e.parameter.action;
  let json;

  try {
    if (action === 'data') {
      json = getKillCache();
    } else if (action === 'exclude') {
      const sku  = e.parameter.sku  || '';
      const mode = e.parameter.mode || 'add'; // add | remove
      json = JSON.stringify(updateExcluded(sku, mode));
    } else if (action === 'getExcluded') {
      json = getExcludedFile();
    } else {
      json = getKillCache();
    }
  } catch(err) {
    json = JSON.stringify({ ok: false, error: err.message });
  }

  if (callback) {
    return ContentService
      .createTextOutput(callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

// ── GET CACHE ────────────────────────────────────────────────
function getKillCache() {
  const files = DriveApp.getFilesByName(KILL_CACHE_FILE);
  if (!files.hasNext()) {
    rebuildKillCache();
    const f2 = DriveApp.getFilesByName(KILL_CACHE_FILE);
    if (!f2.hasNext()) return JSON.stringify({ ok: false, error: 'Cache not built yet.' });
    return f2.next().getBlob().getDataAsString();
  }
  return files.next().getBlob().getDataAsString();
}

function saveKillCache(json) {
  const files = DriveApp.getFilesByName(KILL_CACHE_FILE);
  if (files.hasNext()) files.next().setContent(json);
  else DriveApp.createFile(KILL_CACHE_FILE, json, MimeType.PLAIN_TEXT);
}

// ── EXCLUDED FILE ─────────────────────────────────────────────
function getExcludedFile() {
  const files = DriveApp.getFilesByName(EXCLUDE_FILE);
  if (!files.hasNext()) return JSON.stringify({ ok: true, excluded: [] });
  return files.next().getBlob().getDataAsString();
}

function updateExcluded(sku, mode) {
  if (!sku) return { ok: false, error: 'No SKU provided' };
  let excluded = [];
  try {
    const parsed = JSON.parse(getExcludedFile());
    excluded = parsed.excluded || [];
  } catch(e) { excluded = []; }

  if (mode === 'add') {
    if (!excluded.includes(sku)) excluded.push(sku);
  } else {
    excluded = excluded.filter(s => s !== sku);
  }

  const payload = JSON.stringify({ ok: true, excluded });
  const files = DriveApp.getFilesByName(EXCLUDE_FILE);
  if (files.hasNext()) files.next().setContent(payload);
  else DriveApp.createFile(EXCLUDE_FILE, payload, MimeType.PLAIN_TEXT);

  return { ok: true, excluded };
}

// ── REBUILD CACHE ─────────────────────────────────────────────
function rebuildKillCache() {
  Logger.log('rebuildKillCache() started');

  const sheet = getSheet(KILL_SHEET_ID, TAB_ALL_SKU2);
  const data  = sheet.getDataRange().getValues();

  // Row 1,2 = metadata, Row 3 = headers, data starts row 4
  // A=SKU, B=ProductType, C=ParentName, D=Size, E=WHSE_INV
  // F=TotalCompanyOH, G=POOnOrder, H=PO_ETA, I=Size%
  // J=SizesOnHand, K=TotalSizesPerProduct, L=LastRestockDate
  // M=OptimalStock, N=THRESHOLD, O=ExistsInThreshold, P=DaysToArrive

  const headers = data[2]; // row 3 (0-indexed row 2)
  Logger.log('Headers: ' + headers.join(', '));

  const rows = data.slice(3); // data from row 4
  Logger.log('Total data rows: ' + rows.length);

  // Build SKU rows
  const skuRows = [];
  rows.forEach(r => {
    const sku = String(r[0]||'').trim();
    if (!sku) return;
    skuRows.push({
      sku,
      productType:    String(r[1]||'').trim(),
      parentName:     String(r[2]||'').trim(),
      size:           String(r[3]||'').trim(),
      whseInv:        parseFloat(r[4]) || 0,
      companyOH:      parseFloat(r[5]) || 0,
      poOnOrder:      parseFloat(r[6]) || 0,
      poETA:          r[7] ? String(r[7]).trim() : '',
      sizePct:        parseFloat(r[8]) || 0,
      sizesOnHand:    parseFloat(r[9]) || 0,
      totalSizes:     parseFloat(r[10])|| 0,
      lastRestock:    r[11] ? String(r[11]).trim() : '',
      optimalStock:   parseFloat(r[12])|| 0,
      threshold:      parseFloat(r[13])|| 0,
      existsInThresh: String(r[14]||'').trim(),
      daysToArrive:   r[15] !== '' && r[15] !== null ? parseFloat(r[15]) : null
    });
  });

  // Group by parent name
  const parentMap = {};
  skuRows.forEach(row => {
    const p = row.parentName || row.sku;
    if (!parentMap[p]) parentMap[p] = [];
    parentMap[p].push(row);
  });

  // Compute parent-level metrics
  const parents = Object.entries(parentMap).map(([parentName, skus]) => {
    const count = skus.length;

    // Size % — average across all SKUs
    const avgSizePct = skus.reduce((s,r)=>s+r.sizePct,0) / count;

    // Company OH — sum / count (average)
    const avgCompanyOH = skus.reduce((s,r)=>s+r.companyOH,0) / count;

    // Days to arrive — use min of all non-null values; null only if ALL are blank
    const validDays = skus.map(r => r.daysToArrive).filter(d => d !== null && d !== '' && !isNaN(d));
    const daysToArrive = validDays.length > 0 ? Math.min(...validDays) : null;

    // Exists in threshold — Yes if any SKU exists
    const existsInThresh = skus.some(r => r.existsInThresh.toLowerCase() === 'yes') ? 'Yes' : 'No';

    // Product type — from first SKU
    const productType = skus[0].productType;

    return {
      parentName,
      productType,
      skus,
      avgSizePct:    Math.round(avgSizePct * 10) / 10,
      avgCompanyOH:  Math.round(avgCompanyOH * 10) / 10,
      daysToArrive,
      existsInThresh,
      count
    };
  });

  Logger.log('Parents built: ' + parents.length);

  const payload = JSON.stringify({ ok: true, updated: new Date().toISOString(), parents });
  saveKillCache(payload);
  Logger.log('Kill cache saved. Parents: ' + parents.length);
}

// ── TRIGGERS ─────────────────────────────────────────────────
function setupKillTriggers() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'rebuildKillCache')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('rebuildKillCache')
    .timeBased().atHour(8).nearMinute(45).everyDays(1).create();

  ScriptApp.newTrigger('rebuildKillCache')
    .timeBased().atHour(20).nearMinute(45).everyDays(1).create();

  Logger.log('Kill List triggers set: 8:45 AM and 8:45 PM daily');
}

// ── HELPERS ──────────────────────────────────────────────────
function getSheet(sheetId, tabName) {
  const ss  = SpreadsheetApp.openById(sheetId);
  const tab = ss.getSheetByName(tabName);
  if (!tab) throw new Error('Tab "' + tabName + '" not found in ' + sheetId);
  return tab;
}

function clearKillCache() {
  const files = DriveApp.getFilesByName(KILL_CACHE_FILE);
  while (files.hasNext()) files.next().setTrashed(true);
  Logger.log('Kill cache cleared.');
}

function testKill() {
  rebuildKillCache();
  const result = JSON.parse(getKillCache());
  Logger.log('ok: ' + result.ok);
  Logger.log('Parents: ' + (result.parents ? result.parents.length : 0));
  if (result.parents && result.parents.length > 0) {
    Logger.log('First parent: ' + JSON.stringify(result.parents[0]));
  }
}
