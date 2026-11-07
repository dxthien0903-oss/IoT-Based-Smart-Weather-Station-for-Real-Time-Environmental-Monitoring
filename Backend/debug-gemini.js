// debug-gemini.js — Thử các model Gemini hiện hành
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

const key = process.env.GEMINI_API_KEY || '';
const genAI = new GoogleGenerativeAI(key);

// Liệt kê model khả dụng
(async () => {
  try {
    const list = await genAI.models.list();
    const names = list.models.map((m) => m.name).filter((n) => n.includes('generateContent'));
    console.log('=== MODELS KHẢ DỤNG (generateContent) ===');
    names.forEach((n) => console.log('  ', n));
  } catch (e) {
    console.log('List thất bại:', e.message);
  }

  const CANDIDATES = [
    'gemini-3.8-flash',
    'gemini-3.5-flash-lite',
    'gemini-2.5-flash-lite',
    'gemini-flash-latest',
  ];

  console.log('\n=== THỬ TỪNG MODEL ===');
  for (const m of CANDIDATES) {
    try {
      const model = genAI.getGenerativeModel({ model: m });
      const res = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: 'Chào, bạn khoẻ không?' }] }],
        generationConfig: { maxOutputTokens: 128, temperature: 0.7 },
      });
      console.log(`[OK] ${m} ->`, res.response.text().slice(0, 100));
    } catch (err) {
      console.log(`[FAIL] ${m} (${err.status || '?'}) ${String(err.message).slice(0, 200)}`);
    }
  }
})();
