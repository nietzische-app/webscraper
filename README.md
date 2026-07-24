# Universal Web Scraper — MCP Server + Web Dashboard

Ücretsiz ve limitsiz bir web scraping altyapısı. Arka planda gerçek bir Chromium
tarayıcısı (Playwright) çalıştırır ve **iki arayüz** sunar:

1. **MCP sunucusu** (`npm start`) — Claude Desktop, Claude Code veya Cursor içinden doğal dille.
2. **Web paneli + HTTP API** (`npm run serve`) — sunucunda çalışır, tarayıcıdan yönetirsin.

İkisi de aynı `scraper.ts` / `exporter.ts` motorunu kullanır.

**Yetenekler**

| Araç | Ne yapar |
| --- | --- |
| `scrape_page` / API `text` | Sayfanın okunabilir metnini, başlıklarını, meta verisini ve linklerini çeker |
| `extract_leads` / API `leads` | E-posta, telefon, sosyal medya ve adres bilgilerini toplar (iletişim sayfalarını da gezer) |
| `extract_list` / API `list` | Ürün listeleri, arama sonuçları, dizinler ve HTML tabloları → JSON dizisi (sayfalama destekli) |
| `download_images` / API `images` | Sayfadaki görselleri en yüksek çözünürlüklü hâliyle diske indirir |
| `export_to_file` | Çekilen veriyi `.csv` veya `.json` olarak kaydeder |
| `list_datasets` | Oturumdaki veri setlerini listeler |

---

## Kurulum

```bash
git clone <repo-url> webscraper
cd webscraper
npm install          # Chromium'u da indirir (postinstall)
npm run build
```

Chromium indirmesini atlamak ve bilgisayarındaki mevcut Chrome'u kullanmak istersen:

```bash
npm install --ignore-scripts
export SCRAPER_CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

Testleri çalıştır (internet gerekmez, yerel bir test fixture sitesi ayağa kaldırılır —
kütüphane, MCP protokolü, HTTP API, token doğrulaması ve panel arayüzü dahil 40 test):

```bash
npm run smoke
```

---

## Claude Desktop'a bağlama

Yapılandırma dosyasını aç:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "web-scraper": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/webscraper/build/index.js"],
      "env": {
        "SCRAPER_OUTPUT_DIR": "/Users/kullanici/Desktop/scraper-output"
      }
    }
  }
}
```

Claude Desktop'ı tamamen kapatıp yeniden aç. Araçlar sohbet kutusundaki 🔌 simgesinde görünür.

**Cursor** için `~/.cursor/mcp.json` dosyasına aynı `mcpServers` bloğu yazılır.
**Claude Code** için: `claude mcp add web-scraper -- node /ABSOLUTE/PATH/webscraper/build/index.js`

---

## Kullanım örnekleri

Claude'a normal cümlelerle yazman yeterli:

> "https://ornek-firma.com adresindeki tüm e-posta ve telefonları çıkar, 3 sayfaya kadar iletişim sayfalarını da gez."

> "https://magaza.com/kategori/ayakkabi sayfasındaki tüm ürünleri, fiyatlarını ve görsellerini 5 sayfa boyunca çek, sonra `ayakkabilar.csv` olarak kaydet."

> "https://blog.com/galeri sayfasındaki 800px'den büyük tüm görselleri `~/Desktop/gorseller` klasörüne indir."

Tipik akış: bir kazıma aracı çalışır → sonuç bir `dataset_id` döner → `export_to_file`
aracına o id verilir, böylece bütün satırlar sohbete tekrar yazılmadan dosyaya kaydedilir.

---

## Araç parametreleri

Tüm kazıma araçları şu ortak ayarları kabul eder:
`wait_for_selector`, `wait_ms`, `scroll_to_bottom`, `timeout_ms`, `locale`.
JavaScript ile geç yüklenen sayfalarda `scroll_to_bottom: true` veya
`wait_for_selector: ".product-card"` kullan.

**`extract_list`** — en esnek araç:

