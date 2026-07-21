# MathVision Lab — Sourdough Pore Analyzer (Complete)

เว็บแอปแบบ Local-first สำหรับวิเคราะห์รูพรุนขนมปังซาวโดว์และใช้เป็นสื่อการเรียนรู้เรขาคณิต แคลคูลัส และการสร้างแบบจำลอง

## จุดเด่น
- ไม่ต้องติดตั้ง dependency เพิ่ม
- ใช้ Node.js ที่ติดตั้งอยู่แล้วเปิดเว็บด้วย `npm run dev`
- ประมวลผลภาพทั้งหมดในเบราว์เซอร์
- ข้อมูลคลังถูกเก็บใน Local Storage ของเครื่อง

## ความสามารถ
### Image Analysis
- อัปโหลดภาพและภาพทดลอง
- Zoom / Pan
- Calibration แบบลากเส้น 2 จุด
- ROI วงรีและสี่เหลี่ยม
- Threshold แบบ Manual และ Otsu
- Morphological cleaning
- Connected components
- พื้นที่ เส้นรอบรูป Equivalent diameter Circularity Porosity
- ตารางข้อมูลรายรูและ CSV

### Geometry Approximation Lab
- Circle, Ellipse, Rectangle และ Polygon
- พื้นที่ประมาณแบบ Union
- Percent Error
- Intersection over Union (IoU)

### Calculus Lab
- Left / Midpoint / Right Riemann Sum
- Trapezoidal Rule
- ปรับจำนวนช่วง n
- Error convergence

### Repository & Dashboard
- บันทึกข้อมูลกลุ่ม ตัวอย่าง Series เวลาหมัก อุณหภูมิ Hydration และหมายเหตุ
- เก็บตัวอย่างในเบราว์เซอร์
- ส่งออก/นำเข้า JSON
- Summary CSV
- กราฟการเปลี่ยนแปลงตามเวลา
- Finite-difference derivative
- พิมพ์รายงานหรือ Save as PDF

## การรัน
```bash
npm run dev
```
เปิด `http://localhost:5173`

## การเผยแพร่
ไฟล์ `index.html`, `styles.css` และ `app.js` เป็น Static Web App สามารถอัปโหลดขึ้น Tiiny Host, Netlify, GitHub Pages หรือบริการ Static Hosting อื่นได้โดยตรง

## ข้อจำกัดของเวอร์ชัน Local-first
- ยังไม่มีบัญชีนักเรียนและฐานข้อมูลกลางระหว่างหลายเครื่อง
- Local Storage มีพื้นที่จำกัด ควรส่งออก JSON สำรองเป็นระยะ
- การตรวจหารูพรุนขึ้นกับคุณภาพแสง มุมกล้อง ROI และ Threshold
