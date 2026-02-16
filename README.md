# LINE Chatbot with Gemini & Notion

## สิ่งที่ต้องแก้ไขใน Code
1. ไฟล์ `.env`: ใส่ Key ต่างๆ
2. ไฟล์ `index.js`: ตรงฟังก์ชัน `addToNotion` ต้องเปลี่ยนชื่อ Property (`Name`, `Date`) ให้ตรงกับชื่อ Column ใน Notion Database ของคุณ

## วิธีใช้งาน
1. รัน `npm install` เพื่อลงโปรแกรม
2. รัน `npm run dev` เพื่อเริ่มระบบ (สำหรับเทสในเครื่อง)

## การ Deploy (Cloud ล้วน)
แนะนำให้ใช้ **Render** หรือ **Vercel** (ฟรี) เชื่อมกับ GitHub Repo นี้
- **Render**: เลือก Web Service -> Build Command `npm install` -> Start Command `node index.js`
- **Environment Variables**: ตอน Deploy อย่าลืมใส่ค่าจาก `.env` ลงไปในตั้งค่าของ Server ด้วย