| Parametre | Açıklama |
| --- | --- |
| `item_selector` | Tekrar eden öğenin CSS seçicisi (`.product-card`, `table tbody tr`). Boş bırakılırsa otomatik tespit edilir |
| `fields` | Kolon adı → `{selector, attr, regex}` eşlemesi. Örn. `{"isim": {"selector": ".title"}, "url": {"selector": "a", "attr": "href"}}` |
| `max_pages` | Kaç sayfa gezileceği (varsayılan 1) |
| `next_page_selector` | "Sonraki sayfa" butonu; verilmezse `a[rel=next]`, `.pagination .next` gibi kalıplar denenir |
| `page_url_pattern` | `https://site.com/urunler?page={page}` biçiminde şablon — butona tıklamak yerine URL üretir |
| `max_items` | Satır üst sınırı (varsayılan 1000) |

`fields` verilmezse her öğe için otomatik olarak
`title, price, priceValue, currency, link, image, text` alanları çıkarılır.
Fiyatlar hem `1.299,90 TL` hem `$1,299.90` biçiminde doğru sayıya çevrilir.

---

## Web paneli ve HTTP API (sunucu kullanımı)

```bash
npm run build
PORT=3050 npm run serve
# ▶ http://127.0.0.1:3050
```

Panel: URL gir → işlem türünü seç (Ürün/Liste, İletişim, Görseller, Metin) →
"Kazımayı Başlat". İş arka planda çalışır, panel durumu canlı gösterir; bitince
sonuç tablosu ve **CSV / JSON indir** butonları çıkar. Sağ sütunda son işler ve
üretilen dosyalar listelenir.

> Panelin stilleri `cdn.tailwindcss.com` üzerinden gelir. Sunucunun dışarı erişimi
> yoksa panel yine çalışır, sadece stilsiz görünür ve üstte bir uyarı çıkar.

### API uç noktaları

| Method | Yol | Açıklama |
| --- | --- | --- |
| `GET` | `/api/health` | Durum, kuyruk, çıktı klasörü (token gerektirmez) |
| `POST` | `/api/scrape` | İş başlatır → `202 {jobId}`. `?wait=1` ile senkron bekler |
| `GET` | `/api/jobs` | Son işlerin özeti |
| `GET` | `/api/jobs/:id` | Tek işin durumu + sonucu (`?full=1` kırpılmamış) |
| `POST` | `/api/export` | `{jobId veya data, format, fileName}` → dosya yazar |
| `GET` | `/api/files` | Çıktı klasöründeki dosyalar |
| `GET` | `/api/download/:file` | Dosyayı indirir (klasör dışına çıkış engellenir) |

```bash
# Ürün listesi çek, 3 sayfa, bitince CSV'ye yaz
curl -X POST localhost:3050/api/scrape \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://site.com/urunler","type":"list",
       "options":{"maxPages":3,"itemSelector":".product-card"},
       "export":"csv"}'

# Senkron çalıştır (curl / cron için)
curl -X POST 'localhost:3050/api/scrape?wait=1' \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://site.com/iletisim","type":"leads"}'
```

`options` alanı MCP araçlarıyla aynı ayarları kabul eder (camelCase):
`itemSelector`, `fields`, `maxPages`, `pageUrlPattern`, `nextPageSelector`,
`maxItems`, `minWidth`, `minHeight`, `maxImages`, `scrollToBottom`,
`waitForSelector`, `waitMs`, `timeoutMs`, `locale`, `selector`, `includeHtml`.

### ⚠️ Güvenlik: portu açarken

Bu API, sunucuna **istediği adrese istek attırabilen** bir uç noktadır. Portu
internete açık bırakırsan başkaları sunucunun IP'siyle kazıma yapabilir
(SSRF + kaynak tüketimi). Üç seçenekten birini uygula:

