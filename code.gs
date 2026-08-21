// --- BHR.LAB V2 CONFIG ---
// V2 intentionally does NOT auto-create a database. Run initializeBhrV2Config()
// once in this Apps Script project to bind it to the existing production folder
// and spreadsheet. The IDs are stored in Script Properties after that.
const FOLDER_NAME = "BHR.LAB";
const DB_FILENAME = "BHR_Database";
const TIMEZONE = "GMT+7";

const SHEET_VISITOR = "Visitor_Log";
const SHEET_TEMP = "Temp_Parking";
const SHEET_LICENSE = "License_Plate_DB";
const SHEET_OWNER = "Owner_DB";

const PROP_FOLDER_ID = 'BHR_FOLDER_ID';
const PROP_SPREADSHEET_ID = 'BHR_SPREADSHEET_ID';

function initializeBhrV2Config() {
  const props = PropertiesService.getScriptProperties();
  const existingFolderId = props.getProperty(PROP_FOLDER_ID);
  const existingSpreadsheetId = props.getProperty(PROP_SPREADSHEET_ID);
  if (existingFolderId && existingSpreadsheetId) {
    const ss = SpreadsheetApp.openById(existingSpreadsheetId);
    const folder = DriveApp.getFolderById(existingFolderId);
    Logger.log('BHR V2 already configured. Folder: %s | Spreadsheet: %s', folder.getId(), ss.getId());
    return { success: true, folderId: folder.getId(), spreadsheetId: ss.getId(), alreadyConfigured: true };
  }

  const folders = DriveApp.getFoldersByName(FOLDER_NAME);
  if (!folders.hasNext()) {
    throw new Error('ไม่พบโฟลเดอร์ ' + FOLDER_NAME + ' จึงหยุดเพื่อป้องกันการสร้างฐานข้อมูลใหม่โดยไม่ตั้งใจ');
  }
  const folder = folders.next();
  const files = folder.getFilesByName(DB_FILENAME);
  if (!files.hasNext()) {
    throw new Error('ไม่พบไฟล์ ' + DB_FILENAME + ' ในโฟลเดอร์ ' + FOLDER_NAME + ' จึงหยุดเพื่อป้องกันการสร้างฐานข้อมูลใหม่โดยไม่ตั้งใจ');
  }
  const file = files.next();
  const ss = SpreadsheetApp.openById(file.getId());
  props.setProperties({ [PROP_FOLDER_ID]: folder.getId(), [PROP_SPREADSHEET_ID]: ss.getId() }, true);
  Logger.log('BHR V2 configured. Folder: %s | Spreadsheet: %s', folder.getId(), ss.getId());
  return { success: true, folderId: folder.getId(), spreadsheetId: ss.getId(), alreadyConfigured: false };
}

function getBhrConfig_() {
  const props = PropertiesService.getScriptProperties();
  const folderId = props.getProperty(PROP_FOLDER_ID);
  const spreadsheetId = props.getProperty(PROP_SPREADSHEET_ID);
  if (!folderId || !spreadsheetId) {
    throw new Error('ยังไม่ได้ผูกฐานข้อมูล V2: กรุณารัน initializeBhrV2Config() ใน Apps Script ก่อน');
  }
  return { folderId, spreadsheetId };
}

function getConnectDB() {
  const cfg = getBhrConfig_();
  try {
    return SpreadsheetApp.openById(cfg.spreadsheetId);
  } catch (e) {
    throw new Error('ไม่สามารถเข้าถึง Google Sheet ฐานข้อมูลเดิมได้: ' + e.message);
  }
}

function getImageFolder_() {
  const cfg = getBhrConfig_();
  try {
    return DriveApp.getFolderById(cfg.folderId);
  } catch (e) {
    throw new Error('ไม่สามารถเข้าถึงโฟลเดอร์รูปภาพเดิมได้: ' + e.message);
  }
}

// ==========================================
// --- API ROUTER ---
// ==========================================

const WRITE_ACTIONS = new Set([
  'saveRecordImage', 'saveEntry', 'saveExit',
  'addManualTempEntry', 'updateTempEntry', 'updateTempImage', 'deleteTempEntry',
  'addLicensePlate', 'updateLicensePlate', 'deleteLicensePlate',
  'addOwner', 'updateOwner', 'deleteOwner'
]);

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  return jsonResponse_({ success: true, online: true, service: 'BHR.LAB API V2', timestamp: new Date().toISOString() });
}

