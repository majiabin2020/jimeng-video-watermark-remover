const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const distDir = path.join(projectRoot, 'dist');
const runtimeDir = path.join(distDir, 'runtime');
const ffmpegDir = path.join(runtimeDir, 'ffmpeg');
const playwrightDir = path.join(runtimeDir, 'playwright');
const publicDistDir = path.join(distDir, 'public');
const dataDistDir = path.join(distDir, 'data');
const publicSrcDir = path.join(projectRoot, 'public');
const browserRoot = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
const ffmpegBin = process.env.FFMPEG_BIN || 'D:/soft/ffmpeg/bin';
const releaseZipName = 'jimeng-parser-portable-win-x64.zip';
const releaseZipPath = path.join(projectRoot, releaseZipName);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function cleanDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function cleanOptionalDistDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function copyDir(src, dest) {
  fs.cpSync(src, dest, { recursive: true, force: true });
}

function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function listInstalledChromium(browserJsonPath) {
  const data = JSON.parse(fs.readFileSync(browserJsonPath, 'utf8'));
  return data.browsers.filter((browser) => browser.name === 'chromium' && browser.installByDefault);
}

function copyPlaywrightChromium() {
  const registryFile = path.join(projectRoot, 'node_modules', 'playwright-core', 'browsers.json');
  if (!fs.existsSync(registryFile)) {
    throw new Error('Missing playwright-core/browsers.json');
  }

  const browsers = listInstalledChromium(registryFile);
  if (!browsers.length) {
    throw new Error('No Chromium entry found in Playwright browsers.json');
  }

  let copied = false;
  for (const browser of browsers) {
    const folderName = `${browser.name}-${browser.revision}`;
    const src = path.join(browserRoot, folderName);
    if (!fs.existsSync(src)) continue;
    copyDir(src, path.join(playwrightDir, folderName));
    copied = true;
  }

  if (!copied) {
    throw new Error(`No installed Playwright Chromium found under ${browserRoot}`);
  }
}

function copyFfmpeg() {
  const ffmpegExe = path.join(ffmpegBin, 'ffmpeg.exe');
  const ffprobeExe = path.join(ffmpegBin, 'ffprobe.exe');
  if (!fs.existsSync(ffmpegExe) || !fs.existsSync(ffprobeExe)) {
    throw new Error(`Missing ffmpeg.exe or ffprobe.exe in ${ffmpegBin}`);
  }
  copyFile(ffmpegExe, path.join(ffmpegDir, 'ffmpeg.exe'));
  copyFile(ffprobeExe, path.join(ffmpegDir, 'ffprobe.exe'));
}

function writeLauncher() {
  const launcher = [
    '@echo off',
    'setlocal',
    'cd /d "%~dp0"',
    'start "" "jimeng-parser.exe"',
    'endlocal',
    ''
  ].join('\r\n');
  fs.writeFileSync(path.join(distDir, '启动即梦解析器.bat'), launcher, 'utf8');
}

function writeManifest() {
  const entries = [];
  function walk(dir, base = dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, base);
      } else {
        const rel = path.relative(base, full);
        const size = fs.statSync(full).size;
        entries.push({ path: rel.replace(/\\/g, '/'), size });
      }
    }
  }
  walk(distDir);
  fs.writeFileSync(path.join(distDir, 'manifest.json'), JSON.stringify(entries, null, 2));
}

function createReleaseZip() {
  if (fs.existsSync(releaseZipPath)) fs.rmSync(releaseZipPath, { force: true });
  execFileSync('powershell', [
    '-NoProfile',
    '-Command',
    `Compress-Archive -Path '${distDir.replace(/'/g, "''")}\\*' -DestinationPath '${releaseZipPath.replace(/'/g, "''")}' -Force`
  ], { stdio: 'inherit' });
}

function ensureBuiltExe() {
  const exe = path.join(distDir, 'jimeng-parser.exe');
  if (!fs.existsSync(exe)) {
    throw new Error('dist/jimeng-parser.exe not found. Run npm run build first.');
  }
  if (!fs.existsSync(publicSrcDir)) {
    throw new Error('Missing public directory for pkg asset build.');
  }
}

function main() {
  ensureBuiltExe();
  cleanOptionalDistDir(publicDistDir);
  cleanOptionalDistDir(dataDistDir);
  ensureDir(runtimeDir);
  cleanDir(ffmpegDir);
  cleanDir(playwrightDir);
  copyFfmpeg();
  copyPlaywrightChromium();
  writeLauncher();
  writeManifest();
  createReleaseZip();
  console.log(`Portable runtime bundled into dist/. Release zip: ${releaseZipName}`);
}

main();
