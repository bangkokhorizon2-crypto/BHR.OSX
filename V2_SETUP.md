# BHR.LAB V2 — Safe Parallel Test Setup

## เป้าหมาย
V2 ใช้ Google Sheet และ Google Drive folder เดิม แต่แยก Google Apps Script deployment และ Netlify site ออกจากระบบเก่า เพื่อให้ทดสอบได้โดยไม่ต้องปิดเว็บ production

## 1) สร้าง Google Apps Script V2
1. เปิด Apps Script project เดิมหรือสร้าง project ใหม่แล้วใส่ `code.gs` ของ V2
2. Save
3. รันฟังก์ชัน `initializeBhrV2Config()` **ครั้งเดียว**
4. อนุญาตสิทธิ์ Google Drive/Sheets ตามที่ Google ขอ
5. ถ้าสำเร็จ Execution log จะบอก Folder ID และ Spreadsheet ID ที่ V2 ผูกไว้
6. Deploy > New deployment > Web app
7. Execute as: Me
8. Who has access: ตั้งค่าให้เหมือนระบบเก่าที่ใช้งานได้ (เช่น Anyone หากระบบเดิมใช้แบบนั้น)
9. คัดลอก URL `/exec` ของ V2

> สำคัญ: V2 จะไม่สร้าง folder หรือ spreadsheet ใหม่โดยอัตโนมัติ ถ้าหา DB เดิมไม่เจอ จะหยุดและแจ้ง error เพื่อป้องกันฐานข้อมูลแยกโดยไม่ตั้งใจ

## 2) ผูก Netlify V2 กับ GAS V2
เปิด `config.js` แล้วเปลี่ยน:

`PASTE_V2_GAS_WEB_APP_URL_HERE`

เป็น URL `/exec` ของ V2 เช่น `https://script.google.com/macros/s/XXXX/exec`

จากนั้น deploy โฟลเดอร์นี้เป็น Netlify site ใหม่

## 3) ทดสอบก่อนให้พนักงานใช้
- เปิด V2 บน iPhone/Safari ก่อน
- ต้องเห็นหน้า “กำลังเชื่อมต่อระบบ…” แล้วเปลี่ยนเป็นพร้อมใช้งาน
- ทดสอบดูผู้มาติดต่อ, ชั่วคราว, ทะเบียน, เจ้าของ
- ทดสอบบันทึกเข้า/ออกและรูปภาพอย่างระมัดระวัง

## 4) เว็บเก่ายังใช้งานได้
V2 ใช้ deployment คนละตัว แต่ใช้ Spreadsheet/Folder เดิม ดังนั้นเว็บเก่าจะไม่ถูกเปลี่ยน URL หรือ code โดยอัตโนมัติ

## 5) ข้อควรระวัง
ถ้า V2 และเว็บเก่าเขียนข้อมูลลง Sheet เดียวกันพร้อมกัน V2 จะ serialize write requests ของตัวเองด้วย LockService แต่เว็บเก่าไม่มี lock เดียวกัน หากช่วงทดสอบมีการเขียนพร้อมกับพนักงานจริง ให้ทดสอบอย่างระมัดระวังและอย่าทำรายการสำคัญซ้ำจากสองเว็บพร้อมกัน