function doPost(e) {
  var output = {};
  var action = '';
  var requestId = '';
  var lock = null;
  try {
    if (!e || !e.postData || !e.postData.contents) throw new Error('Missing request body');
    var data = JSON.parse(e.postData.contents);
    action = data.action || '';
    requestId = data.requestId || ('BHRV2-SRV-' + Date.now());
    var payload = data.payload;

    // Only serialize writes. Reads remain concurrent and fast.
    if (WRITE_ACTIONS.has(action)) {
      lock = LockService.getScriptLock();
      if (!lock.tryLock(30000)) throw new Error('ระบบกำลังบันทึกข้อมูลจากผู้ใช้อื่นอยู่ กรุณาลองใหม่อีกครั้ง (request ' + requestId + ')');
    }

    switch(action) {
      case 'saveRecordImage': output = saveRecordImage(payload); break;
      case 'quickSearchVehicle': output = quickSearchVehicle(payload); break;
      case 'getParkingStatus': output = getParkingStatus(payload); break;
      case 'saveEntry': output = saveEntry(payload); break;
      case 'saveExit': output = saveExit(payload); break;
      case 'getHistory': output = getHistory(); break;
      case 'getAccountingReport': output = getAccountingReport(payload.start, payload.end); break;
      case 'getAllTempData': output = getAllTempData(); break;
      case 'addManualTempEntry': output = addManualTempEntry(payload); break;
      case 'updateTempEntry': output = updateTempEntry(payload); break;
      case 'updateTempImage': output = updateTempImage(payload); break;
      case 'deleteTempEntry': output = deleteTempEntry(payload); break;
      case 'getLicenseList': output = getLicenseList(); break;
      case 'addLicensePlate': output = addLicensePlate(payload); break;
      case 'updateLicensePlate': output = updateLicensePlate(payload); break;
      case 'deleteLicensePlate': output = deleteLicensePlate(payload); break;
      case 'getOwnerList': output = getOwnerList(); break;
      case 'addOwner': output = addOwner(payload); break;
      case 'updateOwner': output = updateOwner(payload); break;
      case 'deleteOwner': output = deleteOwner(payload); break;
      default: output = { success: false, message: 'Unknown action: ' + action };
    }
  } catch(error) {
    output = { success: false, message: error.message || String(error), requestId: requestId, action: action };
    console.error('BHR V2 API error', JSON.stringify(output));
  } finally {
    if (lock) lock.releaseLock();
  }
  if (output && typeof output === 'object' && !output.requestId) output.requestId = requestId;
  return jsonResponse_(output);
}

// ==========================================
// --- FUNCTIONALITY (Updated to use getConnectDB) ---
// ==========================================

// Helper Functions
function formatDateSafe(dateObj) {
  try { if (!dateObj || !(dateObj instanceof Date)) return "-"; return Utilities.formatDate(dateObj, TIMEZONE, "dd/MM/yyyy"); } catch (e) { return "-"; }
}
function formatTimeSafe(dateObj) {
  try { if (!dateObj || !(dateObj instanceof Date)) return "-"; return Utilities.formatDate(dateObj, TIMEZONE, "HH:mm"); } catch (e) { return "-"; }
}

// ------------------------------------------
// Feature: Search
// ------------------------------------------
function quickSearchVehicle(query) {
  if (!query) return { found: false, message: "กรุณากรอกข้อมูล" };
  query = query.toString().toLowerCase().trim();
  const ss = getConnectDB(); // เรียก DB อัตโนมัติ
  const results = [];
  
  const sheetLic = ss.getSheetByName(SHEET_LICENSE);
  if (sheetLic) {
    const data = sheetLic.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const plate = String(row[1]).toLowerCase();
      const room = String(row[2]).toLowerCase();
      if (plate.includes(query) || room.includes(query)) {
        results.push({
          source: 'รถสมาชิก (Member)', type: 'member', plate: row[1], room: row[2], name: row[3], phone: row[4], note: row[5], info: `สิทธิ์: ${row[8] || 1} คัน`
        });
      }
    }
  }

  const sheetTemp = ss.getSheetByName(SHEET_TEMP);
  if (sheetTemp) {
    const data = sheetTemp.getDataRange().getValues();
    const now = new Date();
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      let status = row[4];
      const endTime = row[5] ? new Date(row[5]) : null;
      if (endTime && now > endTime && status !== 'Completed' && status !== 'Cancelled') { status = 'Expired'; }
      if (status !== 'Deleted') {
        const plate = String(row[1]).toLowerCase();
        const room = String(row[2]).toLowerCase();
        if (plate.includes(query) || room.includes(query)) {
           let sourceName = 'จอดชั่วคราว (Temp)';
           if (!['Waiting', 'Parked'].includes(status)) { sourceName = 'ประวัติจอด (History)'; }
           results.push({
             source: sourceName, type: 'temp', plate: row[1], room: row[2], name: '-', phone: '-', note: `สถานะ: ${status}`, info: `ออก: ${formatDateSafe(endTime)} ${formatTimeSafe(endTime)}`
           });
        }
      }
    }
  }
  return { found: results.length > 0, results: results };
}

