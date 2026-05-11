const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Readable } = require('stream');
const { spawn, exec: execCb } = require('child_process');

process.on('uncaughtException', (err) => { console.error('[FATAL]', err.message); });
process.on('unhandledRejection', (err) => { console.error('[REJECT]', err?.message || err); });

const PORT = process.env.PORT || 3000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const IS_PACKAGED = !!process.pkg;
const EXEC_DIR = IS_PACKAGED ? path.dirname(process.execPath) : __dirname;
const APP_DIR = EXEC_DIR;
const DATA_DIR = path.join(APP_DIR, 'data');
const PUBLIC_DIR = IS_PACKAGED ? path.join(path.dirname(process.pkg.defaultEntrypoint), 'public') : path.join(__dirname, 'public');
const RUNTIME_DIR = path.join(EXEC_DIR, 'runtime');
const FFMPEG_DIR = path.join(RUNTIME_DIR, 'ffmpeg');
const PLAYWRIGHT_DIR = path.join(RUNTIME_DIR, 'playwright');
const COOKIES_FILE = path.join(DATA_DIR, 'cookies.json');
const NETSCAPE_COOKIES = path.join(DATA_DIR, 'cookies.txt');

if (fs.existsSync(PLAYWRIGHT_DIR)) process.env.PLAYWRIGHT_BROWSERS_PATH = PLAYWRIGHT_DIR;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function getBundledBinaryPath(name) {
  const fileName = process.platform === 'win32' ? name + '.exe' : name;
  const bundledPath = path.join(FFMPEG_DIR, fileName);
  return fs.existsSync(bundledPath) ? bundledPath : name;
}

function getPlaywrightLaunchOptions(headless) {
  const options = { headless };
  const chromiumExecutable = path.join(PLAYWRIGHT_DIR, 'chromium-1217', 'chrome-win64', 'chrome.exe');
  if (fs.existsSync(chromiumExecutable)) options.executablePath = chromiumExecutable;
  return options;
}

// ===== Cookie management =====

