// list-models.js — Liệt kê model Gemini khả dụng qua REST API
require('dotenv').config();
const key = process.env.GEMINI_API_KEY;

(async () => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) {
    console.log('HTTP', res.status, JSON.stringify(data).slice(0, 300));
    return;
  }
  const names = data.models
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace('models/', ''));
  console.log('=== MODELS HỖ TRỢ generateContent ===');
  names.forEach((n) => console.log('  ', n));
})();