// ------------------------------------------
// Feature: Visitor
// ------------------------------------------
function saveEntry(data) {
  const ss = getConnectDB();
  let sheet = ss.getSheetByName(SHEET_VISITOR);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_VISITOR, 0);
    sheet.appendRow(["Entry Time", "Card ID", "Room No", "Plate Image", "Status", "Exit Time", "Duration", "Price", "Slip Image", "ID Card Image"]);
    sheet.getRange(1, 1, 1, 10).setFontWeight("bold").setBackground("#cfe2f3");
    sheet.setFrozenRows(1);
  }
  const activeRow = findActiveRow(sheet, data.cardId);
  if (activeRow !== -1) return { success: false, message: `บัตร ${data.cardId} ยังมีสถานะจอดอยู่` };
  
  let imgUrl = "";
  if (data.plateImg) {
    const timestamp = Utilities.formatDate(new Date(), TIMEZONE, "yyyyMMdd_HHmmss");
    imgUrl = saveImageToDrive(data.plateImg, `Plate_${data.cardId}_${timestamp}`);
  }
  
  sheet.appendRow([new Date(), "'" + data.cardId, "'" + data.roomNo, imgUrl, "Parked", "", "", "", "", ""]);
  return { success: true, message: "บันทึกรถเข้าเรียบร้อย" };
}

function getParkingStatus(cardId) {
  const ss = getConnectDB();
  const sheet = ss.getSheetByName(SHEET_VISITOR);
  if (!sheet) return { found: false, message: "ไม่พบฐานข้อมูล Visitor" };
  const data = sheet.getDataRange().getValues();
  let foundData = null;
  let foundRowIndex = -1;
  for (let r = data.length - 1; r >= 1; r--) {
    if (String(data[r][1]) === String(cardId) && data[r][4] === "Parked") {
      foundData = data[r];
      foundRowIndex = r + 1;
      break;
    }
  }
  if (!foundData) return { found: false, message: "ไม่พบข้อมูลรถที่จอดอยู่" };
  const entryTime = new Date(foundData[0]);
  const calc = calculateParkingFee(entryTime);
  return {
    found: true, sheetName: SHEET_VISITOR, rowIndex: foundRowIndex, cardId: foundData[1], roomNo: foundData[2],
    entryTime: formatDateSafe(entryTime) + " " + formatTimeSafe(entryTime),
    durationText: `${calc.hours} ชม. ${calc.minutes} นาที`, price: calc.price
  };
}

function saveExit(data) {
  const ss = getConnectDB();
  let sheet = ss.getSheetByName(data.sheetName || SHEET_VISITOR);
  if (!sheet) return { success: false, message: "ไม่พบฐานข้อมูล" };
  
  let slipUrl = "";
  if (data.slipImg) {
    const timestamp = Utilities.formatDate(new Date(), TIMEZONE, "yyyyMMdd_HHmmss");
    slipUrl = saveImageToDrive(data.slipImg, `Slip_${data.cardId}_${timestamp}`);
  }
  
  const row = data.rowIndex;
  sheet.getRange(row, 5).setValue("Completed");
  sheet.getRange(row, 6).setValue(new Date());  
  sheet.getRange(row, 7).setValue(data.durationText);
  sheet.getRange(row, 8).setValue(data.price);  
  sheet.getRange(row, 9).setValue(slipUrl);
  return { success: true, message: "บันทึกรถออกสำเร็จ" };
}

