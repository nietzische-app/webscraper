/**
 * Tiny static site used by the smoke test: a contact page with leads, a
 * paginated product listing, an HTML table and a page with images.
 */
import http from "node:http";
import { Buffer } from "node:buffer";

import zlib from "node:zlib";

/** Builds a real PNG so the image-download filters (size in px and bytes) get exercised. */
function makePng(width, height, seed = 0) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0; // filter type: none
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      raw[offset] = (x * 7 + seed) % 256;
      raw[offset + 1] = (y * 5 + seed) % 256;
      raw[offset + 2] = (x * y + seed) % 256;
      offset += 3;
    }
  }

  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) : crc32(body));
    return Buffer.concat([length, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const SMALL_PNG = makePng(16, 16);
const largePngCache = new Map();

/** Distinct bytes per path, so identical-content de-duplication stays testable. */
function largePng(key) {
  let png = largePngCache.get(key);
  if (!png) {
    png = makePng(640, 480, key.length * 13 + (key.charCodeAt(key.length - 5) || 0));
    largePngCache.set(key, png);
  }
  return png;
}

const contactPage = `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><title>İletişim — Test Ltd.</title>
<meta name="description" content="Bize ulaşın"></head>
<body>
  <h1>İletişim</h1>
  <p>Genel sorular: <a href="mailto:info@test-firma.com">info@test-firma.com</a></p>
  <p>Satış ekibi: sales@test-firma.com</p>
  <p>Destek: destek [at] test-firma [dot] com</p>
  <p>Telefon: <a href="tel:+902121234567">+90 212 123 45 67</a></p>
  <p>GSM: 0532 987 65 43</p>
  <p>Sipariş no: 8471294 — bu bir telefon değildir.</p>
  <img src="/logo@2x.png" alt="logo">
  <address>Levent Mah. Büyükdere Cad. No:120, 34394 İstanbul</address>
  <a href="https://www.linkedin.com/company/test-firma">LinkedIn</a>
  <a href="https://instagram.com/testfirma">Instagram</a>
</body></html>`;

const homePage = `<!doctype html>
<html><head><meta charset="utf-8"><title>Test Ltd. — Ana Sayfa</title></head>
<body>
  <h1>Test Ltd.</h1>
  <p>Merhaba, biz bir test firmasıyız.</p>
  <nav><a href="/iletisim">İletişim</a> <a href="/urunler?page=1">Ürünler</a></nav>
</body></html>`;

function productsPage(page) {
  const items = Array.from({ length: 6 }, (_, i) => {
    const n = (page - 1) * 6 + i + 1;
    return `<div class="product-card">
      <h3 class="title">Ürün ${n}</h3>
      <span class="price">1.${n}99,90 TL</span>
      <a href="/urun/${n}">Detay</a>
      <img src="/img/urun-${n}.png" srcset="/img/urun-${n}-small.png 300w, /img/urun-${n}-large.png 1200w" alt="Ürün ${n}">
    </div>`;
  }).join("\n");
  const next = page < 3 ? `<a rel="next" href="/urunler?page=${page + 1}">Sonraki</a>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Ürünler ${page}</title></head>
  <body><h1>Ürünler</h1><div class="product-list">${items}</div><div class="pagination">${next}</div></body></html>`;
}

const tablePage = `<!doctype html><html><head><meta charset="utf-8"><title>Fiyat Listesi</title></head>
<body><table>
  <thead><tr><th>Model</th><th>Stok</th><th>Fiyat</th></tr></thead>
  <tbody>
    <tr><td>A-100</td><td>12</td><td>$199.99</td></tr>
    <tr><td>B-200</td><td>4</td><td>$249.50</td></tr>
    <tr><td>C-300</td><td>0</td><td>$1,299.00</td></tr>
  </tbody>
</table></body></html>`;

const galleryPage = `<!doctype html><html><head><meta charset="utf-8"><title>Galeri</title></head>
<body>
  <img src="/img/big-1.png" width="800" height="600" alt="Büyük 1">
  <img src="/img/big-2.png" width="1200" height="900" alt="Büyük 2">
  <img src="/img/icon.png" width="16" height="16" alt="ikon">
</body></html>`;

export function startFixtureServer(port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path.startsWith("/img/") || path.endsWith(".png")) {
      const body = path.includes("icon") || path.includes("small") ? SMALL_PNG : largePng(path);
      res.writeHead(200, { "content-type": "image/png", "content-length": body.length });
      return res.end(body);
    }

    const html = (body) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    };

    if (path === "/" ) return html(homePage);
    if (path === "/iletisim") return html(contactPage);
    if (path === "/urunler") return html(productsPage(Number(url.searchParams.get("page") ?? 1)));
    if (path === "/tablo") return html(tablePage);
    if (path === "/galeri") return html(galleryPage);

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}
