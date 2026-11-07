// test-models.js — Thử các model flash để tìm model hoạt động ổn định
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const CANDIDATES = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
];

(async () => {
  for (const m of CANDIDATES) {
    const t0 = Date.now();
    try {
      const model = genAI.getGenerativeModel({ model: m });
      const res = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: 'Nhiệt độ ngoài trời hôm nay khoảng bao nhiêu?' }] }],
        generationConfig: { maxOutputTokens: 200, temperature: 0.7 },
      });
      const text = res.response.text();
      console.log(`[OK]   ${m} (${Date.now() - t0}ms) -> ${text.slice(0, 90).replace(/\n/g, ' ')}`);
    } catch (err) {
      console.log(`[FAIL] ${m} (${Date.now() - t0}ms) status=${err.status || '?'} :: ${String(err.message).slice(0, 150)}`);
    }
  }
})();