function saveRecordImage(data) {
  const ss = getConnectDB();
  const sheet = ss.getSheetByName(data.sheetName || SHEET_VISITOR);
  if (!sheet) return { success: false, message: "ไม่พบ Sheet ข้อมูล" };
  let colIndex = 0; let prefix = "";
  if (data.imageType === 'plate') { colIndex = 4; prefix = "Plate"; }
  else if (data.imageType === 'slip') { colIndex = 9; prefix = "Slip"; }
  else if (data.imageType === 'idcard' || data.imageType === 'id') { colIndex = 10; prefix = "ID"; }
  if (colIndex === 0) return { success: false, message: "ประเภทรูปไม่ถูกต้อง" };
  
  let imgUrl = "";
  if (data.base64) {
    const timestamp = Utilities.formatDate(new Date(), TIMEZONE, "yyyyMMdd_HHmmss");
    imgUrl = saveImageToDrive(data.base64, `${prefix}_${data.cardId}_${timestamp}`);
  }
  sheet.getRange(data.rowIndex, colIndex).setValue(imgUrl);
  return { success: true, message: "อัปเดตรูปภาพเรียบร้อย", url: imgUrl };
}

function getHistory() {
  const ss = getConnectDB();
  const sheet = ss.getSheetByName(SHEET_VISITOR);
  if (!sheet) return [];
  return fetchHistoryFromSheet(sheet, SHEET_VISITOR, 100);
}

// ------------------------------------------
// Feature: Temp Parking
// ------------------------------------------
function addManualTempEntry(form) {
  const ss = getConnectDB();
  let sheet = ss.getSheetByName(SHEET_TEMP);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_TEMP);
    sheet.appendRow(["Start Time", "License Plate", "Room No", "Plate Image", "Status", "End Time", "Duration", "Price", "Slip Image", "Extra Note", "ID Card Image"]);
    sheet.getRange(1, 1, 1, 11).setFontWeight("bold").setBackground("#fff2cc");
    sheet.setFrozenRows(1);
  }
  const startDateTime = new Date(`${form.startDate}T${form.startHour}:00:00`);
  const endDateTime = new Date(`${form.endDate}T${form.endHour}:00:00`);
  const now = new Date();
  let status = "Waiting";
  if (now >= startDateTime && now <= endDateTime) { status = "Parked"; } 
  else if (now > endDateTime) { status = "Expired"; }

  let imgUrl = "";
  if (form.plateImg) {
    const timestamp = Utilities.formatDate(new Date(), TIMEZONE, "yyyyMMdd_HHmmss");
    const id = form.room || form.plate || "Unknown";
    imgUrl = saveImageToDrive(form.plateImg, `Temp_${id}_${timestamp}`);
  }
  sheet.appendRow([startDateTime, "'" + form.plate, "'" + form.room, imgUrl, status, endDateTime, "", "", "", "", ""]);
  return { success: true, message: "เพิ่มข้อมูลเรียบร้อย" };
}

function updateTempImage(data) {
  const ss = getConnectDB();
  const sheet = ss.getSheetByName(SHEET_TEMP);
  if (!sheet) return { success: false, message: "ไม่พบฐานข้อมูล" };
  if (data.image) {
    const timestamp = Utilities.formatDate(new Date(), TIMEZONE, "yyyyMMdd_HHmmss");
    const id = data.room || "Unknown";
    const prefix = (data.type === 'idcard') ? 'TempID' : 'TempCar';
    const imgUrl = saveImageToDrive(data.image, `${prefix}_${id}_${timestamp}`);
    let colIndex = 4; if (data.type === 'idcard') colIndex = 11;
    sheet.getRange(data.rowIndex, colIndex).setValue(imgUrl);
    return { success: true, message: "อัปเดตรูปภาพเรียบร้อย", url: imgUrl };
  }
  return { success: false, message: "ไม่พบรูปภาพ" };
}

function updateTempEntry(data) {
  const ss = getConnectDB();
  const sheet = ss.getSheetByName(SHEET_TEMP);
  if (!sheet) return { success: false, message: "ไม่พบฐานข้อมูล" };
  sheet.getRange(data.rowIndex, 2).setValue("'" + data.plate);
  sheet.getRange(data.rowIndex, 3).setValue("'" + data.room);
  return { success: true, message: "บันทึกข้อมูลเรียบร้อย" };
}

