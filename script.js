// ==========================================
// --- 0. API CONFIG & ROBUST HELPER (V2) ---
// ==========================================
// IMPORTANT: After creating the V2 Google Apps Script Web App, put its /exec URL
// in config.js. This keeps the V2 endpoint separate from the production system.
const API_URL = (typeof BHR_API_URL !== 'undefined') ? BHR_API_URL : '';
const BHR_APP_VERSION = (window.BHR_APP_VERSION || '1.0.10');
const API_TIMEOUT_MS = 35000;
const API_READ_RETRIES = 1;
const API_READ_ACTIONS = new Set([
    'getParkingStatus', 'getHistory', 'getAccountingReport', 'getAllTempData',
    'getLicenseList', 'getOwnerList', 'quickSearchVehicle'
]);
let appReady = false;
let appInitializing = false;
let currentAppSubPage = 'menu';
let isSubmittingEntry = false;
let isSubmittingExit = false;
let lastSuccessfulDataRefresh = null;

function makeRequestId() {
    return 'BHRV2-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function getApiUrl() {
    if (!API_URL || API_URL.indexOf('PASTE_') === 0) {
        throw new Error('ยังไม่ได้ตั้งค่า Google Apps Script V2 URL ใน config.js');
    }
    return API_URL;
}

async function fetchApiOnce(action, payload, requestId) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
        const response = await fetch(getApiUrl(), {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ action, payload, requestId }),
            signal: controller.signal,
            cache: 'no-store'
        });

        const raw = await response.text();
        const contentType = response.headers.get('content-type') || '';
        let data;
        try {
            data = JSON.parse(raw);
        } catch (parseError) {
            const preview = raw.replace(/\s+/g, ' ').slice(0, 180);
            const htmlHint = /^\s*<!doctype|^\s*<html/i.test(raw) ? 'เซิร์ฟเวอร์ส่ง HTML กลับมาแทน JSON' : 'เซิร์ฟเวอร์ส่งข้อมูลที่ไม่ใช่ JSON';
            throw new Error(`${htmlHint} (HTTP ${response.status}, request ${requestId})${preview ? ': ' + preview : ''}`);
        }

        if (!response.ok) {
            throw new Error((data && data.message) || `HTTP ${response.status} (request ${requestId})`);
        }
        if (!data || typeof data !== 'object') {
            throw new Error(`รูปแบบข้อมูลจากเซิร์ฟเวอร์ไม่ถูกต้อง (request ${requestId})`);
        }
        return data;
    } finally {
        clearTimeout(timer);
    }
}

async function runApi(action, payload = null, options = {}) {
    const isRead = API_READ_ACTIONS.has(action);
    const retries = options.retries ?? (isRead ? API_READ_RETRIES : 0);
    const silent = options.silent === true;
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
        const requestId = makeRequestId();
        try {
            const data = await fetchApiOnce(action, payload, requestId);
            if (data && data.success === false && options.throwOnServerError) {
                throw new Error(data.message || `Server rejected request ${requestId}`);
            }
            return data;
        } catch (error) {
            lastError = error;
            console.error(`API Error [${action}] attempt ${attempt + 1}/${retries + 1}:`, error);
            if (attempt < retries) await new Promise(r => setTimeout(r, 700 * (attempt + 1)));
        }
    }

    if (!silent) {
        const message = lastError?.message || 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้';
        alert('เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์:\n' + message);
    }
    toggleLoading(false);
    return null;
}

function updateConnectionStatus(state, detail = '') {
    const dot = document.getElementById('connectionStatusDot');
    const text = document.getElementById('connectionStatusText');
    if (!dot || !text) return;
    const states = {
        online: ['bg-emerald-500', 'เชื่อมต่อระบบแล้ว'],
        offline: ['bg-rose-500', 'ออฟไลน์ — ตรวจสอบอินเทอร์เน็ต'],
        loading: ['bg-amber-400', 'กำลังเชื่อมต่อระบบ…'],
        error: ['bg-rose-500', 'เชื่อมต่อระบบไม่สำเร็จ']
    };
    const item = states[state] || states.loading;
    dot.className = 'w-2.5 h-2.5 rounded-full shrink-0 ' + item[0];
    text.textContent = detail || item[1];
}

function markDataRefreshSuccess() {
    lastSuccessfulDataRefresh = new Date();
    const el = document.getElementById('lastDataRefreshText');
    if (el) el.textContent = 'อัปเดตล่าสุด ' + lastSuccessfulDataRefresh.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
    updateConnectionStatus('online');
}

function hapticFeedback(pattern = 10) {
    try {
        if (navigator.vibrate) navigator.vibrate(pattern);
    } catch (e) {}
}

async function manualRefreshApp() {
    if (appInitializing) return;
    hapticFeedback(10);
    closeSettings();
    appReady = false;
    appInitializing = false;
    await initializeAppV2(true);
    if (appReady && currentAppSubPage !== 'menu') {
        openAppSubPage(currentAppSubPage);
    }
}

function initNetworkStatus() {
    const update = () => updateConnectionStatus(navigator.onLine ? 'online' : 'offline');
    window.addEventListener('online', () => {
        updateConnectionStatus('loading');
        if (!appInitializing) manualRefreshApp();
    });
    window.addEventListener('offline', () => updateConnectionStatus('offline'));
    update();
}

async function initializeAppV2(force = false) {
    if (appInitializing || (appReady && !force)) return;

    // Home is the primary working screen for security staff. Never block it
    // while the background data request is connecting.
    appReady = true;
    setAppReadyUI(true);
    appInitializing = true;
    updateConnectionStatus('loading');

    try {
        // Refresh Home data in the background. The Home UI and card-entry action
        // remain available immediately while this request is in flight.
        const res = await runApi('getAllTempData', null, { silent: true, retries: 1 });
        if (!res || res.success === false) throw new Error(res?.message || 'API ยังไม่พร้อม');
        localStorage.setItem('tempParkingData', JSON.stringify(res));
        renderHomeTempStatus(res);
        markDataRefreshSuccess();
    } catch (error) {
        // Do not lock the Home screen when the background refresh fails.
        // Individual actions will still request the backend when needed.
        updateConnectionStatus('error', 'เชื่อมต่อข้อมูลไม่สำเร็จ — Home ยังใช้งานได้');
        console.warn('Background Home data refresh failed:', error);
    } finally {
        appInitializing = false;
        setAppReadyUI(true);
    }
}

function setAppReadyUI(ready, message = '') {
    // Startup must never block Home. Keep the legacy overlay hidden for
    // compatibility with existing markup and retry handlers.
    const overlay = document.getElementById('appReadyOverlay');
    if (overlay) overlay.classList.add('hidden');
}

// ==========================================
// --- 1. CONFIG & SETUP ---
// ==========================================
// ==========================================
if (typeof tailwind !== 'undefined') {
    tailwind.config = {
        theme: {
            extend: {
                colors: {
                    ios: { red: '#FF3B30', bg: '#F2F2F7', blue: '#007AFF', green: '#34C759' }
                },
                fontFamily: { sans: ['Sarabun', 'sans-serif'] }
            }
        }
    }
}

// ตัวแปร Global
let currentMode = 'visitor';

// เก็บข้อมูล
let tempActiveData = [];
let tempHistoryData = [];
let currentTempList = [];
let currentTempTab = 'active';

let historyData = [];
let currentHistoryList = [];

let licenseData = [];
let currentLicenseList = [];

let ownerData = [];
let currentOwnerList = [];

// Desktop Navigation State
let desktopNavOrder = ['history', 'temp', 'license', 'owner']; // Default order
const navItemConfig = {
    'history': { label: 'ผู้มาติดต่อ', icon: 'history', color: 'indigo' },
    'temp': { label: 'ชั่วคราว', icon: 'clock', color: 'orange' },
    'license': { label: 'ทะเบียน', icon: 'car', color: 'emerald' },
    'owner': { label: 'เจ้าของ', icon: 'users', color: 'rose' }
};

// ตัวแปรระบบ
let html5QrCode;
let cameraStream = null;
let targetPhotoType = '';

let currentRecord = null;
let currentPlateImg = null;
let currentSlipImg = null;
let tempAddPlateImg = null;
let licenseEditImg = null;
let licenseAddImg = null;

let isHistoryEditMode = false;
let selectedHistoryIndex = -1;
let isTempEditMode = false;

// Security
const ADMIN_PIN = '123';
const AI_PIN = '199';
let pendingPinAction = null;
let pinCheckMode = 'admin';
let currentAccData = null;

// ==========================================
// --- 2. UTILITY FUNCTIONS ---
// ==========================================
function fixDriveLink(url) { return url || ""; }

function toggleLoading(show) {
    const loader = document.getElementById('loader');
    if (loader) loader.classList.toggle('hidden', !show);
}

function showAlert(title, message, type = 'success') {
    document.getElementById('alertTitle').innerText = title;
    document.getElementById('alertMessage').innerText = message;
    const icon = document.getElementById('alertIcon');
    if (type === 'success') {
        icon.className = "fas fa-check-circle text-6xl text-green-500 mb-4 drop-shadow-md";
    } else {
        icon.className = "fas fa-exclamation-circle text-6xl text-red-500 mb-4 drop-shadow-md";
    }
    document.getElementById('alertModal').classList.remove('hidden');
    document.getElementById('alertModal').classList.add('flex');
}

function closeAlert() {
    document.getElementById('alertModal').classList.add('hidden');
    document.getElementById('alertModal').classList.remove('flex');
}

let confirmCallback = null;
function showConfirm(title, message, onConfirm) {
    document.getElementById('confirmTitle').innerText = title;
    document.getElementById('confirmMessage').innerText = message;
    confirmCallback = onConfirm;
    document.getElementById('confirmModal').classList.remove('hidden');
    document.getElementById('confirmModal').classList.add('flex');
}

function onConfirmYes() {
    document.getElementById('confirmModal').classList.add('hidden');
    document.getElementById('confirmModal').classList.remove('flex');
    if (confirmCallback) confirmCallback();
}

function closeConfirm() {
    document.getElementById('confirmModal').classList.add('hidden');
    document.getElementById('confirmModal').classList.remove('flex');
}

// ==========================================
// --- 3. NAVIGATION ---
// ==========================================
function toggleMainDock(show) {
    const el = document.getElementById('mainNavbar');
    if (el) {
        if (show) el.classList.remove('hidden');
        else el.classList.add('hidden');
    }
}

function switchTab(tabName) {
    document.getElementById('homeSection').classList.add('hidden');
    document.getElementById('appSection').classList.add('hidden');

    const hBtn = document.getElementById('btnTabHome');
    const aBtn = document.getElementById('btnTabApp');

    const inactiveClass = "w-12 h-12 flex items-center justify-center rounded-full transition-all duration-300 text-gray-400 hover:text-gray-700 hover:bg-gray-50";
    const activeClass = "w-12 h-12 flex items-center justify-center rounded-full transition-all duration-300 text-blue-600 bg-blue-50 shadow-sm";

    if (hBtn) hBtn.className = inactiveClass;
    if (aBtn) aBtn.className = inactiveClass;

    if (tabName === 'home') {
        document.getElementById('homeSection').classList.remove('hidden');
        if (hBtn) hBtn.className = activeClass;
    } else {
        document.getElementById('appSection').classList.remove('hidden');
        if (aBtn) aBtn.className = activeClass;
        openAppSubPage('menu');
    }
}

