const express = require('express');
const puppeteer = require('puppeteer');
const archiver = require('archiver');
const fs = require('fs'); // <-- Используем стандартный fs для createWriteStream
const fsPromises = require('fs').promises; // <-- Для async/await операций
const path = require('path');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('.'));

// Хранилище задач
const jobs = {};

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// Запуск новой задачи
app.post('/start', async (req, res) => {
  const startUrl = req.body.url?.trim();
  const maxDepthInput = req.body.depth || '2';
  const maxDepth = Math.min(3, Math.max(1, parseInt(maxDepthInput)));

  if (!startUrl || !startUrl.startsWith('http')) {
    return res.status(400).send('❌ Укажите корректный URL (начинается с http)');
  }

  const jobId = Date.now().toString(36);
  jobs[jobId] = { logs: ['🚀 Задача запущена...'], done: false, zipPath: null };
  res.json({ jobId });

  // Запускаем обработку в фоне
  (async () => {
    try {
      await processSite(jobId, startUrl, maxDepth);
      jobs[jobId].done = true;
    } catch (err) {
      jobs[jobId].logs.push(`❌ Внутренняя ошибка: ${err.message}`);
      jobs[jobId].done = true;
    }
  })();
});

// Получение статуса задачи
app.get('/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) {
    return res.status(404).json({ logs: ['⚠️ Задача не найдена'], done: true });
  }
  res.json({ logs: job.logs, done: job.done });
});

// Скачивание результата
app.get('/download/:jobId', async (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job || !job.done || !job.zipPath) {
    return res.status(404).send('Задача не готова или не существует');
  }
  res.download(job.zipPath, 'site-export.zip', async () => {
    // Опционально: удали после отдачи
    try {
      await fsPromises.unlink(job.zipPath);
      await fsPromises.rm(path.dirname(job.zipPath), { recursive: true, force: true });
    } catch (e) {}
    delete jobs[req.params.jobId];
  });
});

// Основная логика обработки
async function processSite(jobId, startUrl, maxDepth) {
  const job = jobs[jobId];
  const normalizedUrl = new URL(startUrl).href;
  const baseUrl = new URL(normalizedUrl).origin;
  const visited = new Set();
  const queue = [{ url: normalizedUrl, depth: 0 }];
  const pdfDir = path.join(__dirname, `pdfs_${jobId}`);
  const zipPath = path.join(__dirname, `site-export_${jobId}.zip`);

  job.logs.push(`🌐 Базовый URL: ${baseUrl}`);
  job.logs.push(`🧭 Глубина обхода: ${maxDepth}`);

  try {
    await fsPromises.rm(pdfDir, { recursive: true, force: true });
    await fsPromises.mkdir(pdfDir, { recursive: true });

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
      job.logs.push(`📥 [${depth}/${maxDepth}] ${url}`);

      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });

        let name = url
          .replace(baseUrl, '')
          .replace(/^\/|\/$/g, '')
          .replace(/\//g, '_')
          .replace(/[^a-z0-9_-]/gi, '_') || 'index';

        const pdfPath = path.join(pdfDir, `${name}.pdf`);
        await page.pdf({ path: pdfPath, format: 'A4', printBackground: true });
        job.logs.push(`✅ Сохранено: ${name}.pdf`);

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
              job.logs.push(`⚠️ Некорректная ссылка: ${href}`);
            }
          }
        }
      } catch (e) {
        job.logs.push(`⚠️ Пропущено: ${url} — ${e.message}`);
      }
    }

    await browser.close();

    // Создание ZIP
    job.logs.push('📦 Создание ZIP-архива...');
    const zipStream = fs.createWriteStream(zipPath); // <-- Используем fs, а не fsPromises
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.pipe(zipStream);

    for (const file of await fsPromises.readdir(pdfDir)) {
      archive.file(path.join(pdfDir, file), { name: file });
    }

    await archive.finalize();
    await new Promise(resolve => zipStream.on('close', resolve));

    job.zipPath = zipPath;
    job.logs.push('✅ ZIP готов.');
  } catch (err) {
    job.logs.push(`💥 Критическая ошибка: ${err.message}`);
    throw err;
  }
}

app.listen(PORT, () => {
  console.log(`✅ Сервер запущен: http://localhost:${PORT}`);
});
