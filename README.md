# Universal Web Scraper — MCP Server

Yerel bilgisayarında çalışan, ücretsiz ve limitsiz bir web scraping MCP sunucusu.
Arka planda gerçek bir Chromium tarayıcısı (Playwright) çalıştırır; Claude Desktop,
Claude Code veya Cursor içinden doğal dille kullanılır.

**Yetenekler**

| Araç | Ne yapar |
| --- | --- |
| `scrape_page` | Sayfanın okunabilir metnini, başlıklarını, meta verisini ve linklerini çeker |
| `extract_leads` | E-posta, telefon, sosyal medya ve adres bilgilerini toplar (iletişim sayfalarını da gezer) |
| `extract_list` | Ürün listeleri, arama sonuçları, dizinler ve HTML tabloları → JSON dizisi (sayfalama destekli) |
| `download_images` | Sayfadaki görselleri en yüksek çözünürlüklü hâliyle diske indirir |
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

Testleri çalıştır (internet gerekmez, yerel bir test sitesi ayağa kaldırılır):

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

## Ortam değişkenleri

| Değişken | Varsayılan | Açıklama |
| --- | --- | --- |
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
- **Sunucu logları** → Sunucu stdout'u MCP protokolü için kullanır; tüm loglar stderr'e yazılır (Claude Desktop → MCP log dosyaları).

---

## Sorumlu kullanım

Bu araç senin adına gerçek bir tarayıcı çalıştırır. Kullanırken:

- Hedef sitenin kullanım şartlarına ve `robots.txt` dosyasına uy.
- `max_pages` değerlerini makul tut; siteyi yük altında bırakma.
- Topladığın kişisel veriler (e-posta, telefon) KVKK/GDPR kapsamındadır; yalnızca
  meşru amaçla ve izin verilen ölçüde işle.

MIT lisanslı.