function readStorageState() {
  if (!fs.existsSync(COOKIES_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function hasValidSessionCookie(storageState) {
  const now = Date.now() / 1000;
  const cookies = storageState?.cookies || [];
  return cookies.some((cookie) => {
    if (!['sessionid', 'sessionid_ss', 'passport_csrf_token'].includes(cookie.name)) return false;
    if (!cookie.value) return false;
    if (cookie.expires && cookie.expires > 0 && cookie.expires <= now) return false;
    return true;
  });
}

function getSessionCookieSignature(cookies) {
  return (cookies || [])
    .filter((cookie) => ['sessionid', 'sessionid_ss', 'passport_csrf_token'].includes(cookie.name))
    .map((cookie) => cookie.name + '=' + cookie.value)
    .sort()
    .join(';');
}

function isLoggedIn() {
  return hasValidSessionCookie(readStorageState());
}

function getCookieHeader() {
  const storageState = readStorageState();
  if (!storageState) return '';
  try {
    return (storageState.cookies || []).map((c) => c.name + '=' + c.value).join('; ');
  } catch {
    return '';
  }
}

function saveCookiesFromPlaywright(storageState) {
  fs.writeFileSync(COOKIES_FILE, JSON.stringify(storageState, null, 2));
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of (storageState.cookies || [])) {
    const domain = c.domain.startsWith('.') ? c.domain : '.' + c.domain;
    const flag = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const secure = c.secure ? 'TRUE' : 'FALSE';
    const expires = Math.floor(c.expires || 0);
    lines.push([domain, flag, c.path, secure, expires, c.name, c.value].join('\t'));
  }
  fs.writeFileSync(NETSCAPE_COOKIES, lines.join('\n'));
  console.log('[cookies] saved', storageState.cookies?.length || 0, 'cookies');
}

function clearCookies() {
  try { fs.unlinkSync(COOKIES_FILE); } catch {}
  try { fs.unlinkSync(NETSCAPE_COOKIES); } catch {}
}

// ===== HTTP helpers =====

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

// ===== HTTP client =====

function buildRequestHeaders(extraHeaders) {
  const headers = { 'User-Agent': UA, ...extraHeaders };
  const cookieHeader = getCookieHeader();
  if (cookieHeader) headers.Cookie = cookieHeader;
  return headers;
}

async function fetchText(url, extraHeaders) {
  const resp = await fetch(url, {
    headers: buildRequestHeaders(extraHeaders),
    redirect: 'follow',
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  return await resp.text();
}

async function fetchJson(url, extraHeaders) {
  const raw = await fetchText(url, extraHeaders);
  return JSON.parse(raw);
}

// ===== Core: Extract item ID from share URL =====

function extractCandidateUrl(rawText) {
  if (!rawText) return '';
  const text = String(rawText).trim();
  const match = text.match(/https?:\/\/[^\s，。！？》）\]]+/i);
  return match ? match[0] : text;
}

function extractItemId(shareUrl) {
  if (!shareUrl) return null;

  const text = String(shareUrl).trim();

  try {
    const u = new URL(text);
    const keys = ['id', 'item_id', 'video_id', 'work_id', 'aweme_id'];
    for (const key of keys) {
      const val = u.searchParams.get(key);
      if (val && /^\d{5,}$/.test(val)) return val;
    }
  } catch {}

  const patterns = [
    /(?:^|[?&])(id|item_id|video_id|work_id|aweme_id)=(\d{5,})/i,
    /\/work-detail\/(\d{5,})/i,
    /\/share-(?:vid|img)\/(\d{5,})/i,
    /\b(\d{10,})\b/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[2] || match[1];
  }

  return null;
}

async function resolveShareUrl(inputUrl) {
  const resp = await fetch(inputUrl, {
    headers: buildRequestHeaders(),
    redirect: 'follow',
  });
  return resp.url;
}

// ===== Core: Fetch video info via mweb API =====

async function fetchVideoItem(itemId) {
  const candidates = [
    'https://jimeng.jianying.com/mweb/v1/get_explore?aid=513695&device_platform=web&region=CN&count=20&cursor=0&item_id=' + itemId,
    'https://jimeng.jianying.com/mweb/v1/get_explore?aid=513695&device_platform=web&region=CN&count=20&cursor=0&id=' + itemId,
  ];

  for (const url of candidates) {
    let data;
    try {
      data = await fetchJson(url, { Referer: 'https://jimeng.jianying.com/' });
    } catch {
      continue;
    }
    if (data.ret !== '0' && data.ret !== 0) continue;

    const items = data?.data?.item_list || [];
    const item = items.find(i => i.common_attr?.id === itemId);
    if (item) return item;
  }

  throw new Error('Item not found in explore list');
}

function normalizeLandingPagePayload(payload, itemId) {
  const pageInfo = payload?.data?.page_info;
  const meta = pageInfo?.creation?.metadata;
  if (!meta) return null;
  if (String(meta.video_id || '') !== String(itemId)) return null;

  const matchedCreation = pageInfo?.creation_list?.find((entry) => String(entry?.metadata?.video_id || '') === String(itemId));
  const cleanVideoUrl = matchedCreation?.metadata?.video_url || '';
  const rawVideoUrl = meta.download_info?.url || meta.video_url || cleanVideoUrl;
  const watermarkEndingUrl = meta.download_info?.watermark_ending_url || '';
  const durationMs = meta.duration_ms || matchedCreation?.metadata?.duration_ms || 0;
  const durationSec = durationMs ? durationMs / 1000 : 0;

  return {
    __directResult: true,
    title: meta.title || '',
    videoId: meta.video_id || itemId,
    itemId,
    author: pageInfo?.creation?.creator_info?.creator?.user_name || '',
    authorAvatar: pageInfo?.creation?.creator_info?.creator?.user_avatar || '',
    coverUrl: meta.cover_url || matchedCreation?.metadata?.cover_url || '',
    videoUrl: rawVideoUrl,
    rawVideoUrl,
    altVideoUrl: cleanVideoUrl,
    watermarkEndingUrl,
    format: meta.download_info?.format || 'mp4',
    width: meta.width || matchedCreation?.metadata?.width || 0,
    height: meta.height || matchedCreation?.metadata?.height || 0,
    fps: meta.fps || matchedCreation?.metadata?.fps || 0,
    fileSize: meta.size || matchedCreation?.metadata?.size || 0,
    videoDuration: durationSec,
    totalDuration: durationSec,
    watermarkDuration: 0,
    durationMs,
    watermarkType: cleanVideoUrl && cleanVideoUrl !== rawVideoUrl ? 1 : (watermarkEndingUrl ? 1 : 0),
  };
}

function findVideoItemInPayload(payload, itemId) {
  if (!payload || typeof payload !== 'object') return null;

  const normalized = normalizeLandingPagePayload(payload, itemId);
  if (normalized) return normalized;

  if (Array.isArray(payload)) {
    for (const entry of payload) {
      const found = findVideoItemInPayload(entry, itemId);
      if (found) return found;
    }
    return null;
  }

  if (payload.common_attr?.id === itemId && payload.video) return payload;

  for (const value of Object.values(payload)) {
    const found = findVideoItemInPayload(value, itemId);
    if (found) return found;
  }

  return null;
}

// Fetch item using Playwright (more reliable, handles JS rendering)
async function fetchVideoItemPw(itemId, pageUrl) {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch { throw new Error('Playwright not installed'); }

  let browser;
  try {
    const ctxOpts = { userAgent: UA };
    if (fs.existsSync(COOKIES_FILE)) ctxOpts.storageState = COOKIES_FILE;
    browser = await chromium.launch(getPlaywrightLaunchOptions(true));
    const ctx = await browser.newContext(ctxOpts);
    const page = await ctx.newPage();

    let targetItem = null;
    page.on('response', async (resp) => {
      try {
        const contentType = resp.headers()['content-type'] || '';
        if (!contentType.includes('application/json')) return;
        const json = await resp.json();
        const found = findVideoItemInPayload(json, itemId);
        if (found) targetItem = found;
      } catch {}
    });

    await page.goto(pageUrl || ('https://jimeng.jianying.com/ai-tool/home?id=' + itemId), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(6000);

    if (!targetItem) {
      try {
        await page.evaluate(() => {
          const all = document.querySelectorAll('*');
          for (const el of all) {
            if (el.textContent.trim() === '短片' && el.offsetHeight > 0 && el.offsetHeight < 50) {
              el.click();
              break;
            }
          }
        });
      } catch {}
      await page.waitForTimeout(4000);
    }

    await browser.close();

    if (!targetItem) throw new Error('Item not found via Playwright');
    return targetItem;
  } catch (err) {
    if (browser) try { await browser.close(); } catch {}
    throw err;
  }
}

// ===== Extract video URL and metadata from item =====

async function probeDurationSeconds(videoUrl) {
  return await new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-headers', 'User-Agent: ' + UA + '\r\nReferer: https://jimeng.jianying.com/',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoUrl,
    ];
    const child = spawn(getBundledBinaryPath('ffprobe'), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffprobe exit ' + code + ': ' + stderr.substring(0, 200)));
      const duration = parseFloat(stdout.trim());
      if (!Number.isFinite(duration) || duration <= 0) return reject(new Error('Invalid ffprobe duration'));
      resolve(duration);
    });
  });
}

