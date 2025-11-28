const express = require('express');
const puppeteer = require('puppeteer');
const archiver = require('archiver');
const fs = require('fs').promises;
const path = require('path');
const { URL } = require('url');
const { v4: uuidv4 } = require('uuid'); // ← нужно установить: npm install uuid

const app = express();
const PORT = process.env.PORT || 3000;

// Хранилище активных задач: { jobId → { abort: true/false } }
const activeJobs = new Map();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('.'));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// НОВЫЙ маршрут: инициализация + возврат jobId
app.post('/start-download', async (req, res) => {
  const { url, depth } = req.body;
  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ error: '❌ Укажите корректный URL' });
  }

  const jobId = uuidv4();
  activeJobs.set(jobId, { abort: false });
  res.json({ jobId });
});

// НОВЫЙ маршрут: отмена задачи
app.post('/cancel-download', (req, res) => {
  const { jobId } = req.body;
  if (activeJobs.has(jobId)) {
    activeJobs.get(jobId).abort = true;
    res.json({ status: 'cancelled' });
  } else {
    res.status(404).json({ error: 'Задача не найдена' });
  }
});

// ОСНОВНОЙ маршрут: стриминг ZIP
app.get('/download/:jobId', async (req, res) => {
  const jobId = req.params.jobId;
  if (!activeJobs.has(jobId)) {
    return res.status(404).send('Задача не найдена');
  }

  const job = activeJobs.get(jobId);
  const startUrl = req.query.url;
  const maxDepthInput = req.query.depth || '2';
  const maxDepth = Math.min(3, Math.max(1, parseInt(maxDepthInput)));

  const normalizedUrl = new URL(startUrl).href;
  const baseUrl = new URL(normalizedUrl).origin;
  const visited = new Set();
  const queue = [{ url: normalizedUrl, depth: 0 }];
  const pdfDir = path.join(__dirname, 'pdfs_' + jobId);

  try {
    await fs.rm(pdfDir, { recursive: true, force: true });
    await fs.mkdir(pdfDir, { recursive: true });
  } catch (e) {}

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

  const checkAbort = () => job.abort;

  while (queue.length > 0) {
    if (checkAbort()) break;

    const { url, depth } = queue.shift();
    if (visited.has(url) || !url.startsWith(baseUrl)) continue;
    visited.add(url);

    try {
      if (checkAbort()) break;
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

      let name = url
        .replace(baseUrl, '')
        .replace(/^\/|\/$/g, '')
        .replace(/\//g, '_')
        .replace(/[^a-z0-9_-]/gi, '_') || 'index';

      const pdfPath = path.join(pdfDir, `${name}.pdf`);
      await page.pdf({ path: pdfPath, format: 'A4', printBackground: true });
      archive.file(pdfPath, { name: `${name}.pdf` });

      if (depth < maxDepth && !checkAbort()) {
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
    } catch (e) {
      console.warn(`⚠️ Пропущено: ${url}`);
    }
  }

  await browser.close();
  await archive.finalize().catch(() => {});
  activeJobs.delete(jobId);
  await fs.rm(pdfDir, { recursive: true, force: true });
});