function getAllTempData() {
  const ss = getConnectDB();
  const sheet = ss.getSheetByName(SHEET_TEMP);
  if (!sheet) return { active: [], history: [] };
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return { active: [], history: [] };
  const rows = data.slice(1);
  const now = new Date();
  const allItems = rows.map((row, index) => {
    const startTimeRaw = row[0];
    if (!startTimeRaw) return null;
    const startTime = new Date(startTimeRaw);
    const endTimeRaw = row[5];
    const endTime = endTimeRaw ? new Date(endTimeRaw) : null;
    let status = row[4];
    if (status !== 'Deleted' && status !== 'Cancelled') {
        if (endTime && now > endTime) status = 'Expired';
        else if (status === 'Waiting' && now >= startTime) status = 'Parked';
    }
    const startStr = formatDateSafe(startTime) + " " + formatTimeSafe(startTime);
    const endStr = endTime ? formatDateSafe(endTime) + " " + formatTimeSafe(endTime) : "-";
    return {
      rowIndex: index + 2, sheetName: SHEET_TEMP, startTimeDisplay: startStr, endTimeDisplay: endStr,
      plate: row[1] ? String(row[1]) : "-", room: row[2] ? String(row[2]) : "-",
      plateImg: row[3] || "", status: status, idCardImg: row[10] || "", rawSortTime: (startTime instanceof Date) ? startTime.getTime() : 0
    };
  }).filter(item => item !== null && item.status !== 'Deleted');
  const activeItems = allItems.filter(item => ['Waiting', 'Parked'].includes(item.status));
  activeItems.sort((a, b) => a.rawSortTime - b.rawSortTime);
  const historyItems = allItems.filter(item => ['Completed', 'Expired', 'Cancelled'].includes(item.status));
  historyItems.sort((a, b) => b.rawSortTime - a.rawSortTime);
  return { active: activeItems, history: historyItems.slice(0, 30) };
}

function deleteTempEntry(rowIndex) {
  const ss = getConnectDB();
  const sheet = ss.getSheetByName(SHEET_TEMP);
  if (!sheet) return { success: false, message: "Sheet not found" };
  sheet.getRange(rowIndex, 5).setValue("Cancelled");
  return { success: true, message: "ยกเลิกรายการเรียบร้อย" };
}

// ------------------------------------------
// Feature: License Plate
// ------------------------------------------
function addLicensePlate(form) {
  const ss = getConnectDB();
  let sheet = ss.getSheetByName(SHEET_LICENSE);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_LICENSE);
    sheet.appendRow(["Timestamp", "License Plate", "Room No", "Owner Name", "Phone", "Note", "Car Image", "Status", "Parking Rights"]);
    sheet.getRange(1, 1, 1, 9).setFontWeight("bold").setBackground("#d9ead3");
    sheet.setFrozenRows(1);
  }
  let imgUrl = "";
  if (form.plateImg) {
    const timestamp = Utilities.formatDate(new Date(), TIMEZONE, "yyyyMMdd_HHmmss");
    imgUrl = saveImageToDrive(form.plateImg, `Lic_${form.plate}_${timestamp}`);
  }
  sheet.appendRow([ new Date(), "'" + form.plate, "'" + form.room, "'" + form.name, "'" + form.phone, "'" + (form.note || ""), imgUrl, "Active", "'" + (form.rights || "1") ]);
  return { success: true, message: "ลงทะเบียนรถเรียบร้อย" };
}

function getLicenseList() {
  const ss = getConnectDB();
  const sheet = ss.getSheetByName(SHEET_LICENSE);
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  const rows = data.slice(1);
  return rows.map((row, index) => ({
    id: index + 2, plate: row[1] ? String(row[1]) : "-", room: row[2] ? String(row[2]) : "-", name: row[3] ? String(row[3]) : "", phone: row[4] ? String(row[4]) : "", note: row[5] ? String(row[5]) : "", img: row[6], rights: row[8] ? String(row[8]) : "1"
  })).reverse();
}