function openAppSubPage(pageName) {
    currentAppSubPage = pageName;
    if (!appReady && pageName !== 'menu') return;
    const pages = ['appMenuPage', 'tempParkingPage', 'visitorHistoryPage', 'licensePlatePage', 'ownerListPage', 'aiModePage'];
    pages.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.classList.add('hidden');
            el.style.display = 'none'; // Force hide
        }
    });

    const targetId = pageName === 'menu' ? 'appMenuPage' :
        pageName === 'temp' ? 'tempParkingPage' :
            pageName === 'history' ? 'visitorHistoryPage' :
                pageName === 'license' ? 'licensePlatePage' :
                    pageName === 'owner' ? 'ownerListPage' :
                        pageName === 'ai' ? 'aiModePage' : '';

    if (targetId) {
        const target = document.getElementById(targetId);
        if (target) {
            target.classList.remove('hidden');
            target.style.display = 'flex'; // Force flex show
        }
    }

    if (pageName === 'temp') loadTempData();
    else if (pageName === 'history') loadVisitorHistory();
    else if (pageName === 'license') loadLicenseData();
    else if (pageName === 'owner') loadOwnerData();
    else if (pageName === 'ai') {
        if (document.getElementById('aiMenuSubPage')) {
            document.getElementById('aiMenuSubPage').classList.remove('hidden');
            document.getElementById('aiAccountingSubPage').classList.add('hidden');
        }
    }
}


function retryAppInitialization() {
    if (appInitializing) return;
    initializeAppV2();
}

// ==========================================
// --- 4. VISITOR SYSTEM ---
// ==========================================
function initHomeHeader() {
    initDesktopNavbar();
    initNetworkStatus();
    initializeAppV2();
}

// ==========================================
// --- 3.1 DESKTOP NAVBAR & DRAG-DROP ---
// ==========================================
function initDesktopNavbar() {
    const savedOrder = localStorage.getItem('desktopNavOrder');
    if (savedOrder) {
        try { desktopNavOrder = JSON.parse(savedOrder); } catch (e) { }
    }
    renderDesktopNavItems();
}

function renderDesktopNavItems() {
    const container = document.getElementById('bottomNavShortcuts');
    if (!container) return;
    container.innerHTML = '';
}

let draggedItemKey = null;

function handleDragStart(e) {
    draggedItemKey = this.dataset.key;
    this.classList.add('opacity-50');
    e.dataTransfer.effectAllowed = 'move';
}

function handleDragOver(e) {
    if (e.preventDefault) e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    return false;
}

function handleDrop(e) {
    if (e.stopPropagation) e.stopPropagation();
    const targetKey = this.dataset.key;

    if (draggedItemKey !== targetKey) {
        const oldIndex = desktopNavOrder.indexOf(draggedItemKey);
        const newIndex = desktopNavOrder.indexOf(targetKey);

        if (oldIndex > -1 && newIndex > -1) {
            desktopNavOrder.splice(oldIndex, 1);
            desktopNavOrder.splice(newIndex, 0, draggedItemKey);
            localStorage.setItem('desktopNavOrder', JSON.stringify(desktopNavOrder));
            renderDesktopNavItems();
        }
    }
    return false;
}

function handleDragEnd() {
    this.classList.remove('opacity-50');
    draggedItemKey = null;
}

function loadHomeTempStatus() {
    // 1. Local Cache
    const cached = localStorage.getItem('tempParkingData');
    if (cached) {
        const res = JSON.parse(cached);
        renderHomeTempStatus(res);
    }

    // 2. Network Update (background only — never block Home)
    runApi('getAllTempData', null, { silent: true, retries: 1 }).then(res => {
        if (res) {
            localStorage.setItem('tempParkingData', JSON.stringify(res)); // Shared cache with Temp page
            renderHomeTempStatus(res);
            markDataRefreshSuccess();
        }
    });
}

// Render Home Card as Single Line (Room | Plate)
function renderHomeTempStatus(res) {
    const container = document.getElementById('homeTempStatusContainer');
    const wrapper = document.getElementById('homeActiveWrapper');
    if (!container || !wrapper) return;
    if (!document.getElementById('entryFormArea').classList.contains('hidden')) { wrapper.classList.add('hidden'); return; }

    const activeList = res.active || [];
    if (activeList.length === 0) { container.innerHTML = ''; wrapper.classList.add('hidden'); return; }

    wrapper.classList.remove('hidden');
    container.classList.remove('hidden'); // Ensure inner container is visible
    let html = '';
    activeList.forEach(item => {
        let badge = item.status === 'Waiting' ? '<span class="text-orange-600 bg-orange-500/10 border border-orange-500/20 rounded-full px-2 py-0.5 text-[10px] font-bold backdrop-blur-md">รอเข้า</span>' : '<span class="text-blue-600 bg-blue-500/10 border border-blue-500/20 rounded-full px-2 py-0.5 text-[10px] font-bold backdrop-blur-md">จอดอยู่</span>';
        html += `
            <div class="px-4 py-2.5 mb-2 vision-glass rounded-2xl flex justify-between items-center glass-card-hover">
                <div class="flex items-center gap-3 overflow-hidden flex-1 mr-2">
                     <span class="font-medium text-ios-primary text-base truncate">${item.room}</span>
                     <span class="text-gray-300 text-xs">|</span>
                     <span class="font-medium text-ios-primary text-base truncate">${item.plate}</span>
                </div>
                <div class="flex-none shadow-sm">${badge}</div>
            </div>
        `;
    });
    container.innerHTML = html;
}

function handleVisitorAction() {
    const cardId = document.getElementById('visitorCardId').value;
    if (!cardId) return showAlert('แจ้งเตือน', 'กรุณากรอกเลขบัตร', 'error');
    toggleLoading(true);

    // API Call: getParkingStatus
    runApi('getParkingStatus', cardId).then(res => {
        toggleLoading(false);
        if (res && res.found) openCheckoutPopup(res);
        else showEntryForm(cardId);
    });
}

function showEntryForm(cardId) {
    document.getElementById('searchArea').classList.add('hidden');
    document.getElementById('homeActiveWrapper')?.classList.add('hidden'); // Use wrapper
    document.getElementById('homeTempStatusContainer').classList.add('hidden'); // Hide inner too just in case
    document.getElementById('entryFormArea').classList.remove('hidden');
    document.getElementById('entryCardIdDisplay').value = cardId;
    document.getElementById('entryRoomNo').value = "";
    setTimeout(() => document.getElementById('entryRoomNo').focus(), 300);
    toggleMainDock(false); // Hide Dock
}

function submitEntry() {
    if (isSubmittingEntry) return;
    const cardId = document.getElementById('entryCardIdDisplay').value;
    const roomNo = document.getElementById('entryRoomNo').value;
    if (!cardId || !roomNo) return showAlert('แจ้งเตือน', 'ข้อมูลไม่ครบ', 'error');
    if (!currentPlateImg) return showAlert('แจ้งเตือน', 'ถ่ายรูปทะเบียน', 'error');
    isSubmittingEntry = true;
    hapticFeedback(15);
    toggleLoading(true);

    // API Call: saveEntry
    runApi('saveEntry', { cardId, roomNo, plateImg: currentPlateImg }).then(res => {
        toggleLoading(false);
        isSubmittingEntry = false;
        if (res && res.success) { hapticFeedback([20, 40, 20]); showAlert('สำเร็จ', res.message, 'success'); resetHome(); }
        else showAlert('ผิดพลาด', res ? res.message : 'Unknown error', 'error');
    }).catch(() => { toggleLoading(false); isSubmittingEntry = false; });
}

// ==========================================
// --- PROMPTPAY & BILLER CONFIG ---
// ==========================================
const PROMPTPAY_CONFIG = {
    billerId: "099400078280209", // Biller ID 15 digits หรือเบอร์โทร / เลขบัตร ปชช.
    accountName: "BHR Parking",
};

