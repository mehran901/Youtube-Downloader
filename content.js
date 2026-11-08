function findVideos() {
  const videos = [];
  const seen = new Set();

  document.querySelectorAll('video').forEach(video => {
    if (video.src && !video.src.startsWith('blob:') && !seen.has(video.src)) {
      seen.add(video.src);
      videos.push({
        url: video.src,
        filename: getFilename(video.src),
        type: video.type || guessType(video.src),
        size: 0,
        sizeText: '',
      });
    }

    video.querySelectorAll('source').forEach(source => {
      if (source.src && !source.src.startsWith('blob:') && !seen.has(source.src)) {
        seen.add(source.src);
        videos.push({
          url: source.src,
          filename: getFilename(source.src),
          type: source.type || guessType(source.src),
          size: 0,
          sizeText: '',
        });
      }
    });
  });

  document.querySelectorAll('a[href]').forEach(a => {
    const href = a.href;
    if (isVideoLink(href) && !seen.has(href)) {
      seen.add(href);
      videos.push({
        url: href,
        filename: getFilename(href),
        type: guessType(href),
        size: 0,
        sizeText: '',
      });
    }
  });

  return videos;
}

function findYouTubeVideos() {
  if (!location.hostname.includes('youtube.com')) return [];

  const videoId = new URLSearchParams(location.search).get('v');
  if (!videoId) return [];

  const videos = [];
  const title = getYouTubeTitle();

  const playerResponse = extractPlayerResponse();
  if (!playerResponse?.streamingData) return videos;

  const { formats, adaptiveFormats } = playerResponse.streamingData;

  if (formats) {
    for (const fmt of formats) {
      const url = fmt.url || decipherUrl(fmt);
      if (!url) continue;
      const info = parseYouTubeFormat(fmt, title, false, url);
      if (info) videos.push(info);
    }
  }

  if (adaptiveFormats) {
    for (const fmt of adaptiveFormats) {
      const url = fmt.url || decipherUrl(fmt);
      if (!url) continue;
      if (fmt.mimeType && fmt.mimeType.startsWith('audio/')) continue;
      const info = parseYouTubeFormat(fmt, title, true, url);
      if (info) videos.push(info);
    }
  }

  // Sort: combined formats first, then by quality descending
  videos.sort((a, b) => {
    if (a.isAdaptive !== b.isAdaptive) return a.isAdaptive ? 1 : -1;
    return (b.height || 0) - (a.height || 0);
  });

  return videos;
}

function decipherUrl(fmt) {
  if (fmt.signatureCipher || fmt.cipher) {
    try {
      const params = new URLSearchParams(fmt.signatureCipher || fmt.cipher);
      const url = params.get('url');
      return url || null;
    } catch { return null; }
  }
  return null;
}

function extractPlayerResponse() {
  const scripts = document.querySelectorAll('script');
  for (const script of scripts) {
    const text = script.textContent;
    if (!text || !text.includes('ytInitialPlayerResponse')) continue;

    const match = text.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;/s);
    if (match) {
      try { return JSON.parse(match[1]); } catch { /* continue */ }
    }
  }
  return null;
}

function getYouTubeTitle() {
  const titleEl = document.querySelector(
    'h1.ytd-watch-metadata yt-formatted-string, ' +
    '#title h1 yt-formatted-string, ' +
    'h1.title'
  );
  if (titleEl) return titleEl.textContent.trim();

  const ogTitle = document.querySelector('meta[property="og:title"]');
  if (ogTitle) return ogTitle.content;

  return document.title.replace(/ - YouTube$/, '').trim();
}

function parseYouTubeFormat(fmt, title, isAdaptive, url) {
  const mimeType = fmt.mimeType || '';
  const codec = mimeType.match(/codecs="([^"]+)"/)?.[1] || '';
  const container = mimeType.split(';')[0]?.split('/')[1] || 'mp4';
  const quality = fmt.qualityLabel || fmt.quality || '';
  const width = fmt.width || 0;
  const height = fmt.height || 0;
  const size = fmt.contentLength ? parseInt(fmt.contentLength, 10) : 0;
  const fps = fmt.fps || 0;

  const safeTitle = (title || 'youtube-video').replace(/[<>:"/\\|?*]/g, '_').substring(0, 150);
  const qualityTag = quality || (height ? `${height}p` : 'unknown');
  const filename = `${safeTitle} [${qualityTag}].${container}`;

  return {
    url,
    filename,
    type: mimeType.split(';')[0] || `video/${container}`,
    size,
    sizeText: formatBytes(size),
    quality: qualityTag,
    width,
    height,
    fps,
    codec,
    isAdaptive,
    source: 'youtube',
  };
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return size.toFixed(1) + ' ' + units[i];
}

function getFilename(url) {
  try {
    const path = new URL(url).pathname;
    const segments = path.split('/');
    const last = segments[segments.length - 1];
    if (last && last.includes('.')) {
      return decodeURIComponent(last);
    }
  } catch { /* ignore */ }
  return 'video.mp4';
}

function guessType(url) {
  const ext = url.split('?')[0].split('.').pop().toLowerCase();
  const map = {
    mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska',
    avi: 'video/x-msvideo', mov: 'video/quicktime', flv: 'video/x-flv',
    wmv: 'video/x-ms-wmv', m4v: 'video/mp4', ogv: 'video/ogg',
    '3gp': 'video/3gpp', m3u8: 'application/x-mpegurl'
  };
  return map[ext] || 'video/mp4';
}

const VIDEO_EXT = ['mp4', 'webm', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'm4v', 'ogv', '3gp'];

function isVideoLink(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return VIDEO_EXT.some(ext => path.endsWith('.' + ext));
  } catch {
    return false;
  }
}

function sanitize(name) {
  return (name || 'video').replace(/[<>:"/\\|?*]/g, '_').substring(0, 150);
}

function scanAndReport() {
  const domVideos = findVideos();
  let ytVideos = [];

  if (location.hostname.includes('youtube.com') && new URLSearchParams(location.search).get('v')) {
    ytVideos = findYouTubeVideos();
    const title = getYouTubeTitle();

    if (ytVideos.length === 0) {
      ytVideos.push({
        url: location.href,
        pageUrl: location.href,
        filename: sanitize(title) + '.mp4',
        type: 'video/mp4',
        quality: '',
        source: 'youtube',
        size: 0,
        sizeText: '',
      });
    } else {
      ytVideos.forEach(v => { v.pageUrl = location.href; });
    }
  }

  const allVideos = [...ytVideos, ...domVideos];

  if (allVideos.length > 0) {
    chrome.runtime.sendMessage({ type: 'VIDEO_FOUND', videos: allVideos });
  }
}

scanAndReport();

let scanTimeout = null;
const observer = new MutationObserver(() => {
  if (scanTimeout) clearTimeout(scanTimeout);
  scanTimeout = setTimeout(() => scanAndReport(), 2000);
});
observer.observe(document.body, { childList: true, subtree: true });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SCAN_FOR_VIDEOS') {
    scanAndReport();
    sendResponse({ done: true });
  }
});
