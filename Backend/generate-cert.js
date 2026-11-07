// generate-cert.js — Tạo chứng thư tự ký cho HTTPS local (chỉ dùng cho LAN/demo)
// Chạy: node generate-cert.js
// Kết quả: certs/key.pem + certs/cert.pem
//
// LƯU Ý: chứng thư tự ký KHÔNG được tin cậy bởi trình duyệt/ESP8266.
// Với production thật, hãy dùng Let's Encrypt qua Caddy (xem Caddyfile).
//
// Cần: npm install selfsigned   (đã có trong devDependencies)

const fs = require('fs');
const path = require('path');
const selfsigned = require('selfsigned');

const CERT_DIR = path.join(__dirname, 'certs');
const KEY_PATH = path.join(CERT_DIR, 'key.pem');
const CERT_PATH = path.join(CERT_DIR, 'cert.pem');

if (!fs.existsSync(CERT_DIR)) fs.mkdirSync(CERT_DIR, { recursive: true });

if (fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH)) {
  console.log('Chứng thư đã tồn tại trong certs/. Xóa thư mục certs/ nếu muốn tạo lại.');
  process.exit(0);
}

// Lấy IP LAN hiện tại để thêm vào SAN (để ESP8268 trong cùng mạng kết nối được)
const os = require('os');
const lanIPs = Object.values(os.networkInterfaces())
  .flat()
  .filter((n) => n && n.family === 'IPv4' && !n.internal)
  .map((n) => n.address);

const altNames = [
  { type: 2, value: 'localhost' },
  { type: 7, ip: '127.0.0.1' },
  ...lanIPs.map((ip) => ({ type: 7, ip })),
];

selfsigned
  .generate([{ name: 'commonName', value: 'localhost' }], {
    days: 365,
    keySize: 2048,
    extensions: [{ name: 'subjectAltName', altNames }],
  })
  .then((pems) => {
    fs.writeFileSync(KEY_PATH, pems.private);
    fs.writeFileSync(CERT_PATH, pems.cert);
    console.log('Đã tạo chứng thư tự ký trong certs/');
    console.log('  key.pem  (private key — KHÔNG commit lên GitHub)');
    console.log('  cert.pem (certificate)');
    console.log('IP LAN đã thêm vào SAN: ' + (lanIPs.join(', ') || 'không có'));
    console.log('\nBật HTTPS:');
    console.log('  SSL_KEY_PATH=./certs/key.pem');
    console.log('  SSL_CERT_PATH=./certs/cert.pem');
  })
  .catch((err) => {
    console.error('Lỗi tạo chứng thư:', err.message);
    process.exit(1);
  });
