/**
 * Plant Log backend — runs as you, inside your own Google account.
 * Stores app data in a Google Sheet ("Plant Log — Data") and photos in Drive ("Plant Log/Photos").
 *
 * One-time setup: paste this file into a new Apps Script project, run `setup`, then
 * Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).
 */

var TABLES = ['locations', 'plants', 'feeds', 'schedules', 'events', 'trips', 'photos'];

function props() { return PropertiesService.getScriptProperties(); }

function setup() {
  var p = props();
  var root, ss, photos;
  if (p.getProperty('SS_ID')) {
    ss = SpreadsheetApp.openById(p.getProperty('SS_ID'));
    root = DriveApp.getFolderById(p.getProperty('ROOT_ID'));
  } else {
    root = DriveApp.createFolder('Plant Log');
    photos = root.createFolder('Photos');
    ss = SpreadsheetApp.create('Plant Log — Data');
    DriveApp.getFileById(ss.getId()).moveTo(root);
    p.setProperties({ SS_ID: ss.getId(), ROOT_ID: root.getId(), PHOTOS_ID: photos.getId() });
  }
  TABLES.forEach(function (t) { sheetFor(ss, t); });
  ss.getSheets().forEach(function (sh) {
    if (TABLES.indexOf(sh.getName()) < 0 && sh.getLastRow() === 0) ss.deleteSheet(sh);
  });
  var key = p.getProperty('KEY');
  if (!key) { key = Utilities.getUuid().replace(/-/g, ''); p.setProperty('KEY', key); }
  Logger.log('APP KEY (paste this into the app): ' + key);
  Logger.log('Data sheet: ' + ss.getUrl());
  Logger.log('Drive folder: ' + root.getUrl());
}

function sheetFor(ss, t) {
  var sh = ss.getSheetByName(t);
  if (!sh) {
    sh = ss.insertSheet(t);
    sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).setNumberFormat('@');
    sh.getRange(1, 1).setValue('id');
    sh.setFrozenRows(1);
  }
  return sh;
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() { return out({ ok: true, app: 'Plant Log backend' }); }

function doPost(e) {
  var req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: 'bad_json' }); }
  var p = props();
  if (!p.getProperty('KEY')) return out({ ok: false, error: 'not_setup' });
  if (req.key !== p.getProperty('KEY')) return out({ ok: false, error: 'bad_key' });
  try {
    var ss = SpreadsheetApp.openById(p.getProperty('SS_ID'));
    var root = DriveApp.getFolderById(p.getProperty('ROOT_ID'));
    switch (req.action) {
      case 'ping': return out({ ok: true, sheetUrl: ss.getUrl(), folderUrl: root.getUrl() });
      case 'pull': return out({ ok: true, tables: pullAll(ss), sheetUrl: ss.getUrl(), folderUrl: root.getUrl() });
      case 'push': return withLock(function () { pushAll(ss, req.tables || {}); return out({ ok: true }); });
      case 'upload': return withLock(function () { return out(upload(req)); });
      case 'thumbs': return out({ ok: true, files: readFiles(req.ids || []) });
      default: return out({ ok: false, error: 'unknown_action' });
    }
  } catch (err) {
    return out({ ok: false, error: String(err && err.message || err) });
  }
}

function withLock(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function pullAll(ss) {
  var res = {};
  TABLES.forEach(function (t) {
    var sh = sheetFor(ss, t);
    var lr = sh.getLastRow(), lc = sh.getLastColumn();
    if (lr < 2) { res[t] = []; return; }
    var vals = sh.getRange(1, 1, lr, lc).getDisplayValues();
    var head = vals[0];
    res[t] = vals.slice(1).filter(function (r) { return r[0]; }).map(function (r) {
      var o = {};
      head.forEach(function (h, i) { if (h && r[i] !== '') o[h] = r[i]; });
      return o;
    });
  });
  return res;
}

function cell(v) {
  if (v == null) return '';
  v = String(v);
  return /^[=+]/.test(v) ? "'" + v : v;
}

function pushAll(ss, tables) {
  Object.keys(tables).forEach(function (t) {
    if (TABLES.indexOf(t) < 0) return;
    var recs = tables[t];
    if (!recs || !recs.length) return;
    var sh = sheetFor(ss, t);
    var lr = Math.max(sh.getLastRow(), 1), lc = Math.max(sh.getLastColumn(), 1);
    var head = sh.getRange(1, 1, 1, lc).getDisplayValues()[0];
    if (!head[0]) head = ['id'];
    // Add any new fields as columns.
    recs.forEach(function (r) { Object.keys(r).forEach(function (k) { if (head.indexOf(k) < 0) head.push(k); }); });
    ensureSize(sh, lr + recs.length, head.length);
    sh.getRange(1, 1, 1, head.length).setNumberFormat('@').setValues([head]);

    var ids = lr > 1 ? sh.getRange(2, 1, lr - 1, 1).getDisplayValues().map(function (r) { return r[0]; }) : [];
    var rowOf = {};
    ids.forEach(function (id, i) { if (id) rowOf[id] = i + 2; });

    var appends = [];
    recs.forEach(function (r) {
      var row = head.map(function (h) { return cell(r[h]); });
      if (rowOf[r.id]) {
        sh.getRange(rowOf[r.id], 1, 1, head.length).setNumberFormat('@').setValues([row]);
      } else {
        rowOf[r.id] = lr + appends.length + 1;
        appends.push(row);
      }
    });
    if (appends.length) sh.getRange(lr + 1, 1, appends.length, head.length).setNumberFormat('@').setValues(appends);
  });
}

function ensureSize(sh, rows, cols) {
  if (sh.getMaxRows() < rows) sh.insertRowsAfter(sh.getMaxRows(), rows - sh.getMaxRows() + 100);
  if (sh.getMaxColumns() < cols) sh.insertColumnsAfter(sh.getMaxColumns(), cols - sh.getMaxColumns());
}

function plantFolder(plantId, plantName) {
  var p = props();
  var photosRoot = DriveApp.getFolderById(p.getProperty('PHOTOS_ID'));
  var key = 'F_' + plantId;
  var id = p.getProperty(key), f = null;
  if (id) { try { f = DriveApp.getFolderById(id); } catch (e) { f = null; } }
  if (!f) {
    f = photosRoot.createFolder(plantName || plantId);
    p.setProperty(key, f.getId());
  } else if (plantName && f.getName() !== plantName) {
    f.setName(plantName);
  }
  return f;
}

function subFolder(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function upload(req) {
  var folder = plantFolder(req.plantId, req.plantName);
  var thumbs = subFolder(folder, '_thumbs');
  var name = req.date + '_' + req.photoId + '.jpg';
  var full = findOrCreate(folder, name, req.full);
  var thumb = findOrCreate(thumbs, name, req.thumb);
  return { ok: true, fileId: full.getId(), thumbId: thumb.getId() };
}

// Re-sending the same photo (e.g. after a dropped connection) reuses the existing file.
function findOrCreate(folder, name, b64) {
  var it = folder.getFilesByName(name);
  if (it.hasNext()) return it.next();
  return folder.createFile(Utilities.newBlob(Utilities.base64Decode(b64), 'image/jpeg', name));
}

function readFiles(ids) {
  var outFiles = {};
  ids.slice(0, 20).forEach(function (id) {
    try { outFiles[id] = Utilities.base64Encode(DriveApp.getFileById(id).getBlob().getBytes()); } catch (e) { }
  });
  return outFiles;
}