1. **En iyisi:** `HOST=127.0.0.1` ile bağla, önüne nginx + HTTP Basic Auth veya SSH tüneli koy.
2. `SCRAPER_API_TOKEN=<uzun-rastgele-değer>` ayarla — tüm `/api/*` çağrıları
   `X-API-Token` başlığı (veya `Authorization: Bearer`, ya da `?token=`) ister.
   Panelde "Gelişmiş ayarlar → API token" alanına girersin, tarayıcıda saklanır.
3. Portu firewall'la kapat (`ufw deny 3050`).

Token ayarlı değilken sunucu açık bir arayüze bağlanırsa başlangıçta uyarı basar.
Eşzamanlı iş sayısı `SCRAPER_MAX_CONCURRENT_JOBS` (varsayılan 2) ile sınırlıdır;
Hetzner'deki diğer projelerini RAM açısından korur.

Örnek nginx bloğu:

```nginx
location /scraper/ {
    proxy_pass http://127.0.0.1:3050/;
    proxy_read_timeout 600s;      # uzun kazıma işleri için
    auth_basic "Scraper";
    auth_basic_user_file /etc/nginx/.htpasswd;
}
```

---

## Sunucuda çalıştırma (Hetzner)

### Sunucudaki diğer projelere dokunmaz — neyin nereye yazıldığı