function extractVideoFromItem(item) {
  if (item?.__directResult) return item;

  const ca = item.common_attr;
  const author = item.author;
  const v = item.video;

  if (!v) throw new Error('Not a video item');

  const videoUrl = v.transcoded_video?.origin?.video_url;
  if (!videoUrl) throw new Error('No video URL in item');

  // Parse video_model for additional info
  let vm = {};
  try { vm = JSON.parse(v.video_model || '{}'); } catch {}

  // Decode main_url from video_model (alternate CDN URL)
  let mainUrl = '';
  try {
    const b64 = vm.video_list?.video_1?.main_url;
    if (b64) mainUrl = Buffer.from(b64, 'base64').toString();
  } catch {}

  // Get actual video duration (without watermark ending)
  const videoDuration = vm.video_duration || v.duration;
  const totalDuration = v.duration;
  const durationMs = v.duration_ms;

  // The watermark is an ending segment ~1s long
  // video_duration = actual content, duration = content + watermark ending
  const watermarkDuration = totalDuration - videoDuration;

  return {
    title: ca.title || '',
    videoId: v.video_id || ca.id,
    itemId: ca.id,
    author: author?.name || '',
    authorAvatar: author?.avatar_url || '',
    coverUrl: v.cover_url || ca.cover_url || '',
    videoUrl: mainUrl || videoUrl,
    altVideoUrl: mainUrl ? videoUrl : '',
    format: 'mp4',
    width: v.transcoded_video?.origin?.width || 0,
    height: v.transcoded_video?.origin?.height || 0,
    fps: v.transcoded_video?.origin?.fps || 0,
    fileSize: v.transcoded_video?.origin?.size || 0,
    videoDuration,
    totalDuration,
    watermarkDuration: Math.max(0, watermarkDuration),
    durationMs,
    watermarkType: v.watermark_type,
  };
}

