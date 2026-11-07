// test-models-vi.js — Thử model với đúng system prompt tiếng Việt của dự án
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const SYSTEM = `Bạn là trợ lý AI chuyên về thời tiết và môi trường.
Quy tắc: Trả lời bằng tiếng Việt, ngắn gọn, thân thiện.
DỮ LIỆU HỆ THỐNG HIỆN TẠI:
- Nhiệt độ: 29.0°C
- Độ ẩm: 68%
- Ánh sáng: 592 lux`;

const CANDIDATES = ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'];

(async () => {
  for (const m of CANDIDATES) {
    const t0 = Date.now();
    try {
      const model = genAI.getGenerativeModel({ model: m });
      const res = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: SYSTEM + '\n\nCâu hỏi của người dùng: Thời tiết hôm nay thế nào?' }] }],
        generationConfig: { maxOutputTokens: 300, temperature: 0.7 },
      });
      console.log(`\n[OK] ${m} (${Date.now() - t0}ms):\n${res.response.text().slice(0, 250)}`);
    } catch (err) {
      console.log(`[FAIL] ${m} (${Date.now() - t0}ms) status=${err.status || '?'}`);
    }
  }
})();