| Ne | Nereye | Etki |
| --- | --- | --- |
| Kod + `node_modules` + `build/` | Klonladığın klasör | Sadece o klasör |
| Kazınan dosyalar | `SCRAPER_OUTPUT_DIR` (PM2 config'inde proje içi `scraper-output/`) | Sadece o klasör |
| PM2 logları | `<proje>/logs/` | Sadece o klasör |
| Chromium (~150 MB) | `~/.cache/ms-playwright` | Ortak önbellek, yalnızca ekleme yapar |
| Ağ | Tek port (`PORT`, varsayılan 3050), `127.0.0.1`'e bağlı | Başka port dinlemez |

Sistem geneline dokunan **tek** komut `npx playwright install-deps chromium`'dur:
Chromium'un ihtiyaç duyduğu paylaşımlı kütüphaneleri (`libnss3`, `libatk` vb.)
`apt` ile kurar. Bunu hiç çalıştırmak istemiyorsan **Docker kurulumunu kullan** —
o zaman hiçbir sistem paketi kurulmaz.

### Kurulum

```bash
# 1. Portun boş olduğunu doğrula (çıktı boşsa boştur)
ss -tlnp | grep :3050

# 2. Diğer projelerden ayrı bir klasöre klonla
mkdir -p ~/apps && cd ~/apps
git clone -b claude/universal-web-scraper-mcp-b7qn4o \
  https://github.com/nietzische-app/webscraper.git webscraper
cd webscraper

# 3. Kur ve derle (her şey bu klasörde kalır)
npm install
npm run build

# 4. Testleri çalıştır — internet gerektirmez, doğru kurulduğunu kanıtlar
npm run smoke
```

### PM2

```bash
pm2 start ecosystem.config.cjs
pm2 logs web-scraper
```

⚠️ **`pm2 save` hakkında:** bu komut o an çalışan **tüm** PM2 uygulamalarının
listesini kaydeder. Sunucunda PM2 ile yönettiğin başka projeler varsa, önce
`pm2 list` ile hepsinin ayakta olduğunu doğrula; ancak ondan sonra `pm2 save`
çalıştır. Aksi hâlde o an duran bir uygulaman kayıtlı listeden düşer.
`pm2 startup` zaten kuruluysa tekrar çalıştırmana gerek yok.

`ecosystem.config.cjs` içinde port `3050`, bind adresi `127.0.0.1`, bellek
sınırı `1G` ve `kill_timeout: 10s` (tarayıcının düzgün kapanması için) ayarlıdır.
Chromium'un sistem bağımlılıkları için bir kereye mahsus:
`sudo npx playwright install-deps chromium`.

### Docker

```bash
docker compose up -d --build
docker compose logs -f
```

Docker yolu sisteme hiçbir paket kurmaz, kazınan dosyalar `scraper-data`
volume'unda tutulur ve port yalnızca `127.0.0.1:3050`'ye yayınlanır. Sunucunda
başka compose projeleri varsa çakışma olmaması için bu klasörden çalıştır —
proje adı klasör adından (`webscraper`) türetilir.

`Dockerfile` resmi Playwright imajını kullanır (Chromium ve tüm kütüphaneler
hazır gelir), root olmayan `pwuser` ile çalışır, `/data` volume'una yazar ve
`/api/health` üzerinden healthcheck yapar. Compose dosyası portu yalnızca
`127.0.0.1:3050`'ye yayınlar ve Chromium için `shm_size: 1gb` verir.

---

## Ortam değişkenleri

| Değişken | Varsayılan | Açıklama |
| --- | --- | --- |
| `PORT` | `3050` | Web panelinin portu |
| `HOST` | `0.0.0.0` | Bind adresi (`127.0.0.1` = yalnızca yerel) |
| `SCRAPER_API_TOKEN` | — | Ayarlıysa tüm `/api/*` çağrıları token ister |
| `SCRAPER_MAX_CONCURRENT_JOBS` | `2` | Aynı anda çalışacak kazıma işi sayısı |
| `SCRAPER_MAX_JOBS_KEPT` | `100` | Bellekte tutulan iş geçmişi |
| `SCRAPER_OUTPUT_DIR` | `~/scraper-output` | Göreli dosya yollarının kaydedileceği klasör |
| `SCRAPER_CHROME_PATH` | — | Playwright yerine kullanılacak Chrome/Chromium binary'si |
| `SCRAPER_BROWSER_CHANNEL` | — | `chrome`, `msedge` gibi kurulu bir kanal |
| `SCRAPER_USER_AGENT` | Kurulu Chromium'dan üretilir | User-Agent'ı elle belirle |
| `SCRAPER_LOCALE` / `SCRAPER_TIMEZONE` | `en-US` / `Europe/Istanbul` | Tarayıcı dili ve saat dilimi |
| `SCRAPER_PROXY` | — | `http://host:port` (ayrıca `SCRAPER_PROXY_USERNAME` / `_PASSWORD`) |
| `SCRAPER_CSV_BOM` | `true` | CSV başına UTF-8 BOM ekler (Excel'de Türkçe karakterler için) |

---

## Sorun giderme

- **"Chromium could not be launched"** → `npx playwright install chromium` çalıştır ya da `SCRAPER_CHROME_PATH` ayarla.
- **Sayfa boş dönüyor** → İçerik JavaScript ile geliyordur: `scroll_to_bottom: true` ve/veya `wait_for_selector` ekle.
- **Yanlış satırlar çıkıyor** → `item_selector`'ı elle ver; tarayıcıda "İncele" ile ürün kartının class'ına bak.
- **Claude araçları görmüyor** → `build/index.js` yolunun mutlak olduğundan ve `npm run build` çalıştırıldığından emin ol, sonra Claude Desktop'ı tamamen kapatıp aç.
- **Sunucu logları** → MCP sunucusu stdout'u protokol için kullanır; tüm loglar stderr'e yazılır (Claude Desktop → MCP log dosyaları). Web sunucusunda `pm2 logs web-scraper` ya da `docker compose logs -f`.
- **Panel "bağlantı yok" diyor** → API token ayarlıysa "Gelişmiş ayarlar → API token" alanına gir; ayrıca `curl localhost:3050/api/health` ile sunucunun ayakta olduğunu doğrula.
- **Sunucuda "Host system is missing dependencies"** → `sudo npx playwright install-deps chromium` (ya da Docker kurulumunu kullan).

---

## Sorumlu kullanım

Bu araç senin adına gerçek bir tarayıcı çalıştırır. Kullanırken:

- Hedef sitenin kullanım şartlarına ve `robots.txt` dosyasına uy.
- `max_pages` değerlerini makul tut; siteyi yük altında bırakma.
- Topladığın kişisel veriler (e-posta, telefon) KVKK/GDPR kapsamındadır; yalnızca
  meşru amaçla ve izin verilen ölçüde işle.

MIT lisanslı.
