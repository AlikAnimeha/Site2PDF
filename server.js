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

function getParentUrls(url, origin) {
  const paths = new URL(url).pathname.split('/').filter(Boolean);
  const parents = [];
  for (let i = paths.length - 1; i >= 0; i--) {
    const parentPath = '/' + paths.slice(0, i).join('/');
    parents.push(origin + (parentPath === '/' ? '' : parentPath));
  }
  return parents;
}

app.post('/download', async (req, res) => {
  const startUrl = req.body.url?.trim();
  const maxDepthInput = req.body.depth || '2';
  const maxDepth = Math.min(3, Math.max(1, parseInt(maxDepthInput)));
  const scope = req.body.scope || 'children';
  const delay = req.body.delay ? parseInt(req.body.delay) : 0;
  const limit = Math.min(50000, Math.max(1, parseInt(req.body.limit) || 20));

  if (!startUrl || !startUrl.startsWith('http')) {
    return res.status(400).send('❌ Укажите корректный URL (начинается с http)');
  }

  const normalizedUrl = new URL(startUrl).href;
  const baseUrl = new URL(normalizedUrl).origin;
  const visited = new Set();
  let queue = [];

  if (scope === 'only') {
    queue = [{ url: normalizedUrl, depth: 0 }];
  } else if (scope === 'parents') {
    const parents = getParentUrls(normalizedUrl, baseUrl);
    queue = parents.map((url, i) => ({ url, depth: i }));
    if (!parents.includes(normalizedUrl)) {
      queue.push({ url: normalizedUrl, depth: parents.length });
    }
  } else if (scope === 'children') {
    queue = [{ url: normalizedUrl, depth: 0 }];
  } else if (scope === 'both') {
    const parents = getParentUrls(normalizedUrl, baseUrl);
    const parentQueue = parents.map((url, i) => ({ url, depth: i }));
    queue = [...parentQueue, { url: normalizedUrl, depth: parents.length }];
  }

  const screenshotDir = path.join(__dirname, 'screenshots');
  try {
    await fs.rm(screenshotDir, { recursive: true, force: true });
  } catch (e) {}
  await fs.mkdir(screenshotDir, { recursive: true });

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

  // --- Разрешение экрана ---
  let width = 1280;
  const resolution = req.body.resolution || '1280x800';

  if (resolution === 'custom') {
    width = Math.min(3840, Math.max(640, parseInt(req.body.customWidth) || 1280));
  } else {
    const [w] = resolution.split('x').map(Number);
    if (w) width = Math.min(3840, Math.max(640, w));
  }

  let pageCount = 0;

  while (queue.length > 0 && pageCount < limit) {
    const { url, depth } = queue.shift();
    if (visited.has(url)) continue;
    if (!url.startsWith(baseUrl)) continue;

    visited.add(url);
    pageCount++;
    console.log(`📥 [${pageCount}/${limit}] [${depth}/${maxDepth}] ${url}`);

    try {
      // Увеличено время ожидания
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });

      // Получаем размеры документа
      const { scrollWidth, scrollHeight } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight
      }));

      const viewWidth = Math.min(3840, Math.max(640, width));
      const scale = viewWidth / scrollWidth;
      const viewHeight = Math.min(Math.ceil(scrollHeight * scale), 30000); // ограничение Puppeteer

      await page.setViewport({ width: viewWidth, height: viewHeight });

      // Высота A4 при 96 DPI ≈ 1123px
      const a4Height = Math.ceil(1123 * scale);
      let y = 0;
      let partIndex = 0;

      let name = url
        .replace(baseUrl, '')
        .replace(/^\/|\/$/g, '')
        .replace(/\//g, '_')
        .replace(/[^a-z0-9_-]/gi, '_') || 'index';

      while (y < viewHeight) {
        const clipHeight = Math.min(a4Height, viewHeight - y);
        const pngPath = path.join(screenshotDir, `${name}_part${partIndex}.png`);

        await page.screenshot({
          path: pngPath,
          clip: { x: 0, y: y, width: viewWidth, height: clipHeight }
        });

        archive.file(pngPath, { name: `${name}_part${partIndex}.png` });
        y += a4Height;
        partIndex++;
      }

      // Сбор внутренних ссылок
      if (['children', 'both'].includes(scope) && depth < maxDepth) {
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
            // игнорируем битые URL
          }
        }
      }

      if (delay > 0) {
        await new Promise(r => setTimeout(r, delay));
      }
    } catch (e) {
      console.error(`❌ Ошибка на ${url}:`, e.message);
      // Не continue — URL уже обработан (visited.add), пропускать не нужно
    }
  }

  await browser.close();
  await archive.finalize().catch(() => {});
});

app.listen(PORT, () => {
  console.log(`✅ Сервер запущен: http://localhost:${PORT}`);
});

