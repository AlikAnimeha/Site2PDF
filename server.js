const express = require('express');
const puppeteer = require('puppeteer');
const archiver = require('archiver');
const fs = require('fs').promises;
const path = require('path');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.static('.'));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

app.post('/download', async (req, res) => {
  const startUrl = req.body.url?.trim();
  const maxDepthInput = req.body.depth || '2';
  const maxDepth = Math.min(3, Math.max(1, parseInt(maxDepthInput)));

  if (!startUrl || !startUrl.startsWith('http')) {
    return res.status(400).send('❌ Укажите корректный URL (начинается с http)');
  }

  // Убираем пробелы и нормализуем URL
  const normalizedUrl = new URL(startUrl).href;
  const baseUrl = new URL(normalizedUrl).origin;
  const visited = new Set();
  const queue = [{ url: normalizedUrl, depth: 0 }];
  const pdfDir = path.join(__dirname, 'pdfs');

  // Очищаем старые файлы (опционально, но полезно на сервере)
  try {
    await fs.rm(pdfDir, { recursive: true, force: true });
  } catch (e) {}
  await fs.mkdir(pdfDir, { recursive: true });

  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': 'attachment; filename=site-export.zip'
  });

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.pipe(res);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  while (queue.length > 0) {
    const { url, depth } = queue.shift();
    if (visited.has(url)) continue;
    if (!url.startsWith(baseUrl)) continue;

    visited.add(url);
    console.log(`📥 [${depth}/${maxDepth}] ${url}`);

    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });

      // Генерируем имя файла
      let name = url
        .replace(baseUrl, '')
        .replace(/^\/|\/$/g, '')
        .replace(/\//g, '_')
        .replace(/[^a-z0-9_-]/gi, '_') || 'index';

      const pdfPath = path.join(pdfDir, `${name}.pdf`);
      await page.pdf({ path: pdfPath, format: 'A4', printBackground: true });
      archive.file(pdfPath, { name: `${name}.pdf` });

      // Обходим ссылки, если глубина позволяет
      if (depth < maxDepth) {
        const links = await page.evaluate(() =>
          Array.from(document.querySelectorAll('a[href]'))
            .map(a => a.getAttribute('href'))
            .filter(href => href && !href.startsWith('#') && href.startsWith('/'))
        );
        for (const href of links) {
          try {
            const fullUrl = new URL(href, baseUrl).href;
            if (!visited.has(fullUrl)) {
              queue.push({ url: fullUrl, depth: depth + 1 });
            }
          } catch (e) {
            // Игнорируем некорректные относительные ссылки
          }
        }
      }
    } catch (e) {
      console.warn(`⚠️ Пропущено: ${url}`);
    }
  }

  await browser.close();
  await archive.finalize().catch(() => {});
});

app.listen(PORT, () => {
  console.log(`✅ Сервер запущен: http://localhost:${PORT}`);
});