function updateLicensePlate(data) {
  const ss = getConnectDB();
  const sheet = ss.getSheetByName(SHEET_LICENSE);
  if (!sheet) return { success: false, message: "ไม่พบฐานข้อมูล" };
  const rowIndex = parseInt(data.id);
  sheet.getRange(rowIndex, 2).setValue("'" + data.plate);
  sheet.getRange(rowIndex, 3).setValue("'" + data.room);
  sheet.getRange(rowIndex, 4).setValue("'" + data.name);
  sheet.getRange(rowIndex, 5).setValue("'" + data.phone);
  sheet.getRange(rowIndex, 6).setValue("'" + data.note);
  sheet.getRange(rowIndex, 9).setValue("'" + (data.rights || "1"));
  if (data.img) {
    const timestamp = Utilities.formatDate(new Date(), TIMEZONE, "yyyyMMdd_HHmmss");
    const imgUrl = saveImageToDrive(data.img, `Lic_Update_${data.plate}_${timestamp}`);
    if (imgUrl) sheet.getRange(rowIndex, 7).setValue(imgUrl);
  }
  return { success: true, message: "แก้ไขข้อมูลเรียบร้อย" };
}

function deleteLicensePlate(rowIndex) {
  const ss = getConnectDB();
  const sheet = ss.getSheetByName(SHEET_LICENSE);
  if (!sheet) return { success: false, message: "Sheet not found" };
  sheet.deleteRow(rowIndex);
  return { success: true, message: "ลบข้อมูลเรียบร้อย" };
}

// ------------------------------------------
// Feature: Owner
// ------------------------------------------
function addOwner(form) {
  const ss = getConnectDB();
  let sheet = ss.getSheetByName(SHEET_OWNER);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_OWNER);
    sheet.appendRow(["Timestamp", "Room No", "Owner Name", "Floor", "Size", "Phone 1", "Phone 2", "Note", "Status"]);
    sheet.getRange(1, 1, 1, 9).setFontWeight("bold").setBackground("#f4cccc");
    sheet.setFrozenRows(1);
  }
  sheet.appendRow([ new Date(), "'" + form.room, "'" + form.name, "'" + form.floor, "'" + form.size, "'" + form.phone1, "'" + form.phone2, "'" + (form.note || ""), "Active" ]);
  return { success: true, message: "เพิ่มรายชื่อเจ้าของเรียบร้อย" };
}

function getOwnerList() {
  const ss = getConnectDB();
  const sheet = ss.getSheetByName(SHEET_OWNER);
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  const rows = data.slice(1);
  return rows.map((row, index) => ({
    id: index + 2, room: row[1] ? String(row[1]) : "-", name: row[2] ? String(row[2]) : "", floor: row[3] ? String(row[3]) : "", size: row[4] ? String(row[4]) : "", phone1: row[5] ? String(row[5]) : "", phone2: row[6] ? String(row[6]) : "", note: row[7] ? String(row[7]) : ""
  })).reverse();
}

function updateOwner(data) {
  const ss = getConnectDB();
  const sheet = ss.getSheetByName(SHEET_OWNER);
  if (!sheet) return { success: false, message: "ไม่พบฐานข้อมูล" };
  const rowIndex = parseInt(data.id);
  sheet.getRange(rowIndex, 2).setValue("'" + data.room);
  sheet.getRange(rowIndex, 3).setValue("'" + data.name);
  sheet.getRange(rowIndex, 4).setValue("'" + data.floor);
  sheet.getRange(rowIndex, 5).setValue("'" + data.size);
  sheet.getRange(rowIndex, 6).setValue("'" + data.phone1);
  sheet.getRange(rowIndex, 7).setValue("'" + data.phone2);
  sheet.getRange(rowIndex, 8).setValue("'" + data.note);
  return { success: true, message: "แก้ไขข้อมูลเรียบร้อย" };
}

function deleteOwner(rowIndex) {
  const ss = getConnectDB();
  const sheet = ss.getSheetByName(SHEET_OWNER);
  if (!sheet) return { success: false, message: "Sheet not found" };
  sheet.deleteRow(rowIndex);
  return { success: true, message: "ลบข้อมูลเรียบร้อย" };
}