// ===== Playwright login =====

let loginInProgress = false;

async function verifyLoginWithPlaywright(page) {
  await page.goto('https://jimeng.jianying.com/ai-tool/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  const pageText = await page.locator('body').innerText().catch(() => '');
  if (/登录|扫码|抖音登录|注册|立即登录/.test(pageText) && !/退出登录|个人中心|我的作品|去创作/.test(pageText)) {
    return false;
  }
  return true;
}

async function doLogin() {
  if (loginInProgress) throw new Error('Login already in progress');
  loginInProgress = true;

  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    loginInProgress = false;
    throw new Error('Playwright not installed. Run: npm install playwright && npx playwright install chromium');
  }

  let browser;
  try {
    browser = await chromium.launch(getPlaywrightLaunchOptions(false));
    const context = await browser.newContext({ userAgent: UA });
    const page = await context.newPage();
    const initialCookies = await context.cookies('https://jimeng.jianying.com');
    const initialSignature = getSessionCookieSignature(initialCookies);

    let loginPopupSeen = false;
    let loginPopupClosed = false;
    const popupStates = new Set();
    context.on('page', (popup) => {
      if (popup === page) return;
      loginPopupSeen = true;
      popupStates.add(popup);
      popup.on('close', () => {
        popupStates.delete(popup);
        loginPopupClosed = true;
      });
    });

    await page.goto('https://jimeng.jianying.com/ai-tool/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log('[login] Waiting for user to complete Douyin QR login...');

    let loggedIn = false;
    for (let i = 0; i < 240; i++) {
      await page.waitForTimeout(1000);
      const cookies = await context.cookies('https://jimeng.jianying.com');
      const hasSession = hasValidSessionCookie({ cookies });
      const currentSignature = getSessionCookieSignature(cookies);
      const popupOpen = popupStates.size > 0;

      if (!loginPopupSeen || popupOpen || !loginPopupClosed) continue;
      if (!hasSession || !currentSignature || currentSignature === initialSignature) continue;

      const verified = await verifyLoginWithPlaywright(page).catch(() => false);
      if (!verified) continue;
      loggedIn = true;
      break;
    }

    if (!loggedIn) throw new Error('Login timeout or QR login was not completed');

    const state = await context.storageState();
    if (!hasValidSessionCookie(state)) throw new Error('Login state not captured');
    saveCookiesFromPlaywright(state);
    console.log('[login] Success! Cookies saved.');

    await browser.close();
  } catch (err) {
    if (browser) { try { await browser.close(); } catch {} }
    throw err;
  } finally {
    loginInProgress = false;
  }
}

// ===== Server =====

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, loggedIn: isLoggedIn() });
    }

    if (url.pathname === '/api/login-status' && req.method === 'GET') {
      return sendJson(res, 200, { loggedIn: isLoggedIn() });
    }

    if (url.pathname === '/api/login' && req.method === 'POST') {
      try {
        await doLogin();
        return sendJson(res, 200, { success: true });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    if (url.pathname === '/api/logout' && req.method === 'POST') {
      clearCookies();
      return sendJson(res, 200, { success: true });
    }

    // Parse - extract video info from share URL
    if (url.pathname === '/api/parse' && req.method === 'POST') {
      const body = await readBody(req);
      let input;
      try { input = JSON.parse(body); } catch { return sendJson(res, 400, { error: 'Invalid JSON' }); }
      const shareUrl = input.url;
      if (!shareUrl) return sendJson(res, 400, { error: 'No url' });

      const m = shareUrl.match(/https?:\/\/[^\s]*jimeng[^\s]*/i);
      const cleanUrl = m ? m[0].replace(/[，。！？》）\]]+$/, '') : shareUrl;

      const urlToResolve = extractCandidateUrl(cleanUrl);
      console.log('[parse] url:', urlToResolve.substring(0, 120));

      let resolvedUrl = urlToResolve;
      try {
        resolvedUrl = await resolveShareUrl(urlToResolve);
      } catch (e) {
        console.log('[parse] resolveShareUrl failed, fallback to raw:', e.message);
      }

      const itemId = extractItemId(resolvedUrl) || extractItemId(urlToResolve) || extractItemId(cleanUrl) || extractItemId(shareUrl);
      if (!itemId) throw new Error('Cannot extract item ID from URL. Please use a share link like: https://jimeng.jianying.com/m/aigc/share/share-vid?id=XXX');

      console.log('[parse] itemId:', itemId);

      let parseFailureReason = '';

      // Step 1: Try curl API first
      let item = null;
      try {
        item = await fetchVideoItem(itemId);
        console.log('[parse] Got item via curl API');
      } catch (apiErr) {
        parseFailureReason = 'API fallback failed: ' + apiErr.message;
        console.log('[parse] curl API failed:', apiErr.message);
      }

      // Step 2: Fallback to Playwright if curl failed
      if (!item && isLoggedIn()) {
        try {
          console.log('[parse] Trying Playwright...');
          item = await fetchVideoItemPw(itemId, resolvedUrl);
          console.log('[parse] Got item via Playwright');
        } catch (pwErr) {
          parseFailureReason = 'Playwright fallback failed: ' + pwErr.message;
          console.log('[parse] Playwright failed:', pwErr.message);
        }
      }

      if (!item) throw new Error(parseFailureReason || 'Failed to fetch video info. Please check the URL or try logging in.');

      const result = extractVideoFromItem(item);
      if (result.__directResult && result.watermarkEndingUrl && !result.altVideoUrl) {
        try {
          const totalDuration = await probeDurationSeconds(result.videoUrl);
          const endingDuration = await probeDurationSeconds(result.watermarkEndingUrl);
          result.totalDuration = totalDuration;
          result.watermarkDuration = Math.min(totalDuration, endingDuration);
          result.videoDuration = Math.max(0, totalDuration - result.watermarkDuration);
          result.durationMs = Math.round(totalDuration * 1000);
          result.watermarkType = result.watermarkDuration > 0 ? 1 : 0;
        } catch (e) {
          console.log('[parse] ffprobe watermark probe failed:', e.message);
        }
      }
      const rawDownloadUrl = result.rawVideoUrl || result.videoUrl;
      const cleanDownloadUrl = result.altVideoUrl || result.videoUrl;
      const downloadUrl = result.__directResult && result.rawVideoUrl && result.altVideoUrl && result.altVideoUrl !== result.rawVideoUrl
        ? result.rawVideoUrl
        : cleanDownloadUrl;
      const fileName = (result.title || 'jimeng_video').replace(/[\\/:*?"<>|]/g, '_') + '.mp4';
      let noWatermarkDownloadUrl = '';
      if (result.altVideoUrl && result.rawVideoUrl && result.altVideoUrl !== result.rawVideoUrl) {
        noWatermarkDownloadUrl = '/api/download?url=' + encodeURIComponent(cleanDownloadUrl)
          + '&name=' + encodeURIComponent((result.title || 'jimeng_video').replace(/[\\/:*?"<>|]/g, '_') + '_no_wm.mp4');
      } else if (result.watermarkDuration > 0) {
        noWatermarkDownloadUrl = '/api/download?url=' + encodeURIComponent(cleanDownloadUrl)
          + '&name=' + encodeURIComponent((result.title || 'jimeng_video').replace(/[\\/:*?"<>|]/g, '_') + '_no_wm.mp4')
          + '&trim=' + result.watermarkDuration
          + '&duration=' + result.totalDuration;
      } else {
        noWatermarkDownloadUrl = '/api/download?url=' + encodeURIComponent(cleanDownloadUrl) + '&name=' + encodeURIComponent(fileName);
      }
      console.log('[parse] done, watermark:', result.watermarkDuration + 's');

      return sendJson(res, 200, {
        success: true,
        loggedIn: isLoggedIn(),
        method: item ? 'api' : 'playwright',
        ...result,
        downloadUrl,
        noWatermarkDownloadUrl,
      });
    }

    // Download proxy - streams video, optionally trims watermark ending
    if (url.pathname === '/api/download' && req.method === 'GET') {
      const videoUrl = url.searchParams.get('url');
      const fileName = url.searchParams.get('name') || 'jimeng_video.mp4';
      const trimEnd = url.searchParams.get('trim');
      const totalDur = url.searchParams.get('duration');
      if (!videoUrl) return sendJson(res, 400, { error: 'No url param' });
      console.log('[download]', videoUrl.substring(0, 80), 'trim:', trimEnd);

      if (trimEnd && parseFloat(trimEnd) > 0 && totalDur) {
        // Use ffmpeg to trim watermark ending via stream copy
        const keepDuration = Math.max(0.5, parseFloat(totalDur) - parseFloat(trimEnd));
        const tmpFile = path.join(DATA_DIR, 'tmp_' + Date.now() + '.mp4');

        const ffmpegArgs = [
          '-y',
          '-headers', 'User-Agent: ' + UA + '\r\nReferer: https://jimeng.jianying.com/',
          '-i', videoUrl,
          '-t', keepDuration.toString(),
          '-c', 'copy',
          '-avoid_negative_ts', '1',
          tmpFile,
        ];

        try {
          await new Promise((resolve, reject) => {
            const child = spawn(getBundledBinaryPath('ffmpeg'), ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
            let stderr = '';
            child.stderr.on('data', (d) => { stderr += d; });
            child.on('error', reject);
            child.on('close', (code) => {
              if (code !== 0) reject(new Error('ffmpeg exit ' + code + ': ' + stderr.substring(0, 300)));
              else resolve();
            });
          });

          const stat = fs.statSync(tmpFile);
          res.writeHead(200, {
            'Content-Type': 'video/mp4',
            'Content-Disposition': 'attachment; filename="' + fileName + '"',
            'Access-Control-Allow-Origin': '*',
            'Content-Length': stat.size,
          });
          const stream = fs.createReadStream(tmpFile);
          stream.pipe(res);
          stream.on('close', () => { try { fs.unlinkSync(tmpFile); } catch {} });
          stream.on('error', () => { try { fs.unlinkSync(tmpFile); } catch {} });
          return;
        } catch (ffErr) {
          console.log('[download] ffmpeg trim failed:', ffErr.message?.substring(0, 200));
          try { fs.unlinkSync(tmpFile); } catch {}
          // Fallback to direct stream
        }
      }

      return streamDirect(res, videoUrl, fileName);
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
      return res.end();
    }

    // Static files
    let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
    filePath = path.join(PUBLIC_DIR, filePath);
    try {
      const content = fs.readFileSync(filePath);
      const ext = path.extname(filePath);
      const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
      res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
      res.end(content);
    } catch {
      sendJson(res, 404, { error: 'Not found' });
    }
  } catch (err) {
    console.error('[handler]', err.message);
    try { sendJson(res, 500, { error: err.message }); } catch {}
  }
});

function streamDirect(res, videoUrl, fileName) {
  fetch(videoUrl, {
    headers: buildRequestHeaders({ Referer: 'https://jimeng.jianying.com/' }),
    redirect: 'follow',
  }).then((resp) => {
    if (!resp.ok || !resp.body) throw new Error('HTTP ' + resp.status);
    res.writeHead(200, {
      'Content-Type': resp.headers.get('content-type') || 'video/mp4',
      'Content-Disposition': 'attachment; filename="' + fileName + '"',
      'Access-Control-Allow-Origin': '*',
      'Transfer-Encoding': 'chunked',
    });
    Readable.fromWeb(resp.body).pipe(res);
  }).catch((e) => {
    console.log('[download] err:', e.message);
    try { sendJson(res, 500, { error: e.message }); } catch {}
  });
}

server.on('error', (err) => {
  console.error('Server error:', err.message);
  if (err.code === 'EADDRINUSE') console.error('Port ' + PORT + ' in use');
  process.exit(1);
});

server.listen(PORT, () => {
  const url = 'http://localhost:' + PORT;
  console.log('Ready: ' + url);
  if (process.platform === 'win32') execCb('start "" "' + url + '"');
});
