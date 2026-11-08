const videoStore = new Map();

const ITAG_QUALITY = {
  '18': '360p', '22': '720p', '37': '1080p', '38': '3072p',
  '133': '240p', '134': '360p', '135': '480p', '136': '720p',
  '137': '1080p', '138': '2160p', '160': '144p',
  '242': '240p', '243': '360p', '244': '480p', '247': '720p',
  '248': '1080p', '271': '1440p', '313': '2160p',
  '298': '720p60', '299': '1080p60', '302': '720p60', '303': '1080p60',
  '308': '1440p60', '315': '2160p60', '330': '144p HDR', '331': '240p HDR',
  '332': '360p HDR', '333': '480p HDR', '334': '720p HDR', '335': '1080p HDR',
  '336': '1440p HDR', '337': '2160p HDR',
  '394': '144p', '395': '240p', '396': '360p', '397': '480p',
  '398': '720p', '399': '1080p', '400': '1440p', '401': '2160p',
  '571': '4320p',
};

const VIDEO_EXTENSIONS = [
  '.mp4', '.webm', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.m4v', '.ogv', '.3gp'
];

const VIDEO_MIME_PATTERNS = [
  'video/', 'application/x-mpegurl', 'application/vnd.apple.mpegurl',
  'application/dash+xml', 'application/octet-stream'
];

function isVideoUrl(url) {
  try {
    const urlObj = new URL(url);
    const path = urlObj.pathname.toLowerCase();
    if (VIDEO_EXTENSIONS.some(ext => path.includes(ext))) return true;
    if (urlObj.hostname.includes('googlevideo.com') && urlObj.pathname.includes('videoplayback')) return true;
    return false;
  } catch {
    return false;
  }
}

function getFilenameFromUrl(url) {
  try {
    const urlObj = new URL(url);
    const path = urlObj.pathname;
    const segments = path.split('/');
    const last = segments[segments.length - 1];
    if (last && last.includes('.')) {
      return decodeURIComponent(last);
    }
  } catch { /* ignore */ }
  return null;
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

function getVideosForTab(tabId) {
  return videoStore.get(tabId) || [];
}

function addVideoForTab(tabId, videoInfo) {
  const videos = videoStore.get(tabId) || [];
  const isDuplicate = videos.some(v => v.url === videoInfo.url);
  if (!isDuplicate) {
    videos.push(videoInfo);
    videoStore.set(tabId, videos);
    updateBadge(tabId, videos.length);
  }
}

function updateBadge(tabId, count) {
  const text = count > 0 ? String(count) : '';
  chrome.action.setBadgeText({ text, tabId });
  chrome.action.setBadgeBackgroundColor({ color: '#e53935', tabId });
}

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;

    const contentType = details.responseHeaders?.find(
      h => h.name.toLowerCase() === 'content-type'
    )?.value?.toLowerCase() || '';

    const contentLength = details.responseHeaders?.find(
      h => h.name.toLowerCase() === 'content-length'
    )?.value;

    const isVideo = VIDEO_MIME_PATTERNS.some(p => contentType.includes(p)) ||
                    isVideoUrl(details.url);

    if (!isVideo) return;
    if (contentType.includes('application/octet-stream') && !isVideoUrl(details.url)) return;

    // Skip YouTube SABR streaming chunks (POST-based, not directly downloadable)
    try {
      const urlObj = new URL(details.url);
      if (urlObj.hostname.includes('googlevideo.com') && urlObj.searchParams.get('sabr') === '1') return;
    } catch { /* ignore */ }

    const size = contentLength ? parseInt(contentLength, 10) : 0;
    if (size > 0 && size < 100000) return;

    let filename = getFilenameFromUrl(details.url) || 'video';
    let type = contentType.split(';')[0].trim() || 'video/mp4';
    let quality = '';

    // Extract info from googlevideo.com URLs
    try {
      const urlObj = new URL(details.url);
      if (urlObj.hostname.includes('googlevideo.com')) {
        const mime = urlObj.searchParams.get('mime') || type;
        type = mime;
        const itag = urlObj.searchParams.get('itag') || '';
        quality = ITAG_QUALITY[itag] || '';
        const ext = mime.includes('webm') ? 'webm' : 'mp4';
        filename = `youtube-video${quality ? ' [' + quality + ']' : ''}.${ext}`;
      }
    } catch { /* ignore */ }

    addVideoForTab(details.tabId, {
      url: details.url,
      filename,
      type,
      size,
      sizeText: formatBytes(size),
      quality,
      source: 'network',
      timestamp: Date.now()
    });
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'VIDEO_FOUND') {
    const tabId = sender.tab?.id;
    if (!tabId) return;
    const pageUrl = sender.tab?.url || '';
    message.videos.forEach(video => {
      addVideoForTab(tabId, {
        ...video,
        pageUrl: video.pageUrl || pageUrl,
        source: video.source || 'dom',
        timestamp: Date.now()
      });
    });
  }

  if (message.type === 'GET_VIDEOS') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (tabId) {
        sendResponse({ videos: getVideosForTab(tabId) });
      } else {
        sendResponse({ videos: [] });
      }
    });
    return true;
  }

  if (message.type === 'DOWNLOAD_VIDEO') {
    chrome.downloads.download({
      url: message.url,
      filename: message.filename || 'video.mp4',
      saveAs: true
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ success: true, downloadId });
      }
    });
    return true;
  }

  if (message.type === 'CAPTURE_BLOB') {
    const tabId = sender.tab?.id;
    if (tabId) {
      addVideoForTab(tabId, {
        url: message.blobDataUrl,
        filename: message.filename || 'video.mp4',
        type: message.mimeType || 'video/mp4',
        size: message.size || 0,
        sizeText: formatBytes(message.size || 0),
        source: 'blob',
        timestamp: Date.now()
      });
    }
  }

  if (message.type === 'SCAN_PAGE') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (tabId) {
        chrome.tabs.sendMessage(tabId, { type: 'SCAN_FOR_VIDEOS' }, (response) => {
          if (chrome.runtime.lastError) {
            sendResponse({ success: false });
          } else {
            sendResponse({ success: true });
          }
        });
      }
    });
    return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  videoStore.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    videoStore.delete(tabId);
    updateBadge(tabId, 0);
  }
});