// ------------------------------------------
// Feature: Accounting
// ------------------------------------------
function getAccountingReport(startDateStr, endDateStr) {
  const ss = getConnectDB();
  const sheet = ss.getSheetByName("Visitor_Log");
  if (!sheet) return { success: false, message: "ไม่พบฐานข้อมูล Visitor" };
  const start = new Date(startDateStr); start.setHours(0, 0, 0, 0);
  const end = new Date(endDateStr); end.setHours(23, 59, 59, 999);
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return { success: true, summary: { totalCars: 0, totalPrice: 0 }, details: [] };
  const rows = data.slice(1);
  const reportData = [];
  let totalCars = 0; let totalPrice = 0;
  rows.forEach(row => {
    const exitTimeRaw = row[5];
    const status = row[4];
    const priceRaw = row[7];
    if (exitTimeRaw && status === 'Completed') {
      const exitTime = new Date(exitTimeRaw);
      if (exitTime >= start && exitTime <= end) {
        const price = parseFloat(priceRaw) || 0;
        totalCars++; totalPrice += price;
        reportData.push({
            entryTime: formatDateSafe(new Date(row[0])) + " " + formatTimeSafe(new Date(row[0])),
            exitTime: formatDateSafe(exitTime) + " " + formatTimeSafe(exitTime),
            cardId: row[1], roomNo: row[2], duration: row[6], price: price, plateImg: row[3] || "", slipImg: row[8] || "", idCardImg: row[9] || ""
        });
      }
    }
  });
  reportData.sort((a, b) => new Date(b.exitTime).getTime() - new Date(a.exitTime).getTime());
  return { success: true, summary: { totalCars: totalCars, totalPrice: totalPrice, startDate: formatDateSafe(start), endDate: formatDateSafe(end) }, details: reportData };
}

// Helpers
function fetchHistoryFromSheet(sheet, sheetNameForObj, limit) {
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  const rows = data.slice(1);
  const allRecords = rows.map((row, index) => {
    const entryTime = new Date(row[0]);
    const exitTime = row[5] ? new Date(row[5]) : null;
    return {
      sheetName: sheetNameForObj, rowIndex: index + 2,
      entryDateDisplay: formatDateSafe(entryTime), exitDateDisplay: formatDateSafe(exitTime),
      entryTime: formatTimeSafe(entryTime), exitTime: formatTimeSafe(exitTime),
      cardId: row[1], roomNo: row[2], plateImg: row[3] || '', status: row[4],
      price: row[7] || '-', slipImg: row[8] || '', idCardImg: row[9] || '',
      rawSortTime: entryTime.getTime(), rawExitTime: exitTime ? exitTime.getTime() : 0 
    };
  });
  const parkedCars = allRecords.filter(item => item.status === 'Parked');
  const completedCars = allRecords.filter(item => item.status !== 'Parked');
  parkedCars.sort((a, b) => b.rawSortTime - a.rawSortTime);
  completedCars.sort((a, b) => b.rawExitTime - a.rawExitTime);
  return [...parkedCars, ...completedCars].slice(0, limit);
}
function calculateParkingFee(start) {
  const end = new Date();
  const diffMs = end - start;
  const totalMinutes = Math.floor(diffMs / 60000);
  let totalHours = Math.floor(totalMinutes / 60);
  if (totalMinutes % 60 > 15) totalHours += 1;
  if (totalHours <= 0 && totalMinutes % 60 <= 15) return { price: 0, hours: 0, minutes: totalMinutes };
  let totalPrice = 0; let currentCyclePrice = 0;
  for (let i = 1; i <= totalHours; i++) {
    const checkTime = new Date(start.getTime() + (i - 1) * 3600000);
    const h = checkTime.getHours();
    let rate = (i===1) ? 0 : (h>=9 && h<18 ? 10 : 30);
    currentCyclePrice += rate;
    if (currentCyclePrice > 150) currentCyclePrice = 150;
    if (((i - 1) % 24) + 1 === 24) { totalPrice += currentCyclePrice; currentCyclePrice = 0; }
  }
  totalPrice += currentCyclePrice;
  return { price: totalPrice, hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
}
function findActiveRow(sheet, cardId) {
  const data = sheet.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][1]) === String(cardId) && data[i][4] === "Parked") return i + 1;
  }
  return -1;
}
function saveImageToDrive(base64Data, fileName) {
  try {
    const split = base64Data.split('base64,');
    const contentType = split[0].split(':')[1].split(';')[0];
    const blob = Utilities.newBlob(Utilities.base64Decode(split[1]), contentType, fileName);
    
    // V2 always uses the explicitly bound existing folder; never silently creates a new DB folder.
    const folder = getImageFolder_();
    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return "https://drive.google.com/thumbnail?id=" + file.getId() + "&sz=w1000";
  } catch (e) { return ""; }
}
