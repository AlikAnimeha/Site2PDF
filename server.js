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
  const limit = Math.min(500000, Math.max(1, parseInt(req.body.limit) || 20));

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

  const pdfDir = path.join(__dirname, 'pdfs');
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

  // --- Разрешение экрана ---
  let width = 1280, height = 800;
  const resolution = req.body.resolution || '1280x800';

  if (resolution === 'custom') {
    width = Math.min(3840, Math.max(640, parseInt(req.body.customWidth) || 1280));
    height = Math.min(2160, Math.max(480, parseInt(req.body.customHeight) || 800));
  } else {
    const [w, h] = resolution.split('x').map(Number);
    if (w && h) {
      width = Math.min(3840, Math.max(640, w));
      height = Math.min(2160, Math.max(480, h));
    }
  }
  await page.setViewport({ width, height });

  let pageCount = 0;

  while (queue.length > 0 && pageCount < limit) {
    const { url, depth } = queue.shift();
    if (visited.has(url)) continue;
    if (!url.startsWith(baseUrl)) continue;

    visited.add(url);
    pageCount++;
    console.log(`📥 [${pageCount}/${limit}] [${depth}/${maxDepth}] ${url}`);

    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });

      let name = url
        .replace(baseUrl, '')
        .replace(/^\/|\/$/g, '')
        .replace(/\//g, '_')
        .replace(/[^a-z0-9_-]/gi, '_') || 'index';

      const pdfPath = path.join(pdfDir, `${name}.pdf`);
      await page.pdf({ path: pdfPath, format: 'A4', printBackground: true });
      archive.file(pdfPath, { name: `${name}.pdf` });

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
          } catch (e) {}
        }
      }

      if (delay > 0) {
        await new Promise(r => setTimeout(r, delay));
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