// ==========================================
// --- PROMPTPAY DYNAMIC QR GENERATOR ---
// ==========================================
function crc16(data) {
    let crc = 0xFFFF;
    for (let i = 0; i < data.length; i++) {
        crc ^= data.charCodeAt(i) << 8;
        for (let j = 0; j < 8; j++) {
            if ((crc & 0x8000) !== 0) {
                crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
            } else {
                crc = (crc << 1) & 0xFFFF;
            }
        }
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
}

function formatTlv(tag, value) {
    const valStr = String(value);
    const lenStr = String(valStr.length).padStart(2, '0');
    return `${tag}${lenStr}${valStr}`;
}

function generatePromptPayPayload(targetId, amount = null, ref1 = '', ref2 = '') {
    const cleaned = String(targetId || '').replace(/[^0-9]/g, '');
    if (cleaned.length !== 15) {
        throw new Error('Biller ID ต้องมี 15 หลัก');
    }

    // Thai QR Bill Payment (Tag 30)
    // Keep the payload minimal and in the standard field order for broad
    // mobile-banking compatibility. Ref 1 is always present; when the user
    // leaves it blank, the requested default is 788.
    const cleanRef1 = String(ref1 || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 20) || '788';
    const cleanRef2 = String(ref2 || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 20);

    const tag30Value =
        formatTlv('00', 'A000000677010112') +
        formatTlv('01', cleaned) +
        formatTlv('02', cleanRef1) +
        (cleanRef2 ? formatTlv('03', cleanRef2) : '');

    const tag00 = formatTlv('00', '01');
    const isDynamic = Number(amount) > 0;
    const tag01 = formatTlv('01', isDynamic ? '12' : '11');
    const tag53 = formatTlv('53', '764');
    const tag54 = isDynamic ? formatTlv('54', Number(amount).toFixed(2)) : '';
    const tag58 = formatTlv('58', 'TH');

    // Do not add optional merchant-name/city fields to the bill-payment
    // payload. Some banking apps are stricter than others about Tag 30
    // payloads; keeping only the required payment fields improves compatibility.
    const rawData = tag00 + tag01 + formatTlv('30', tag30Value) + tag53 + tag54 + tag58 + '6304';
    return rawData + crc16(rawData);
}

let qrCodeInstance = null;
function renderPromptPayQR(targetId, amount, ref1, ref2) {
    const qrContainer = document.getElementById('promptpayQrCode');
    if (!qrContainer) return;
    // QR payment stays black-on-white with a clean quiet zone for reliable scanning.
    qrContainer.style.backgroundColor = '#ffffff';
    qrContainer.innerHTML = '';

    const payload = generatePromptPayPayload(targetId, amount, ref1, ref2);
    console.log("Generated PromptPay Payload:", payload);
    
    let rendered = false;
    if (typeof QRCode !== 'undefined') {
        try {
            qrCodeInstance = new QRCode(qrContainer, {
                text: payload,
                width: 208,
                height: 208,
                colorDark: "#000000",
                colorLight: "#ffffff",
                correctLevel: (QRCode.CorrectLevel && typeof QRCode.CorrectLevel.M !== 'undefined') ? QRCode.CorrectLevel.M : 0
            });
            // IMPORTANT: do NOT rewrite canvas.width / canvas.height after QRCode draws.
            // Changing either canvas attribute clears the bitmap and was the cause of
            // the QR appearing as a tiny/broken strip in the payment dialog.
            const canvas = qrContainer.querySelector('canvas');
            const img = qrContainer.querySelector('img');
            if (canvas) {
                canvas.style.width = '208px';
                canvas.style.height = '208px';
                canvas.style.display = 'block';
                canvas.style.margin = '0 auto';
            }
            if (img) {
                img.style.width = '208px';
                img.style.height = '208px';
                img.style.display = 'block';
                img.style.margin = '0 auto';
            }
            rendered = !!(canvas || img);
        } catch (err) {
            console.warn("QRCode constructor error, using fallback:", err);
            rendered = false;
        }
    }

    if (!rendered) {
        // Fallback using image URL
        const qrImg = document.createElement('img');
        qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=256x256&margin=4&data=${encodeURIComponent(payload)}`;
        qrImg.alt = "PromptPay QR Code";
        qrImg.className = "w-[208px] h-[208px] object-contain mx-auto block";
        qrContainer.appendChild(qrImg);
    }
}

function openCheckoutPopup(record) {
    currentRecord = record;
    const modal = document.getElementById('exitPopupModal');
    modal.classList.remove('hidden'); modal.classList.add('flex');
    
    document.getElementById('exitInfo').innerHTML = `
         <div class="grid grid-cols-2 gap-2 text-xs">
             <div class="bg-gray-50/80 p-2 rounded-xl border border-gray-100/80">
                <span class="text-gray-400 block text-[10px]">เลขบัตรจอด</span>
                <span class="font-bold text-gray-800 text-sm">${record.cardId || '-'}</span>
             </div>
             <div class="bg-gray-50/80 p-2 rounded-xl border border-gray-100/80">
                <span class="text-gray-400 block text-[10px]">เลขห้อง</span>
                <span class="font-bold text-gray-800 text-sm">${record.roomNo || '-'}</span>
             </div>
             <div class="bg-gray-50/80 p-2 rounded-xl border border-gray-100/80">
                <span class="text-gray-400 block text-[10px]">เวลาเข้า</span>
                <span class="font-medium text-gray-700 text-[11px] truncate block">${record.entryTime || '-'}</span>
             </div>
             <div class="bg-gray-50/80 p-2 rounded-xl border border-gray-100/80">
                <span class="text-gray-400 block text-[10px]">ระยะเวลาจอด</span>
                <span class="font-bold text-blue-600 text-[11px] truncate block">${record.durationText || '-'}</span>
             </div>
         </div>
      `;

    const priceNum = Number(record.price) || 0;
    document.getElementById('exitPriceDisplay').innerText = priceNum.toLocaleString('th-TH');

    const promptpaySection = document.getElementById('promptpaySection');
    const freeParkingBadge = document.getElementById('freeParkingBadge');
    const billerDisplay = document.getElementById('promptpayBillerDisplay');
    const accountDisplay = document.getElementById('promptpayAccountDisplay');
    const ref1Display = document.getElementById('promptpayRef1Display');
    
    if (billerDisplay) billerDisplay.innerText = PROMPTPAY_CONFIG.billerId;
    if (accountDisplay) accountDisplay.innerText = PROMPTPAY_CONFIG.accountName || 'BHR PARKING';
    if (ref1Display) ref1Display.innerText = record.cardId || '001';

    if (priceNum > 0) {
        if (promptpaySection) promptpaySection.classList.remove('hidden');
        if (freeParkingBadge) freeParkingBadge.classList.add('hidden');
        renderPromptPayQR(PROMPTPAY_CONFIG.billerId, priceNum, record.cardId, record.roomNo);
    } else {
        if (promptpaySection) promptpaySection.classList.add('hidden');
        if (freeParkingBadge) freeParkingBadge.classList.remove('hidden');
    }
}

function submitExit() {
    if (isSubmittingExit || !currentRecord) return;
    if (currentRecord.price > 0 && !currentSlipImg) return showAlert('แจ้งเตือน', 'กรุณาแนบสลิป', 'error');
    showConfirm('ยืนยันรถออก', `ยอดชำระ ${currentRecord.price} บาท`, () => {
        if (isSubmittingExit) return;
        isSubmittingExit = true;
        hapticFeedback(15);
        toggleLoading(true);
        const data = { ...currentRecord, slipImg: currentSlipImg };
        // API Call: saveExit
        runApi('saveExit', data).then(res => {
            toggleLoading(false);
            isSubmittingExit = false;
            document.getElementById('exitPopupModal').classList.add('hidden');
            document.getElementById('exitPopupModal').classList.remove('flex');
            if (res && res.success) { showAlert('สำเร็จ', res.message, 'success'); resetHome(); }
            else { showAlert('ผิดพลาด', res ? res.message : 'Unknown error', 'error'); }
        });
    });
}

function resetHome() {
    document.getElementById('visitorCardId').value = "";
    document.getElementById('searchArea').classList.remove('hidden');
    document.getElementById('entryFormArea').classList.add('hidden');
    document.getElementById('entryRoomNo').value = "";
    currentPlateImg = null;
    document.getElementById('platePreview').classList.add('hidden');
    document.getElementById('platePlaceholder').classList.remove('hidden');
    currentRecord = null; currentSlipImg = null;
    document.getElementById('slipPreview').classList.add('hidden');
    document.getElementById('slipPlaceholder').classList.remove('hidden');

    // Clear PromptPay QR & Badges
    const qrContainer = document.getElementById('promptpayQrCode');
    if (qrContainer) qrContainer.innerHTML = '';
    const promptpaySection = document.getElementById('promptpaySection');
    if (promptpaySection) promptpaySection.classList.add('hidden');
    const freeParkingBadge = document.getElementById('freeParkingBadge');
    if (freeParkingBadge) freeParkingBadge.classList.add('hidden');

    document.getElementById('exitPopupModal').classList.add('hidden');
    document.getElementById('exitPopupModal').classList.remove('flex');
    loadHomeTempStatus();
    toggleMainDock(true); // Show Dock
}

// ==========================================
// --- 5. VISITOR HISTORY ---
// ==========================================
function loadVisitorHistory() {
    // 1. Local Cache
    const cached = localStorage.getItem('visitorHistory');
    if (cached) {
        historyData = JSON.parse(cached);
        renderHistoryList(historyData);
    } else {
        toggleLoading(true);
    }

    // 2. Network Update
    runApi('getHistory').then(data => {
        toggleLoading(false);
        if (data) {
            historyData = data;
            localStorage.setItem('visitorHistory', JSON.stringify(data));
            renderHistoryList(historyData);
        }
    });
}

function renderHistoryList(data) {
    const container = document.getElementById('historyListContainer');
    container.innerHTML = '';
    if (data.length === 0) { container.innerHTML = `<div class="text-center py-20 text-ios-secondary flex flex-col items-center"><i class="fas fa-history text-5xl mb-4 opacity-30"></i><span class="font-light">ไม่มีประวัติ</span></div>`; return; }

    currentHistoryList = data;

    data.forEach((item, index) => {
        const isParked = item.status === 'Parked';
        const badge = isParked ? `<span class="bg-blue-500/10 text-blue-600 border border-blue-500/20 px-3 py-1 rounded-full text-[10px] font-bold shadow-sm backdrop-blur-md">จอดอยู่</span>` : `<span class="bg-gray-500/10 text-gray-500 border border-gray-500/20 px-3 py-1 rounded-full text-[10px] font-bold shadow-sm backdrop-blur-md">ออกแล้ว</span>`;

        container.innerHTML += `
            <div onclick="openHistoryDetail(${index})" style="animation-delay: ${index * 0.05}s" class="stagger-item vision-glass p-5 rounded-[2rem] mb-3 md:mb-0 glass-card-hover cursor-pointer relative overflow-visible group transition self-start">
                <div class="flex justify-between items-start relative z-10">
                    <div>
                        <div class="flex items-center gap-3 mb-2">
                            <span class="font-bold text-ios-primary text-xl">${item.roomNo}</span>
                            <span class="text-[10px] bg-white/40 px-2 py-1 rounded-lg text-gray-700 font-medium backdrop-blur-sm">บัตร ${item.cardId}</span>
                        </div>
                        <div class="text-xs text-ios-secondary flex flex-col gap-1.5 mt-1">
                            <span class="flex items-center"><i class="fas fa-arrow-circle-right text-green-500 mr-2"></i> ${item.entryDateDisplay} ${item.entryTime}</span>
                            ${!isParked ? `<span class="flex items-center"><i class="fas fa-arrow-circle-left text-red-500 mr-2"></i> ${item.exitDateDisplay} ${item.exitTime}</span>` : ''}
                        </div>
                    </div>
                    <div class="text-right flex flex-col items-end gap-2">
                        ${badge}
                        <div class="font-bold text-ios-primary text-lg mt-1">${item.price} ฿</div>
                    </div>
                </div>
            </div>
            `;
    });
}

function openHistoryDetail(index) {
    const item = currentHistoryList[index];
    if (!item) return showAlert('Error', 'ไม่พบข้อมูล');
    selectedHistoryIndex = index;
    currentRecord = item;
    isHistoryEditMode = false;

    const content = document.getElementById('histDetailContent');
    content.innerHTML = `
        <div class="grid grid-cols-2 gap-4">
            <div class="bg-gray-50 p-3 rounded-2xl text-center"><span class="text-xs text-gray-400 font-bold">เลขบัตร</span><div class="font-bold text-xl text-gray-800">${item.cardId}</div></div>
            <div class="bg-gray-50 p-3 rounded-2xl text-center"><span class="text-xs text-gray-400 font-bold">เลขห้อง</span><div class="font-bold text-xl text-gray-800">${item.roomNo}</div></div>
        </div>
        <div class="bg-white border border-gray-100 p-4 rounded-2xl space-y-2 mt-4 shadow-sm">
            <div class="flex justify-between"><span class="text-gray-400 text-xs font-bold uppercase">เข้า</span><div class="text-right"><span class="text-gray-500 text-xs mr-2">${item.entryDateDisplay || '-'}</span><span class="font-bold text-lg text-gray-800">${item.entryTime || '-'}</span></div></div>
            <div class="flex justify-between border-t border-gray-100 pt-2"><span class="text-gray-400 text-xs font-bold uppercase">ออก</span><div class="text-right"><span class="text-gray-500 text-xs mr-2">${item.exitDateDisplay || '-'}</span><span class="font-bold text-lg text-gray-800">${item.exitTime || '-'}</span></div></div>
        </div>
        <div class="bg-red-50 p-4 rounded-2xl flex justify-between items-center border border-red-100 mt-4"><span class="text-red-500 font-bold text-sm">ยอดชำระ</span><span class="text-red-600 font-extrabold text-2xl">${item.price} ฿</span></div>
        <div class="grid grid-cols-3 gap-2 mt-2">
            ${createImgBlock('Plate', 'car-side', 'รถ', item.plateImg)}
            ${createImgBlock('Id', 'id-card', 'บัตร', item.idCardImg)}
            ${createImgBlock('Slip', 'file-invoice', 'สลิป', item.slipImg)}
        </div>
        `;
    document.getElementById('histDetailViewControls').innerHTML = `<button onclick="enableHistoryEdit()" class="text-blue-500 text-xs bg-blue-50 px-3 py-1.5 rounded-lg font-bold">แก้ไข</button>`;

    document.getElementById('histDetailViewControls').classList.remove('hidden');
    document.getElementById('histDetailEditControls').classList.add('hidden');
    document.getElementById('historyDetailModal').classList.remove('hidden');
    document.getElementById('historyDetailModal').classList.add('flex');
    toggleMainDock(false);
}

function createImgBlock(idSuffix, icon, label, url) {
    const showImg = url ? '' : 'hidden';
    const showPlace = url ? 'hidden' : '';
    const fixedUrl = fixDriveLink(url);

    return `
            <div class="w-full aspect-square bg-gray-50 rounded-2xl overflow-hidden relative border border-gray-200 cursor-pointer hover:bg-gray-100 transition" onclick="handleHistoryImgClick('${idSuffix}')">
                <img id="histDetail${idSuffix}Img" class="${showImg} w-full h-full object-cover" src="${fixedUrl}">
                    <div id="histDetail${idSuffix}Placeholder" class="${showPlace} absolute inset-0 flex flex-col items-center justify-center text-gray-300 gap-2">
                        <i class="fas fa-${icon} text-2xl"></i><span class="text-[10px] text-gray-400">${label}</span>
                    </div>
                    <div id="histDetail${idSuffix}Overlay" class="hidden absolute inset-0 bg-black/50 flex items-center justify-center text-white text-xs font-bold backdrop-blur-sm pointer-events-none">
                        <i class="fas fa-camera mr-1"></i> แก้ไข
                    </div>
                </div>
        `;
}

function handleHistoryImgClick(type) {
    if (isHistoryEditMode) {
        if (type === 'Id') {
            openCamera('history_' + type.toLowerCase());
        }
    } else {
        const imgEl = document.getElementById('histDetail' + type + 'Img');
        if (imgEl && !imgEl.classList.contains('hidden') && imgEl.src && imgEl.src !== '') {
            viewFullImage(imgEl.src);
        }
    }
}

function enableHistoryEdit() {
    isHistoryEditMode = true;
    const el = document.getElementById('histDetailIdOverlay');
    if (el) el.classList.remove('hidden');
    document.getElementById('histDetailViewControls').classList.add('hidden');
    document.getElementById('histDetailEditControls').classList.remove('hidden');
}

function saveHistoryEdit() { isHistoryEditMode = false; showAlert('สำเร็จ', 'บันทึกข้อมูลเรียบร้อย'); openHistoryDetail(selectedHistoryIndex); }
function cancelHistoryEdit() { openHistoryDetail(selectedHistoryIndex); }
function closeHistoryDetail() { document.getElementById('historyDetailModal').classList.add('hidden'); document.getElementById('historyDetailModal').classList.remove('flex'); toggleMainDock(true); }
function printHistoryDetail() { if (selectedHistoryIndex === -1) return; const item = currentHistoryList[selectedHistoryIndex]; const w = window.open('', '', 'width=800,height=800'); w.document.write(`< html ><head><title>ใบเสร็จ</title><style>body{font-family:sans-serif;padding:20px;text-align:center}.box{border:1px solid #ddd;padding:20px;margin-bottom:20px;border-radius:10px}.row{display:flex;justify-content:space-between;margin:5px 0}img{max-width:100%;margin-top:10px}</style></head><body><h2>BHR.LAB PARKING</h2><div class="box"><div class="row"><span>ห้อง</span><strong>${item.roomNo}</strong></div><div class="row"><span>บัตร</span><strong>${item.cardId}</strong></div><hr><div class="row"><span>เข้า</span><span>${item.entryTime}</span></div><div class="row"><span>ออก</span><span>${item.exitTime}</span></div><hr><h3>${item.price} บาท</h3></div>${item.slipImg ? `<img src="${item.slipImg}">` : ''}</body></html>`); w.document.close(); setTimeout(() => { w.print(); w.close(); }, 500); }

// ==========================================
// --- 6. TEMP PARKING ---
// ==========================================
function loadTempData() {
    // 1. Local Cache
    const cached = localStorage.getItem('tempParkingData');
    if (cached) {
        const res = JSON.parse(cached);
        tempActiveData = res.active || [];
        tempHistoryData = res.history || [];
        renderTempList();
    } else {
        toggleLoading(true);
    }

    // 2. Network Update
    runApi('getAllTempData').then(res => {
        toggleLoading(false);
        if (res) {
            tempActiveData = res.active || [];
            tempHistoryData = res.history || [];
            localStorage.setItem('tempParkingData', JSON.stringify(res));
            renderTempList();
        }
    });
}

function switchTempTab(tab) { currentTempTab = tab; const activeClass = "flex-1 py-1.5 text-center text-xs font-bold rounded-lg bg-white shadow-sm text-blue-600 transition cursor-pointer"; const inactiveClass = "flex-1 py-1.5 text-center text-xs text-gray-500 transition cursor-pointer hover:text-gray-800"; document.getElementById('tabTempActive').className = tab === 'active' ? activeClass : inactiveClass; document.getElementById('tabTempHistory').className = tab === 'history' ? activeClass : inactiveClass; renderTempList(); }

function renderTempList() {
    const searchVal = document.getElementById('tempSearchInput').value.trim().toLowerCase();
    let targetData = searchVal ? [...tempActiveData, ...tempHistoryData] : (currentTempTab === 'active' ? tempActiveData : tempHistoryData);
    const container = document.getElementById('tempListContainer'); container.innerHTML = '';

    currentTempList = targetData.filter(item => (item.room || "").toString().toLowerCase().includes(searchVal) || (item.plate || "").toString().toLowerCase().includes(searchVal));

    if (currentTempList.length === 0) { container.innerHTML = `<div class="text-center py-20 text-ios-secondary flex flex-col items-center"><i class="fas fa-inbox text-5xl mb-4 opacity-30"></i><span class="font-light">ไม่มีรายการ</span></div>`; return; }

    currentTempList.forEach((item, index) => {
        let badge = item.status === 'Waiting' ? '<span class="text-orange-600 font-bold text-[10px] bg-orange-500/10 border border-orange-500/20 px-2 py-1 rounded-full backdrop-blur-md">รอเข้า</span>' : (item.status === 'Parked' ? '<span class="text-blue-600 font-bold text-[10px] bg-blue-500/10 border border-blue-500/20 px-2 py-1 rounded-full backdrop-blur-md">จอดอยู่</span>' : (item.status === 'Expired' ? '<span class="text-red-600 font-bold text-[10px] bg-red-500/10 border border-red-500/20 px-2 py-1 rounded-full backdrop-blur-md">หมดเวลา</span>' : '<span class="text-green-600 font-bold text-[10px] bg-green-500/10 border border-green-500/20 px-2 py-1 rounded-full backdrop-blur-md">จบงาน</span>'));

        container.innerHTML += `
            <div onclick="openTempDetail(${index})" style="animation-delay: ${index * 0.05}s" class="stagger-item vision-glass p-5 rounded-[2rem] mb-3 md:mb-0 glass-card-hover cursor-pointer relative overflow-visible group transition self-start">
                <div class="flex justify-between items-start relative z-10">
                    <div>
                         <div class="mb-2 flex items-center">
                            <span class="font-bold text-ios-primary text-xl">${item.room}</span>
                            <span class="text-gray-300 mx-3 text-lg">|</span>
                            <span class="font-bold text-ios-primary text-xl">${item.plate}</span>
                         </div>
                        <div class="text-xs text-ios-secondary flex flex-col gap-1.5 mt-1">
                            <span class="flex items-center"><i class="fas fa-arrow-circle-right text-green-500 mr-2"></i> ${item.startTimeDisplay}</span>
                            <span class="flex items-center"><i class="fas fa-arrow-circle-left text-red-500 mr-2"></i> ${item.endTimeDisplay}</span>
                        </div>
                    </div>
                    <div class="text-right flex flex-col items-end gap-1">
                        ${badge}
                    </div>
                </div>
            </div>
        `;
    });
}

function openTempDetail(index) {
    const item = currentTempList[index];
    if (!item) return showAlert('แจ้งเตือน', 'ไม่พบข้อมูลรายการนี้', 'error');

    currentRecord = item; isTempEditMode = false;
    const content = document.getElementById('tempDetailContent');

    content.innerHTML = `
        <div class="grid grid-cols-2 gap-4">
            <div class="bg-gray-50 p-3 rounded-2xl text-center">
                <span class="text-xs text-gray-400 font-bold">ห้อง</span>
                <div id="viewTempRoom" class="font-bold text-xl text-gray-800">${item.room}</div>
                <input id="editTempRoom" class="hidden w-full bg-white border border-gray-200 rounded p-1 text-center text-gray-800 font-bold" value="${item.room}">
            </div>
            <div class="bg-gray-50 p-3 rounded-2xl text-center">
                <span class="text-xs text-gray-400 font-bold">ทะเบียน</span>
                <div id="viewTempPlate" class="font-bold text-xl text-gray-800">${item.plate}</div>
                <input id="editTempPlate" class="hidden w-full bg-white border border-gray-200 rounded p-1 text-center text-gray-800 font-bold" value="${item.plate}">
            </div>
        </div>
        
        <div class="bg-white border border-gray-100 p-4 rounded-2xl space-y-2 mt-4 shadow-sm">
            <div class="flex justify-between"><span class="text-gray-400 text-xs font-bold uppercase">เริ่ม</span><span class="font-bold text-gray-800">${item.startTimeDisplay}</span></div>
            <div class="flex justify-between border-t border-gray-100 pt-2"><span class="text-gray-400 text-xs font-bold uppercase">สิ้นสุด</span><span class="font-bold text-gray-800">${item.endTimeDisplay}</span></div>
            <div class="flex justify-between border-t border-gray-100 pt-2"><span class="text-gray-400 text-xs font-bold uppercase">สถานะ</span><span class="font-bold text-blue-600">${item.status}</span></div>
        </div>

        <div class="w-full aspect-video mt-4 bg-gray-50 rounded-2xl overflow-hidden relative border border-gray-200" onclick="handleTempImgClick()">
            <img id="detailTempImg" class="${item.plateImg ? '' : 'hidden'} w-full h-full object-cover" src="${fixDriveLink(item.plateImg)}">
            <div id="detailTempImgPlaceholder" class="${item.plateImg ? 'hidden' : ''} absolute inset-0 flex flex-col items-center justify-center text-gray-300 gap-2">
                <i class="fas fa-image text-3xl"></i><span class="text-xs text-gray-400">ไม่มีรูป</span>
            </div>
            <div id="detailTempImgOverlay" class="hidden absolute inset-0 bg-black/50 flex items-center justify-center text-white text-xs font-bold pointer-events-none">
                <i class="fas fa-camera mr-1"></i> เปลี่ยนรูป
            </div>
        </div>
      `;

    const editBtn = document.getElementById('tempDetailEditBtn');
    if (editBtn) editBtn.classList.remove('hidden');

    document.getElementById('tempDetailEditControls').classList.add('hidden');
    document.getElementById('tempDetailDeleteBtn').classList.remove('hidden');
    document.getElementById('tempDetailModal').classList.remove('hidden');
    document.getElementById('tempDetailModal').classList.add('flex');
    toggleMainDock(false);
}

function enableTempEdit() {
    requestAdminPin(() => {
        isTempEditMode = true;
        document.getElementById('viewTempRoom').classList.add('hidden');
        document.getElementById('editTempRoom').classList.remove('hidden');
        document.getElementById('viewTempPlate').classList.add('hidden');
        document.getElementById('editTempPlate').classList.remove('hidden');
        document.getElementById('detailTempImgOverlay').classList.remove('hidden');

        const editBtn = document.getElementById('tempDetailEditBtn');
        if (editBtn) editBtn.classList.add('hidden');

        document.getElementById('tempDetailEditControls').classList.remove('hidden');
        document.getElementById('tempDetailDeleteBtn').classList.add('hidden');
    });
}

function saveTempEdit() {
    const newRoom = document.getElementById('editTempRoom').value;
    const newPlate = document.getElementById('editTempPlate').value;
    toggleLoading(true);
    // API Call: updateTempEntry
    runApi('updateTempEntry', { rowIndex: currentRecord.rowIndex, room: newRoom, plate: newPlate }).then(res => {
        toggleLoading(false);
        if (res && res.success) { showAlert('สำเร็จ', 'บันทึกเรียบร้อย'); loadTempData(); closeTempDetail(); }
        else showAlert('ผิดพลาด', 'บันทึกไม่ได้');
    });
}

function deleteCurrentTemp() {
    if (!currentRecord) return;
    requestAdminPin(() => {
        showConfirm("ยกเลิกรายการ", "ยืนยัน?", () => {
            toggleLoading(true);
            // API Call: deleteTempEntry
            runApi('deleteTempEntry', currentRecord.rowIndex).then(res => {
                toggleLoading(false);
                closeTempDetail();
                if (res && res.success) loadTempData();
            });
        });
    });
}

function closeTempDetail() { document.getElementById('tempDetailModal').classList.add('hidden'); document.getElementById('tempDetailModal').classList.remove('flex'); toggleMainDock(true); }
function cancelTempEdit() { closeTempDetail(); }

function handleTempImgClick() {
    if (isTempEditMode) {
        triggerFileUpload('temp_update');
    } else {
        const imgEl = document.getElementById('detailTempImg');
        if (imgEl && !imgEl.classList.contains('hidden') && imgEl.src) {
            viewFullImage(imgEl.src);
        }
    }
}

function openAddTempModal() { requestAdminPin(() => { toggleMainDock(false); const now = new Date(); const offset = now.getTimezoneOffset() * 60000; const localISOTime = (new Date(now - offset)).toISOString().slice(0, 10); document.getElementById('tempStartDate').value = localISOTime; document.getElementById('tempEndDate').value = localISOTime; document.getElementById('tempRoom').value = ""; document.getElementById('tempPlate').value = ""; tempAddPlateImg = null; document.getElementById('addTempImgPreview').classList.add('hidden'); document.getElementById('addTempImgPlaceholder').classList.remove('hidden'); let opts = ''; for (let i = 0; i < 24; i++) { const h = i.toString().padStart(2, '0'); opts += `<option value="${h}">${h}:00</option>`; } document.getElementById('tempStartHour').innerHTML = opts; document.getElementById('tempStartHour').value = "09"; document.getElementById('tempEndHour').innerHTML = opts; document.getElementById('tempEndHour').value = "18"; document.getElementById('addTempModal').classList.remove('hidden'); document.getElementById('addTempModal').classList.add('flex'); }); }
function closeAddTempModal() { document.getElementById('addTempModal').classList.add('hidden'); document.getElementById('addTempModal').classList.remove('flex'); toggleMainDock(true); }
function captureTempAddImage() { triggerFileUpload('temp_add'); }

function submitTempAdd() {
    const room = document.getElementById('tempRoom').value;
    const plate = document.getElementById('tempPlate').value;
    const startDate = document.getElementById('tempStartDate').value;
    const endDate = document.getElementById('tempEndDate').value;
    if (!room || !plate || !startDate || !endDate) return showAlert('แจ้งเตือน', 'ข้อมูลไม่ครบ');
    const data = { room, plate, startDate, startHour: document.getElementById('tempStartHour').value, endDate, endHour: document.getElementById('tempEndHour').value, plateImg: tempAddPlateImg };
    toggleLoading(true);
    // API Call: addManualTempEntry
    runApi('addManualTempEntry', data).then(res => {
        toggleLoading(false);
        closeAddTempModal();
        if (res && res.success) { showAlert('สำเร็จ', 'เพิ่มรายการแล้ว'); loadTempData(); }
        else showAlert('ผิดพลาด', 'เพิ่มไม่ได้');
    });
}

// ==========================================
// --- 7. LICENSE & OWNER ---
// ==========================================
function loadLicenseData() {
    // 1. Local Cache First (Instant)
    const cached = localStorage.getItem('licenseData');
    if (cached) {
        licenseData = JSON.parse(cached);
        renderLicenseList();
    } else {
        toggleLoading(true); // Show loader only if no cache
    }

    // 2. Network Update (Background)
    runApi('getLicenseList').then(res => {
        toggleLoading(false);
        if (res) {
            licenseData = res;
            localStorage.setItem('licenseData', JSON.stringify(res)); // Save to cache
            renderLicenseList(); // Re-render with fresh data
        }
    });
}

function renderLicenseList() {
    const container = document.getElementById('licenseListContainer');
    const searchVal = document.getElementById('licenseSearchInput').value.trim().toLowerCase();

    currentLicenseList = (licenseData || []).filter(item => (item.plate || "").toLowerCase().includes(searchVal) || (item.room || "").toLowerCase().includes(searchVal));

    if (currentLicenseList.length === 0) { container.innerHTML = `<div class="text-center py-12 text-gray-400"><i class="fas fa-car-crash text-4xl mb-3"></i><br>ไม่พบข้อมูล</div>`; return; }

    container.innerHTML = currentLicenseList.map((item, index) => `
        <div onclick="openLicenseDetail(${index})" style="animation-delay: ${index * 0.05}s" class="stagger-item vision-glass p-5 rounded-[2rem] mb-3 md:mb-0 glass-card-hover cursor-pointer relative overflow-visible group transition self-start">
            <div class="flex justify-between items-center relative z-10">
                <div class="flex flex-col flex-1 overflow-visible">
                    <div class="font-bold text-ios-primary text-xl">${item.room}</div>
                    <div class="text-sm text-ios-secondary">${item.plate}</div>
                    <div class="text-xs text-gray-500 mt-1">${item.name || '-'}</div>
                </div>
                ${item.phone ? `<a href="tel:${item.phone}" onclick="event.stopPropagation()" class="w-10 h-10 rounded-full bg-green-500/20 text-green-600 flex items-center justify-center hover:bg-green-500 hover:text-white transition z-10 mr-2 backdrop-blur-md"><i class="fas fa-phone"></i></a>` : ''}
                <i class="fas fa-chevron-right text-gray-400/50 text-xs"></i>
            </div>
        </div>
      `).join('');
}

function openLicenseDetail(index) {
    const item = currentLicenseList[index];
    if (!item) return showAlert('Error', 'ไม่พบข้อมูล');
    currentRecord = item;

    const content = document.getElementById('licDetailContent');
    content.innerHTML = `
        <div class="w-full h-40 bg-gray-50 rounded-2xl mb-4 overflow-hidden relative border border-gray-200 flex items-center justify-center">
             ${item.img ? `<img src="${fixDriveLink(item.img)}" class="w-full h-full object-cover" onclick="viewFullImage(this.src)">` : `<div class="flex flex-col items-center text-gray-300"><i class="fas fa-car text-3xl mb-1"></i><span>ไม่มีรูป</span></div>`}
        </div>
        <div class="grid grid-cols-2 gap-4">
            <div><span class="text-xs text-gray-400">ห้อง</span><div class="font-bold text-lg text-gray-800">${item.room}</div><input id="editLicRoom" class="hidden w-full bg-gray-50 border border-gray-200 rounded p-1 text-gray-800" value="${item.room}"></div>
            <div><span class="text-xs text-gray-400">ทะเบียน</span><div class="font-bold text-lg text-gray-800">${item.plate}</div><input id="editLicPlate" class="hidden w-full bg-gray-50 border border-gray-200 rounded p-1 text-gray-800" value="${item.plate}"></div>
        </div>
        <div class="bg-blue-50 p-3 rounded-xl flex justify-between mt-4 border border-blue-100">
            <span class="text-blue-500 font-bold">สิทธิ์</span>
            <span class="font-extrabold text-blue-700">${item.rights} คัน</span>
            <input id="editLicRights" class="hidden w-16 text-right bg-gray-50 border border-gray-200 rounded p-1 text-gray-800" value="${item.rights}">
        </div>
        <div class="mt-4 space-y-2">
            <div><span class="text-xs text-gray-400">ชื่อ</span><div class="text-gray-800">${item.name || '-'}</div><input id="editLicName" class="hidden w-full bg-gray-50 border border-gray-200 rounded p-1 text-gray-800" value="${item.name}"></div>
            <div><span class="text-xs text-gray-400">โทร</span><a href="tel:${item.phone}" class="block text-blue-600 font-bold text-lg">${item.phone || '-'}</a><input id="editLicPhone" class="hidden w-full bg-gray-50 border border-gray-200 rounded p-1 text-gray-800" value="${item.phone}"></div>
            <div><span class="text-xs text-gray-400">Note</span><div class="bg-gray-50 p-2 rounded text-sm text-gray-600">${item.note || '-'}</div><textarea id="editLicNote" class="hidden w-full bg-gray-50 border border-gray-200 rounded p-1 text-gray-800">${item.note}</textarea></div>
        </div>
      `;
    document.getElementById('licDetailViewControls').classList.remove('hidden'); document.getElementById('licDetailEditControls').classList.add('hidden'); document.getElementById('licenseDetailModal').classList.remove('hidden'); document.getElementById('licenseDetailModal').classList.add('flex');
    toggleMainDock(false);
}

function closeLicenseDetail() { document.getElementById('licenseDetailModal').classList.add('hidden'); document.getElementById('licenseDetailModal').classList.remove('flex'); toggleMainDock(true); }
function enableLicenseEdit() { requestAdminPin(() => { renderLicenseEditMode(); }); }
function renderLicenseEditMode() {
    const item = currentRecord;
    licenseEditImg = null; // Reset image buffer
    document.getElementById('licDetailContent').innerHTML = `
         <div class="w-full h-40 bg-gray-50 rounded-2xl mb-4 overflow-hidden relative border border-gray-200 cursor-pointer" onclick="triggerFileUpload('license_update')">
            <img id="editLicImgPreview" class="${item.img ? '' : 'hidden'} w-full h-full object-cover" src="${fixDriveLink(item.img)}">
            <div id="editLicImgPlaceholder" class="${item.img ? 'hidden' : ''} absolute inset-0 flex flex-col items-center justify-center text-gray-300 gap-2">
                <i class="fas fa-camera text-2xl"></i><span class="text-xs">แตะเพื่อเปลี่ยนรูป</span>
            </div>
            <div class="absolute inset-0 bg-black/30 flex items-center justify-center text-white text-xs font-bold opacity-0 hover:opacity-100 transition">เปลี่ยนรูป</div>
         </div>
         <div class="space-y-3">
            <input id="editLicRoom" class="w-full bg-gray-50 border border-gray-200 p-2 rounded text-gray-800" value="${item.room}" placeholder="ห้อง">
            <input id="editLicPlate" class="w-full bg-gray-50 border border-gray-200 p-2 rounded text-gray-800" value="${item.plate}" placeholder="ทะเบียน">
            <input id="editLicName" class="w-full bg-gray-50 border border-gray-200 p-2 rounded text-gray-800" value="${item.name}" placeholder="ชื่อ">
            <input id="editLicPhone" class="w-full bg-gray-50 border border-gray-200 p-2 rounded text-gray-800" value="${item.phone}" placeholder="โทร">
            <input id="editLicRights" class="w-full bg-gray-50 border border-gray-200 p-2 rounded text-gray-800" value="${item.rights}" type="number" placeholder="สิทธิ์">
            <textarea id="editLicNote" class="w-full bg-gray-50 border border-gray-200 p-2 rounded text-gray-800">${item.note}</textarea>
         </div>
         <button onclick="deleteCurrentLicense()" class="w-full py-2 text-red-500 font-bold bg-red-50 rounded mt-4">ลบรายการ</button>
      `;
    document.getElementById('licDetailViewControls').classList.add('hidden'); document.getElementById('licDetailEditControls').classList.remove('hidden');
}

function saveLicenseEdit() {
    const updateData = { id: currentRecord.id, room: document.getElementById('editLicRoom').value, plate: document.getElementById('editLicPlate').value, name: document.getElementById('editLicName').value, phone: document.getElementById('editLicPhone').value, note: document.getElementById('editLicNote').value, rights: document.getElementById('editLicRights').value, img: licenseEditImg };
    toggleLoading(true);
    // API Call: updateLicensePlate
    runApi('updateLicensePlate', updateData).then(res => {
        toggleLoading(false);
        if (res && res.success) { showAlert('สำเร็จ', 'บันทึกเรียบร้อย'); loadLicenseData(); closeLicenseDetail(); }
    });
}

function cancelLicenseEdit() { closeLicenseDetail(); }
function deleteCurrentLicense() {
    showConfirm("ลบรายการ", "ยืนยัน?", () => {
        toggleLoading(true);
        // API Call: deleteLicensePlate
        runApi('deleteLicensePlate', currentRecord.id).then(() => {
            toggleLoading(false);
            closeLicenseDetail();
            loadLicenseData();
        });
    });
}

function openAddLicenseModal() { requestAdminPin(() => { document.getElementById('addLicenseModal').classList.remove('hidden'); document.getElementById('addLicenseModal').classList.add('flex'); }); }
function closeAddLicenseModal() { document.getElementById('addLicenseModal').classList.add('hidden'); document.getElementById('addLicenseModal').classList.remove('flex'); }

function submitLicenseAdd() {
    const plate = document.getElementById('licPlate').value;
    const room = document.getElementById('licRoom').value;
    if (!plate || !room) return showAlert('แจ้งเตือน', 'ข้อมูลไม่ครบ');
    toggleLoading(true);
    // API Call: addLicensePlate
    runApi('addLicensePlate', { plate, room, name: document.getElementById('licName').value, phone: document.getElementById('licPhone').value, note: document.getElementById('licNote').value, rights: document.getElementById('licParkingRights').value, plateImg: licenseAddImg }).then(res => {
        toggleLoading(false);
        closeAddLicenseModal();
        if (res && res.success) {
            // Reload Data
            loadLicenseData();

            // Clear Inputs
            document.getElementById('licPlate').value = '';
            document.getElementById('licRoom').value = '';
            document.getElementById('licParkingRights').value = '';
            document.getElementById('licName').value = '';
            document.getElementById('licPhone').value = '';
            document.getElementById('licNote').value = '';

            // Reset Image
            licenseAddImg = null;
            document.getElementById('licImgPreview').src = '';
            document.getElementById('licImgPreview').classList.add('hidden');
            document.getElementById('licImgPlaceholder').classList.remove('hidden');
        }
    });
}
function addLicenseImage() { triggerFileUpload('license_add'); }

// Owner List
// Owner List
function loadOwnerData() {
    // 1. Local Cache First (Instant)
    const cached = localStorage.getItem('ownerData');
    if (cached) {
        ownerData = JSON.parse(cached);
        renderOwnerList();
    } else {
        toggleLoading(true); // Show loader only if no cache
    }

    // 2. Network Update (Background)
    runApi('getOwnerList').then(res => {
        toggleLoading(false);
        if (res) {
            ownerData = res;
            localStorage.setItem('ownerData', JSON.stringify(res)); // Save to cache
            renderOwnerList(); // Re-render with fresh data
        }
    });
}

function renderOwnerList() {
    const container = document.getElementById('ownerListContainer');
    const searchVal = document.getElementById('ownerSearchInput').value.trim().toLowerCase();

    const isThai = (str) => /[ก-๙]/.test(str);
    currentOwnerList = (ownerData || []).filter(item => {
        // Exclude if Room contains Thai characters (Likely a License Plate record mixed in)
        if (isThai(item.room || "")) return false;

        // Search by Room or Name
        return (item.room || "").includes(searchVal) || (item.name || "").includes(searchVal);
    });

    if (currentOwnerList.length === 0) { container.innerHTML = `<div class="text-center py-12 text-gray-400"><i class="fas fa-user-slash text-4xl mb-3"></i><br>ไม่พบข้อมูล</div>`; return; }

    container.innerHTML = currentOwnerList.map((item, index) => `
        <div onclick="openOwnerDetail(${index})" style="animation-delay: ${index * 0.05}s" class="stagger-item vision-glass p-5 rounded-[2rem] mb-3 md:mb-0 glass-card-hover cursor-pointer relative overflow-visible group transition self-start">
            <div class="flex justify-between items-center relative z-10">
                <div class="flex flex-col flex-1 overflow-visible">
                    <div class="font-bold text-ios-primary text-xl">${item.room}</div>
                    <div class="text-sm text-ios-secondary truncate">${item.name}</div>
                    <div class="text-xs text-gray-500 truncate">${item.phone1 || '-'}</div>
                </div>
                ${item.phone1 ? `<a href="tel:${item.phone1}" onclick="event.stopPropagation()" class="w-10 h-10 rounded-full bg-green-500/20 text-green-600 flex items-center justify-center hover:bg-green-500 hover:text-white transition z-10 backdrop-blur-md"><i class="fas fa-phone"></i></a>` : ''}
            </div>
        </div>
      `).join('');
}

function openOwnerDetail(index) {
    const item = currentOwnerList[index];
    if (!item) return showAlert('Error', 'ไม่พบข้อมูล');
    currentRecord = item;
    const content = document.getElementById('ownerDetailContent');
    content.innerHTML = `
        <div class="bg-gray-50 p-4 rounded-xl mb-4 border border-gray-100"><span class="text-xs text-gray-400">ห้อง</span><div class="font-bold text-2xl text-gray-800">${item.room}</div></div>
        <div class="grid grid-cols-2 gap-3 mb-4">
             <div class="bg-gray-50 p-3 rounded-xl border border-gray-100"><span class="text-xs text-gray-400">ชั้น</span><div class="font-bold text-gray-700">${item.floor || '-'}</div></div>
             <div class="bg-gray-50 p-3 rounded-xl border border-gray-100"><span class="text-xs text-gray-400">ขนาด</span><div class="font-bold text-gray-700">${item.size || '-'}</div></div>
        </div>
        <div class="mb-4"><span class="text-xs text-gray-400">ชื่อ</span><div class="font-bold text-lg text-gray-800">${item.name}</div></div>
        <div class="space-y-3">
            <div><span class="text-xs text-gray-400">โทร 1</span><a href="tel:${item.phone1}" class="block text-blue-600 font-bold text-lg">${item.phone1 || '-'}</a></div>
            <div><span class="text-xs text-gray-400">โทร 2</span><a href="tel:${item.phone2}" class="block text-blue-600 font-bold text-lg">${item.phone2 || '-'}</a></div>
            <div><span class="text-xs text-gray-400">Note</span><div class="bg-gray-50 p-3 rounded-xl text-sm text-gray-600 border border-gray-100">${item.note || '-'}</div></div>
        </div>
      `;
    document.getElementById('ownerDetailViewControls').classList.remove('hidden'); document.getElementById('ownerDetailEditControls').classList.add('hidden'); document.getElementById('ownerDetailModal').classList.remove('hidden'); document.getElementById('ownerDetailModal').classList.add('flex');
}

function closeOwnerDetail() { document.getElementById('ownerDetailModal').classList.add('hidden'); document.getElementById('ownerDetailModal').classList.remove('flex'); }
function enableOwnerEdit() {
    requestAdminPin(() => {
        const item = currentRecord;
        document.getElementById('ownerDetailContent').innerHTML = `
         <div class="space-y-3">
            <input id="editOwnerRoom" class="w-full bg-gray-50 border border-gray-200 p-2 rounded text-gray-800" value="${item.room}" placeholder="ห้อง">
            <input id="editOwnerName" class="w-full bg-gray-50 border border-gray-200 p-2 rounded text-gray-800" value="${item.name}" placeholder="ชื่อ">
            <div class="grid grid-cols-2 gap-2">
                <input id="editOwnerFloor" class="w-full bg-gray-50 border border-gray-200 p-2 rounded text-gray-800" value="${item.floor}" placeholder="ชั้น">
                <input id="editOwnerSize" class="w-full bg-gray-50 border border-gray-200 p-2 rounded text-gray-800" value="${item.size}" placeholder="ขนาด">
            </div>
            <input id="editOwnerPhone1" class="w-full bg-gray-50 border border-gray-200 p-2 rounded text-gray-800" value="${item.phone1}" placeholder="Phone 1">
            <input id="editOwnerPhone2" class="w-full bg-gray-50 border border-gray-200 p-2 rounded text-gray-800" value="${item.phone2}" placeholder="Phone 2">
            <textarea id="editOwnerNote" class="w-full bg-gray-50 border border-gray-200 p-2 rounded text-gray-800">${item.note}</textarea>
         </div>
         <button onclick="deleteCurrentOwner()" class="w-full py-2 text-red-500 font-bold bg-red-50 rounded mt-4">ลบรายการ</button>
      `;
        document.getElementById('ownerDetailViewControls').classList.add('hidden'); document.getElementById('ownerDetailEditControls').classList.remove('hidden');
    });
}

function saveOwnerEdit() {
    const data = { id: currentRecord.id, room: document.getElementById('editOwnerRoom').value, name: document.getElementById('editOwnerName').value, floor: document.getElementById('editOwnerFloor').value, size: document.getElementById('editOwnerSize').value, phone1: document.getElementById('editOwnerPhone1').value, phone2: document.getElementById('editOwnerPhone2').value, note: document.getElementById('editOwnerNote').value };
    toggleLoading(true);
    // API Call: updateOwner
    runApi('updateOwner', data).then(res => {
        toggleLoading(false);
        if (res && res.success) { loadOwnerData(); closeOwnerDetail(); }
    });
}

function cancelOwnerEdit() { closeOwnerDetail(); }
function deleteCurrentOwner() {
    showConfirm("ลบรายการ", "ยืนยัน?", () => {
        toggleLoading(true);
        // API Call: deleteOwner
        runApi('deleteOwner', currentRecord.id).then(() => {
            toggleLoading(false);
            closeOwnerDetail();
            loadOwnerData();
        });
    });
}

function openAddOwnerModal() { requestAdminPin(() => { document.getElementById('addOwnerModal').classList.remove('hidden'); document.getElementById('addOwnerModal').classList.add('flex'); }); }
function closeAddOwnerModal() { document.getElementById('addOwnerModal').classList.add('hidden'); document.getElementById('addOwnerModal').classList.remove('flex'); }

function submitOwnerAdd() {
    const room = document.getElementById('addOwnerRoom').value;
    const name = document.getElementById('addOwnerName').value;
    if (!room || !name) return showAlert('แจ้งเตือน', 'กรอกข้อมูลให้ครบ');
    toggleLoading(true);
    // API Call: addOwner
    runApi('addOwner', { room, name, floor: document.getElementById('addOwnerFloor').value, size: document.getElementById('addOwnerSize').value, phone1: document.getElementById('addOwnerPhone1').value, phone2: document.getElementById('addOwnerPhone2').value, note: document.getElementById('addOwnerNote').value }).then(() => {
        toggleLoading(false);
        closeAddOwnerModal();
        loadOwnerData();
    });
}

// ==========================================
// --- 8. AI & SECURITY ---
// ==========================================
function requestAdminPin(cb) { pendingPinAction = cb; document.getElementById('pinInput').value = ''; document.getElementById('pinModal').classList.remove('hidden'); document.getElementById('pinModal').classList.add('flex'); }
function submitAdminPin() {
    const val = document.getElementById('pinInput').value;
    let correct = (pinCheckMode === 'ai' ? (val === AI_PIN) : (val === ADMIN_PIN));
    if (correct) {
        closePinModal();
        if (pendingPinAction) pendingPinAction();
        pinCheckMode = 'admin';
    } else {
        closePinModal();
        setTimeout(() => { showAlert('Error', 'รหัสผิด', 'error'); }, 200);
    }
}
function closePinModal() { document.getElementById('pinModal').classList.add('hidden'); document.getElementById('pinModal').classList.remove('flex'); pinCheckMode = 'admin'; }
/* ==========================================
   MANUAL PAYMENT QR GENERATOR
   Uses the exact same PromptPay/Biller payload builder
   as the existing parking-payment flow.
   ========================================== */
let manualQrCodeInstance = null;

function openPaymentQrGenerator() {
    const modal = document.getElementById('paymentQrGeneratorModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    const amount = document.getElementById('manualQrAmount');
    if (amount) setTimeout(() => amount.focus(), 150);
}

function closePaymentQrGenerator() {
    const modal = document.getElementById('paymentQrGeneratorModal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

function generateManualPaymentQR() {
    const amountInput = document.getElementById('manualQrAmount');
    const ref1Input = document.getElementById('manualQrRef1');
    const ref2Input = document.getElementById('manualQrRef2');
    const amount = Number(amountInput?.value);
    const ref1 = String(ref1Input?.value || '').trim();
    const ref2 = String(ref2Input?.value || '').trim();
    const payloadRef1 = ref1 || '788';

    if (!Number.isFinite(amount) || amount <= 0) {
        return showAlert('แจ้งเตือน', 'กรุณาระบุจำนวนเงินที่มากกว่า 0 บาท', 'error');
    }

    const container = document.getElementById('manualQrCode');
    if (!container) return;
    container.innerHTML = '';
    container.style.backgroundColor = '#ffffff';

    let payload;
    try {
        payload = generatePromptPayPayload(PROMPTPAY_CONFIG.billerId, amount, payloadRef1, ref2);
    } catch (err) {
        console.error('Manual QR payload error:', err);
        return showAlert('สร้าง QR ไม่สำเร็จ', 'ตรวจสอบ Biller ID ในระบบก่อนใช้งาน', 'error');
    }

    // Unhide result container BEFORE generating QR so canvas renders at correct dimensions
    const result = document.getElementById('manualQrResult');
    const form = document.getElementById('manualQrForm');
    if (form) form.classList.add('hidden');
    if (result) {
        result.classList.remove('hidden');
        result.scrollTop = 0;
    }

    let rendered = false;
    if (typeof QRCode !== 'undefined') {
        try {
            manualQrCodeInstance = new QRCode(container, {
                text: payload,
                width: 280,
                height: 280,
                colorDark: '#000000',
                colorLight: '#ffffff',
                correctLevel: (QRCode.CorrectLevel && typeof QRCode.CorrectLevel.M !== 'undefined')
                    ? QRCode.CorrectLevel.M : 0
            });
            // IMPORTANT: qrcode.min.js creates both a canvas (internal) and an img (display).
            // Hide canvas and show only img to prevent two elements rendering side-by-side
            // inside the flex container, which distorts the QR to an unscannable aspect ratio.
            const canvas = container.querySelector('canvas');
            const img = container.querySelector('img');
            if (canvas) {
                canvas.style.display = 'none';
            }
            if (img) {
                img.style.width = '280px';
                img.style.height = '280px';
                img.style.display = 'block';
                img.style.margin = '0 auto';
                img.style.imageRendering = 'auto';
            }
            rendered = !!(canvas || img);
        } catch (err) {
            console.warn('Manual QR render error:', err);
        }
    }

    if (!rendered) {
        const qrImg = document.createElement('img');
        qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=280x280&margin=4&data=${encodeURIComponent(payload)}`;
        qrImg.alt = 'Thai QR Payment';
        qrImg.className = 'payment-qr-fallback';
        container.appendChild(qrImg);
    }

    const setText = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.textContent = value || '-';
    };
    setText('manualQrAmountDisplay', `${amount.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บาท`);
    setText('manualQrAccountDisplay', 'Bangkok Horizon');
    setText('manualQrBillerDisplay', PROMPTPAY_CONFIG.billerId);
    setText('manualQrRef1Display', payloadRef1);
    setText('manualQrRef2Display', ref2 || '-');

    const modal = document.getElementById('paymentQrGeneratorModal');
    if (modal) {
        modal.classList.add('payment-qr-showing');
        modal.scrollTop = 0;
    }
    hapticFeedback(10);
}

function resetManualPaymentQR() {
    const form = document.getElementById('manualQrForm');
    const result = document.getElementById('manualQrResult');
    if (result) result.classList.add('hidden');
    if (form) form.classList.remove('hidden');
    const modal = document.getElementById('paymentQrGeneratorModal');
    if (modal) modal.classList.remove('payment-qr-showing');
    const qr = document.getElementById('manualQrCode');
    if (qr) qr.innerHTML = '';
}

/* ==========================================
   THEME / DISPLAY SETTINGS
   ========================================== */
function getThemePreference() {
    try {
        const saved = localStorage.getItem('bhr-theme');
        return saved === 'dark' ? 'dark' : 'light';
    } catch (e) { return 'light'; }
}

function isDarkTheme() {
    return getThemePreference() === 'dark';
}

function applyTheme(preference, persist = true) {
    const value = preference === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = value;
    if (persist) {
        try { localStorage.setItem('bhr-theme', value); } catch (e) {}
    }
    updateThemeChecks();
}

function updateThemeChecks() {
    const current = getThemePreference();
    ['Light', 'Dark'].forEach(name => {
        const el = document.getElementById('themeCheck' + name);
        if (el) el.classList.toggle('hidden', current !== name.toLowerCase());
    });
}

function openSettings() {
    const modal = document.getElementById('settingsModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    updateThemeChecks();
    const version = document.getElementById('appVersionText');
    if (version) version.textContent = 'v' + BHR_APP_VERSION;
}

function closeSettings() {
    const modal = document.getElementById('settingsModal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

function setTheme(preference) {
    applyTheme(preference);
    closeSettings();
}

applyTheme(getThemePreference(), false);

function openAiMode() { pinCheckMode = 'ai'; requestAdminPin(() => openAppSubPage('ai')); }
function goToAiAccounting() { document.getElementById('aiMenuSubPage').classList.add('hidden'); document.getElementById('aiAccountingSubPage').classList.remove('hidden'); }
function backFromAiAccounting() { document.getElementById('aiAccountingSubPage').classList.add('hidden'); document.getElementById('aiMenuSubPage').classList.remove('hidden'); }

function handleCheckAccounting() {
    const start = document.getElementById('accStartDate').value;
    const end = document.getElementById('accEndDate').value;
    if (!start || !end) return showAlert('แจ้งเตือน', 'เลือกวันที่');
    toggleLoading(true);
    // API Call: getAccountingReport
    runApi('getAccountingReport', { start: start, end: end }).then(res => {
        toggleLoading(false);
        if (res) renderAccountingResult(res);
    });
}

// Render Accounting Result as a nice Table
function renderAccountingResult(data) {
    // Sort by Exit Time (Ascending)
    if (data.details && data.details.length > 0) {
        data.details.sort((a, b) => (a.exitTime || "").localeCompare(b.exitTime || ""));
    }

    currentAccData = data;
    document.getElementById('accTotalPrice').innerText = data.summary.totalPrice.toLocaleString();
    const c = document.getElementById('accListContainer');
    document.getElementById('accResultArea').classList.remove('hidden');

    if (data.details.length === 0) {
        c.innerHTML = '<div class="text-center p-4 text-white/50">ไม่มีข้อมูลในช่วงเวลานี้</div>';
        return;
    }

    // Header Table
    let html = `
        <div class="overflow-x-auto rounded-lg">
            <table class="w-full text-xs text-left text-gray-800 bg-white rounded-lg overflow-hidden">
                <thead class="text-xs text-gray-600 uppercase bg-gray-100 border-b border-gray-200">
                    <tr>
                        <th class="px-2 py-2">ห้อง/ทะเบียน</th>
                        <th class="px-2 py-2 text-center">เวลาออก</th>
                        <th class="px-2 py-2 text-right">ราคา</th>
                    </tr>
                </thead>
                <tbody>
      `;

    // Rows
    data.details.forEach((d, index) => {
        html += `
            <tr onclick="openAccDetail(${index})" class="bg-white border-b hover:bg-blue-50 cursor-pointer transition">
                <td class="px-2 py-2 font-medium text-gray-900">
                    ${d.roomNo}<br><span class="text-[10px] text-gray-500">${d.cardId}</span>
                </td>
                <td class="px-2 py-2 text-center">${d.exitTime}</td>
                <td class="px-2 py-2 text-right font-bold text-green-600">${d.price.toLocaleString()}</td>
            </tr>
          `;
    });

    html += `
                </tbody>
            </table>
        </div>
      `;

    c.innerHTML = html;
}

// Open Accounting Detail Modal (View Only)
function openAccDetail(index) {
    const item = currentAccData.details[index];
    if (!item) return showAlert('Error', 'ไม่พบข้อมูล');

    currentRecord = item;
    isHistoryEditMode = false; // Force read-only

    const content = document.getElementById('histDetailContent');
    content.innerHTML = `
        <div class="grid grid-cols-2 gap-4">
            <div class="bg-gray-50 p-3 rounded-2xl text-center"><span class="text-xs text-gray-400 font-bold">เลขบัตร</span><div class="font-bold text-xl text-gray-800">${item.cardId}</div></div>
            <div class="bg-gray-50 p-3 rounded-2xl text-center"><span class="text-xs text-gray-400 font-bold">เลขห้อง</span><div class="font-bold text-xl text-gray-800">${item.roomNo}</div></div>
        </div>
        <div class="bg-white border border-gray-100 p-4 rounded-2xl space-y-2 mt-4 shadow-sm">
            <div class="flex justify-between"><span class="text-gray-400 text-xs font-bold uppercase">เข้า</span><div class="text-right"><span class="font-bold text-lg text-gray-800">${item.entryTime || '-'}</span></div></div>
            <div class="flex justify-between border-t border-gray-100 pt-2"><span class="text-gray-400 text-xs font-bold uppercase">ออก</span><div class="text-right"><span class="font-bold text-lg text-gray-800">${item.exitTime || '-'}</span></div></div>
        </div>
        <div class="bg-red-50 p-4 rounded-2xl flex justify-between items-center border border-red-100 mt-4"><span class="text-red-500 font-bold text-sm">ยอดชำระ</span><span class="text-red-600 font-extrabold text-2xl">${item.price} ฿</span></div>
        <div class="grid grid-cols-3 gap-2 mt-2">
            ${createImgBlock('Plate', 'car-side', 'รถ', item.plateImg)}
            ${createImgBlock('Id', 'id-card', 'บัตร', item.idCardImg)}
            ${createImgBlock('Slip', 'file-invoice', 'สลิป', item.slipImg)}
        </div>
        
        <button onclick="closeHistoryDetail()" class="w-full py-3 bg-gray-100 text-gray-600 rounded-xl mt-4 font-bold active:bg-gray-200">ปิด</button>
      `;

    // Hide all control bars (Edit/Print) to ensure View Only
    document.getElementById('histDetailViewControls').classList.add('hidden');
    document.getElementById('histDetailEditControls').classList.add('hidden');

    document.getElementById('historyDetailModal').classList.remove('hidden');
    document.getElementById('historyDetailModal').classList.add('flex');
    toggleMainDock(false);
}

// Professional Print Report
function printAccountingReport() {
    if (!currentAccData) return;
    const w = window.open('', '', 'width=900,height=1000');

    const rows = currentAccData.details.map((d, i) => `
        <tr>
            <td style="text-align: center;">${i + 1}</td>
            <td>${d.roomNo} <small style="color:#666">(${d.cardId})</small></td>
            <td style="text-align: center;">${d.exitTime}</td>
            <td style="text-align: right;">${d.price.toLocaleString()}</td>
        </tr>
      `).join('');

    const printDate = new Date().toLocaleString('th-TH');

    w.document.write(`
        <html>
        <head>
            <title>รายงานสรุปรายได้</title>
            <link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@300;400;700&display=swap" rel="stylesheet">
            <style>
                @media print {
                    @page { size: A4; margin: 2cm; }
                    body { -webkit-print-color-adjust: exact; }
                }
                body { font-family: 'Sarabun', sans-serif; padding: 40px; color: #333; }
                
                .header { text-align: center; margin-bottom: 20px; border-bottom: 2px solid #333; padding-bottom: 20px; }
                .header h1 { margin: 0; font-size: 24px; font-weight: bold; }
                .header p { margin: 5px 0; font-size: 14px; color: #555; }
                
                .meta { display: flex; justify-content: space-between; margin-bottom: 20px; font-size: 12px; color: #555; }
                
                table { width: 100%; border-collapse: collapse; margin-top: 10px; }
                th, td { border: 1px solid #ddd; padding: 10px; font-size: 14px; }
                th { background-color: #f0f0f0 !important; text-align: left; font-weight: bold; color: #333; }
                tr:nth-child(even) { background-color: #fcfcfc !important; }
                
                .summary-box { 
                    margin-top: 30px; 
                    text-align: right; 
                    border: 1px solid #ddd;
                    background-color: #f9f9f9 !important;
                    padding: 15px;
                    border-radius: 8px;
                    width: 300px;
                    margin-left: auto;
                }
                .summary-total { font-size: 20px; font-weight: bold; color: #000; margin-top: 5px; }
                
                .footer { margin-top: 60px; display: flex; justify-content: space-between; text-align: center; padding: 0 50px; }
                .signature-line { border-top: 1px solid #000; width: 200px; margin: 0 auto; margin-top: 40px; }
            </style>
        </head>
        <body>
            <div class="header">
                <h1>รายงานสรุปรายได้ค่าจอดรถ</h1>
                <p>โครงการ BHR.LAB PARKING</p>
            </div>
            
            <div class="meta">
                <span>ช่วงวันที่: ${currentAccData.summary.startDate} - ${currentAccData.summary.endDate}</span>
                <span>พิมพ์เมื่อ: ${printDate}</span>
            </div>

            <table>
                <thead>
                    <tr>
                        <th style="width: 50px; text-align: center;">#</th>
                        <th>ห้อง / ทะเบียน</th>
                        <th style="width: 150px; text-align: center;">เวลาออก</th>
                        <th style="width: 100px; text-align: right;">ราคา (บาท)</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows}
                </tbody>
            </table>
            
            <div class="summary-box">
                <p style="margin:0; font-size:12px; color:#666;">จำนวนรถทั้งหมด: ${currentAccData.summary.totalCars} คัน</p>
                <div class="summary-total">รวมสุทธิ: ${currentAccData.summary.totalPrice.toLocaleString()} บาท</div>
            </div>

            <div class="footer">
                <div>
                    <div class="signature-line"></div>
                    <p style="font-size:12px; margin-top:5px;">ผู้จัดทำรายงาน</p>
                </div>
                <div>
                    <div class="signature-line"></div>
                    <p style="font-size:12px; margin-top:5px;">ผู้ตรวจสอบ</p>
                </div>
            </div>
        </body>
        </html>
      `);
    w.document.close();
    setTimeout(() => { w.focus(); w.print(); w.close(); }, 500);
}

function handleQuickSearch(queryArg = null) {
    const input = document.getElementById('quickSearchInput');
    const val = queryArg !== null ? queryArg : (input ? input.value : '');

    if (!val || val.trim() === "") return;

    toggleLoading(true);
    // API Call: quickSearchVehicle
    runApi('quickSearchVehicle', val).then(res => {
        toggleLoading(false);
        renderQuickSearchResults(res, val);
    });
}

function renderQuickSearchResults(res, query) {
    const modal = document.getElementById('quickSearchModal');
    const container = document.getElementById('quickSearchResultContent');
    container.innerHTML = '';

    if (!res.found || res.results.length === 0) {
        container.innerHTML = `<div class="text-center py-8 text-gray-400">ไม่พบข้อมูล "${query}"</div>`;
    } else {
        res.results.forEach(item => {
            const isTemp = item.type === 'temp';
            const icon = isTemp ? 'clock' : 'car';
            const color = isTemp ? 'orange' : 'green';

            container.innerHTML += `
                <div class="bg-white border border-gray-100 p-4 rounded-2xl flex items-start gap-4 shadow-sm hover:shadow-md transition">
                    <div class="w-12 h-12 rounded-full bg-${color}-50 text-${color}-600 flex items-center justify-center shrink-0">
                        <i class="fas fa-${icon} text-xl"></i>
                    </div>
                    <div class="flex-1">
                        <div class="flex justify-between items-start">
                            <h4 class="font-bold text-gray-800 text-lg">${item.plate}</h4>
                            <span class="text-[10px] font-bold px-2 py-1 rounded-full bg-gray-100 text-gray-500">${item.source}</span>
                        </div>
                        <div class="text-sm text-gray-600 font-medium">ห้อง ${item.room}</div>
                        <div class="text-xs text-gray-400 mt-1">${item.name} ${item.phone}</div>
                        <div class="text-xs text-blue-500 mt-1">${item.info || ''}</div>
                        ${item.note ? `<div class="mt-2 text-xs bg-gray-50 p-2 rounded text-gray-500">${item.note}</div>` : ''}
                    </div>
                </div>
             `;
        });
    }

    modal.classList.remove('hidden');
    modal.classList.add('flex');
}
function closeQuickSearchModal() { document.getElementById('quickSearchModal').classList.add('hidden'); document.getElementById('quickSearchModal').classList.remove('flex'); }

// ==========================================
// --- 9. CAMERA & HELPERS ---
// ==========================================
function viewFullImage(src) { document.getElementById('fullImagePreview').src = src; document.getElementById('fullImageModal').classList.remove('hidden'); }
function closeFullImage() { document.getElementById('fullImageModal').classList.add('hidden'); }
function triggerFileUpload(t) { targetPhotoType = t; document.getElementById('fileInput').click(); }
function handleFileSelect(inp) { if (inp.files && inp.files[0]) { toggleLoading(true); const r = new FileReader(); r.onload = (e) => { toggleLoading(false); savePhoto(e.target.result); }; r.readAsDataURL(inp.files[0]); } inp.value = ''; }

function savePhoto(b64) {
    if (targetPhotoType === 'plate') { currentPlateImg = b64; document.getElementById('platePreview').src = b64; document.getElementById('platePreview').classList.remove('hidden'); document.getElementById('platePlaceholder').classList.add('hidden'); }
    else if (targetPhotoType === 'slip') { currentSlipImg = b64; document.getElementById('slipPreview').src = b64; document.getElementById('slipPreview').classList.remove('hidden'); document.getElementById('slipPlaceholder').classList.add('hidden'); }
    else if (targetPhotoType.includes('license_add')) { licenseAddImg = b64; document.getElementById('licImgPreview').src = b64; document.getElementById('licImgPreview').classList.remove('hidden'); document.getElementById('licImgPlaceholder').classList.add('hidden'); }
    else if (targetPhotoType === 'license_update') {
        licenseEditImg = b64;
        document.getElementById('editLicImgPreview').src = b64;
        document.getElementById('editLicImgPreview').classList.remove('hidden');
        document.getElementById('editLicImgPlaceholder').classList.add('hidden');
    }
    else if (targetPhotoType.includes('temp')) { tempAddPlateImg = b64; document.getElementById('addTempImgPreview').src = b64; document.getElementById('addTempImgPreview').classList.remove('hidden'); document.getElementById('addTempImgPlaceholder').classList.add('hidden'); }
    else if (targetPhotoType.startsWith('history_')) {
        const type = targetPhotoType.replace('history_', '');
        toggleLoading(true);
        // API Call: saveRecordImage
        runApi('saveRecordImage', { sheetName: currentRecord.sheetName || 'Visitor_Log', rowIndex: currentRecord.rowIndex, cardId: currentRecord.cardId, imageType: type, base64: b64 }).then(res => {
            toggleLoading(false);
            if (res && res.success) {
                // Show image immediately after save
                const capType = type.charAt(0).toUpperCase() + type.slice(1);
                const imgEl = document.getElementById('histDetail' + capType + 'Img');
                const placeEl = document.getElementById('histDetail' + capType + 'Placeholder');
                if (imgEl) { imgEl.src = res.url; imgEl.classList.remove('hidden'); }
                if (placeEl) { placeEl.classList.add('hidden'); }

                // Update Local Data Immediately
                if (currentRecord) {
                    if (type === 'id') currentRecord.idCardImg = res.url;
                    else if (type === 'plate') currentRecord.plateImg = res.url;
                    else if (type === 'slip') currentRecord.slipImg = res.url;
                }
                if (selectedHistoryIndex !== -1 && currentHistoryList[selectedHistoryIndex]) {
                    if (type === 'id') currentHistoryList[selectedHistoryIndex].idCardImg = res.url;
                    else if (type === 'plate') currentHistoryList[selectedHistoryIndex].plateImg = res.url;
                    else if (type === 'slip') currentHistoryList[selectedHistoryIndex].slipImg = res.url;
                }
            }
        });
    }
}

function openCamera(t) { targetPhotoType = t; document.getElementById('cameraModal').classList.remove('hidden'); document.getElementById('cameraModal').classList.add('flex'); initCam(); }
function closeCamera() { document.getElementById('cameraModal').classList.add('hidden'); document.getElementById('cameraModal').classList.remove('flex'); }
function initCam() { navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }).then(s => { const v = document.getElementById('cameraVideo'); v.srcObject = s; v.play(); cameraStream = s; }); }
function takePhoto() { const v = document.getElementById('cameraVideo'); const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext('2d').drawImage(v, 0, 0); savePhoto(c.toDataURL('image/jpeg', 0.7)); closeCamera(); }
function startQrScanner() { document.getElementById('qrModal').classList.remove('hidden'); document.getElementById('qrModal').classList.add('flex'); html5QrCode = new Html5Qrcode("reader"); html5QrCode.start({ facingMode: "environment" }, { fps: 10, qrbox: 250 }, (t) => { stopQrScanner(); document.getElementById('visitorCardId').value = t; handleVisitorAction(); }); }
function stopQrScanner() { if (html5QrCode) html5QrCode.stop().then(() => { html5QrCode.clear(); document.getElementById('qrModal').classList.add('hidden'); document.getElementById('qrModal').classList.remove('flex'); }); }
