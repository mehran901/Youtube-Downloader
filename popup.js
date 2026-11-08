const SERVER = 'http://127.0.0.1:9876';
const content = document.getElementById('content');
const scanBtn = document.getElementById('scanBtn');
const historyBtn = document.getElementById('historyBtn');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');

let serverOnline = false;
let cookiesSynced = false;

async function syncCookies() {
  if (cookiesSynced) return;
  try {
    const urls = [
      "https://www.youtube.com/",
      "https://youtube.com/",
      "https://m.youtube.com/",
      "https://music.youtube.com/",
      "https://studio.youtube.com/",
      "https://www.google.com/",
      "https://accounts.google.com/",
    ];
    const queries = [];
    for (const url of urls) {
      // Non-partitioned
      queries.push(chrome.cookies.getAll({ url }));
      // Partitioned cookies (Chrome CHIPS)
      queries.push(chrome.cookies.getAll({ url, partitionKey: {} }).catch(() => []));
      queries.push(chrome.cookies.getAll({ url, partitionKey: { topLevelSite: url } }).catch(() => []));
    }
    const results = await Promise.all(queries);

    const seen = new Set();
    const cookies = [];
    for (const list of results) {
      for (const c of list) {
        const key = `${c.name}|${c.domain}|${c.path}`;
        if (!seen.has(key)) {
          seen.add(key);
          cookies.push(c);
        }
      }
    }
    if (cookies.length === 0) return;

    const resp = await fetch(`${SERVER}/cookies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookies }),
    });
    const data = await resp.json();
    if (data.status === 'ok') cookiesSynced = true;
  } catch { /* ignore */ }
}

async function checkServer() {
  try {
    const resp = await fetch(`${SERVER}/ping`, { signal: AbortSignal.timeout(2000) });
    const data = await resp.json();
    serverOnline = data.status === 'ok';
  } catch {
    serverOnline = false;
  }

  statusDot.className = `status-dot ${serverOnline ? 'online' : 'offline'}`;
  statusText.textContent = serverOnline
    ? 'Server connected'
    : 'Server offline - run start-server.bat';
}

function renderEmpty() {
  content.innerHTML = `
    <div class="empty">
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14zM9.5 7.5l7 4.5-7 4.5z"/>
      </svg>
      <p>No videos detected.<br>Open a page with a video and click <b>Scan</b>.</p>
    </div>
  `;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_').substring(0, 200);
}

function getTypeLabel(type) {
  if (!type) return 'Video';
  if (type.includes('mp4')) return 'MP4';
  if (type.includes('webm')) return 'WebM';
  if (type.includes('matroska') || type.includes('mkv')) return 'MKV';
  if (type.includes('quicktime') || type.includes('mov')) return 'MOV';
  if (type.includes('avi')) return 'AVI';
  if (type.includes('flv')) return 'FLV';
  if (type.includes('ogg')) return 'OGG';
  if (type.includes('mpegurl') || type.includes('m3u8')) return 'HLS';
  return 'Video';
}

function renderVideos(videos) {
  if (!videos || videos.length === 0) {
    renderEmpty();
    return;
  }

  const list = document.createElement('div');
  list.className = 'video-list';

  videos.forEach((video, index) => {
    const item = document.createElement('div');
    item.className = 'video-item';
    item.id = `video-${index}`;

    const isYouTube = video.source === 'youtube' || video.isYouTube;
    const typeLabel = getTypeLabel(video.type);
    const filename = video.filename || 'video';
    const sizeText = video.sizeText || '';
    const qualityText = video.quality || '';

    let actionBtn;
    if (isYouTube && serverOnline) {
      actionBtn = `<button class="fetch-btn" data-index="${index}" data-url="${escapeHtml(video.pageUrl || '')}" title="Fetch qualities">
        <svg viewBox="0 0 24 24"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>
      </button>`;
    } else {
      actionBtn = `<button class="download-btn" data-index="${index}" title="Download">
        <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
      </button>`;
    }

    item.innerHTML = `
      <div class="video-row">
        <div class="video-icon">
          <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
        </div>
        <div class="video-info">
          <div class="video-name" title="${escapeHtml(filename)}">${escapeHtml(filename)}</div>
          <div class="video-meta">
            <span class="badge">${typeLabel}</span>
            ${qualityText ? `<span class="badge quality">${escapeHtml(qualityText)}</span>` : ''}
            ${sizeText ? `<span>${sizeText}</span>` : ''}
          </div>
        </div>
        ${actionBtn}
      </div>
    `;

    list.appendChild(item);
  });

  content.innerHTML = '';
  content.appendChild(list);

  // Direct download buttons (non-YouTube)
  list.querySelectorAll('.download-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index, 10);
      const video = videos[idx];
      if (!video) return;

      const filename = sanitizeFilename(video.filename || 'video.mp4');
      chrome.runtime.sendMessage(
        { type: 'DOWNLOAD_VIDEO', url: video.url, filename },
        (response) => {
          if (response?.success) {
            btn.innerHTML = '<svg viewBox="0 0 24 24" fill="#fff"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
            btn.style.background = '#43a047';
          }
        }
      );
    });
  });

  // Fetch qualities buttons (YouTube via server)
  list.querySelectorAll('.fetch-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.index, 10);
      const video = videos[idx];
      if (!video) return;

      const pageUrl = video.pageUrl || video.url;
      const itemEl = document.getElementById(`video-${idx}`);

      btn.disabled = true;
      btn.innerHTML = '<div class="spinner" style="width:18px;height:18px;border-width:2px;margin:0"></div>';

      try {
        // Re-sync cookies to always use fresh ones (bot check mitigation)
        cookiesSynced = false;
        await syncCookies();
        const resp = await fetch(`${SERVER}/formats?url=${encodeURIComponent(pageUrl)}`);
        const data = await resp.json();

        if (data.error) {
          btn.innerHTML = '!';
          btn.title = data.error;
          showErrorBanner(itemEl, data.error);
          return;
        }

        renderFormats(itemEl, data, pageUrl);
      } catch (e) {
        btn.innerHTML = '!';
        btn.title = 'Server error';
      }
    });
  });
}

function showErrorBanner(itemEl, errorText) {
  const existing = itemEl.querySelector('.error-banner');
  if (existing) existing.remove();

  const banner = document.createElement('div');
  banner.className = 'error-banner';
  banner.style.cssText = 'margin:8px;padding:8px 10px;background:rgba(229,57,53,0.1);border:1px solid rgba(229,57,53,0.3);border-radius:6px;color:#ff8a80;font-size:11px;line-height:1.4';

  let msg = errorText;
  if (/not a bot|Sign in/i.test(errorText)) {
    msg = 'YouTube bot-check blocked this request. Try again in a minute, or make sure you\'re signed in to YouTube in Chrome.';
  } else if (/cookie/i.test(errorText)) {
    msg = 'Cookie error. Make sure you\'re signed in to YouTube.';
  }

  banner.textContent = msg;
  itemEl.appendChild(banner);
}

function renderFormats(itemEl, data, pageUrl) {
  const existing = itemEl.querySelector('.formats-section');
  if (existing) existing.remove();

  const section = document.createElement('div');
  section.className = 'formats-section';

  const formats = data.formats || [];
  if (formats.length === 0) {
    section.innerHTML = '<div style="color:#888;font-size:12px;padding:4px 8px">No downloadable formats found</div>';
    itemEl.appendChild(section);
    return;
  }

  formats.forEach(fmt => {
    const row = document.createElement('div');
    row.className = 'format-row';

    const sizeLabel = fmt.filesizeText || '';

    row.innerHTML = `
      <div class="format-info">
        <span class="badge quality">${escapeHtml(fmt.quality)}</span>
        <span class="badge">${fmt.ext.toUpperCase()}</span>
        <span class="badge audio">Video+Audio</span>
        ${sizeLabel ? `<span style="color:#888">${sizeLabel}</span>` : ''}
      </div>
      <button class="format-dl-btn">Download</button>
    `;

    const dlBtn = row.querySelector('.format-dl-btn');
    dlBtn.addEventListener('click', () => startServerDownload(dlBtn, pageUrl, fmt, data.title, row));

    section.appendChild(row);
  });

  itemEl.appendChild(section);
}

async function startServerDownload(btn, pageUrl, fmt, title, row) {
  btn.disabled = true;
  btn.textContent = 'Save As...';

  try {
    let formatSpec;
    if (fmt.hasAudio) {
      formatSpec = fmt.format_id;
    } else if (fmt.ext === 'mp4') {
      formatSpec = `${fmt.format_id}+bestaudio[ext=m4a]/bestaudio`;
    } else {
      formatSpec = `${fmt.format_id}+bestaudio`;
    }

    const resp = await fetch(`${SERVER}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: pageUrl,
        format_id: formatSpec,
        title: title || 'video',
      }),
    });

    const data = await resp.json();
    if (data.error) {
      if (data.error === 'Download cancelled') {
        btn.textContent = 'Download';
        btn.disabled = false;
      } else {
        btn.textContent = 'Error';
        btn.title = data.error;
      }
      return;
    }

    let progressBar = row.querySelector('.progress-bar');
    if (!progressBar) {
      progressBar = document.createElement('div');
      progressBar.className = 'progress-bar';
      progressBar.innerHTML = '<div class="progress-fill" style="width:0%"></div>';
      row.appendChild(progressBar);
    }

    pollProgress(data.id, btn, progressBar);
  } catch {
    btn.textContent = 'Error';
  }
}

function pollProgress(downloadId, btn, progressBar) {
  const fill = progressBar.querySelector('.progress-fill');
  const interval = setInterval(async () => {
    try {
      const resp = await fetch(`${SERVER}/status?id=${downloadId}`);
      const data = await resp.json();

      const pct = Math.round(data.progress || 0);
      fill.style.width = `${pct}%`;

      if (data.status === 'merging') {
        btn.textContent = 'Merging...';
      } else if (data.phase === 'audio' && data.status === 'downloading') {
        btn.textContent = `Audio ${pct}%`;
      } else if (data.status === 'downloading') {
        btn.textContent = `${pct}%`;
      }

      if (data.status === 'done') {
        clearInterval(interval);
        btn.textContent = 'Done!';
        btn.style.background = '#43a047';
        fill.style.width = '100%';
      }

      if (data.status === 'error') {
        clearInterval(interval);
        btn.textContent = 'Failed';
        btn.style.background = '#e53935';
        btn.title = data.error || 'Download failed';
      }
    } catch {
      clearInterval(interval);
      btn.textContent = 'Error';
    }
  }, 1000);
}

function getCurrentPageUrl() {
  return new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      resolve(tabs[0]?.url || '');
    });
  });
}

async function loadVideos() {
  const pageUrl = await getCurrentPageUrl();
  const isYouTube = pageUrl.includes('youtube.com/watch');
  const isPurePlaylist = pageUrl.includes('youtube.com/playlist');
  const hasPlaylistContext = isYouTube && pageUrl.includes('list=');

  // Pure playlist page: show only playlist UI
  if (isPurePlaylist && serverOnline) {
    renderPlaylistPlaceholder(pageUrl);
    return;
  }

  chrome.runtime.sendMessage({ type: 'GET_VIDEOS' }, (response) => {
    if (chrome.runtime.lastError) {
      if (isYouTube && serverOnline) {
        renderYouTubePlaceholder(pageUrl, hasPlaylistContext);
      } else {
        renderEmpty();
      }
      return;
    }

    let videos = response?.videos || [];

    // If on YouTube, mark videos and add page URL
    if (isYouTube) {
      if (videos.length === 0) {
        renderYouTubePlaceholder(pageUrl, hasPlaylistContext);
        return;
      }
      videos = videos.map(v => ({ ...v, isYouTube: v.source === 'youtube', pageUrl }));
      // If server is online and no YouTube-sourced videos, add a YouTube entry
      if (serverOnline && !videos.some(v => v.source === 'youtube')) {
        // Strip list= from URL for single-video download so we only get this video
        const singleUrl = pageUrl.split('&list=')[0].split('?list=')[0];
        videos.unshift({
          filename: getYouTubeTitle(pageUrl),
          type: 'video/mp4',
          source: 'youtube',
          isYouTube: true,
          pageUrl: singleUrl,
          url: singleUrl,
        });
      }
    }

    renderVideos(videos);
  });
}

function getYouTubeTitle(url) {
  return 'YouTube Video';
}

function renderYouTubePlaceholder(pageUrl, hasPlaylist = false) {
  if (!serverOnline) {
    content.innerHTML = `
      <div class="empty">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14zM9.5 7.5l7 4.5-7 4.5z"/>
        </svg>
        <p>YouTube video detected.<br>Start the server first:<br><b>start-server.bat</b></p>
      </div>
    `;
    return;
  }

  // Single video URL (strip playlist param)
  const singleUrl = pageUrl.split('&list=')[0].split('?list=')[0];

  renderVideos([{
    filename: 'This video only',
    type: 'video/mp4',
    source: 'youtube',
    isYouTube: true,
    pageUrl: singleUrl,
    url: singleUrl,
  }]);

  // If there's also a playlist context, append a playlist card below
  if (hasPlaylist) {
    appendPlaylistCard(pageUrl);
  }
}

function appendPlaylistCard(pageUrl) {
  const list = content.querySelector('.video-list');
  if (!list) return;

  const item = document.createElement('div');
  item.className = 'video-item';
  item.id = 'playlist-item';
  item.innerHTML = `
    <div class="video-row">
      <div class="video-icon">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h10v2H4zm13 0l3-2v4z"/></svg>
      </div>
      <div class="video-info">
        <div class="video-name">Entire playlist</div>
        <div class="video-meta">
          <span class="badge">Playlist</span>
          <span id="playlist-status" style="color:#888">Click to load videos</span>
        </div>
      </div>
      <button id="playlist-fetch" class="fetch-btn">
        <svg viewBox="0 0 24 24"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>
      </button>
    </div>
  `;
  list.appendChild(item);
  attachPlaylistFetchHandler(pageUrl);
}

function attachPlaylistFetchHandler(pageUrl) {
  const btn = document.getElementById('playlist-fetch');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    const status = document.getElementById('playlist-status');
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner" style="width:18px;height:18px;border-width:2px;margin:0"></div>';
    status.textContent = 'Loading playlist...';

    try {
      cookiesSynced = false;
      await syncCookies();
      const resp = await fetch(`${SERVER}/playlist?url=${encodeURIComponent(pageUrl)}`);
      const data = await resp.json();

      if (data.error) {
        const niceMsg = /not a bot|Sign in/i.test(data.error)
          ? 'YouTube bot-check - try again in a minute'
          : data.error.substring(0, 60);
        status.textContent = niceMsg;
        status.style.color = '#ff8a80';
        btn.innerHTML = '↻';
        btn.disabled = false;
        return;
      }

      renderPlaylistQualityPicker(pageUrl, data);
    } catch (e) {
      status.textContent = 'Server error';
      btn.innerHTML = '!';
    }
  });
}

async function renderPlaylistPlaceholder(pageUrl) {
  content.innerHTML = `
    <div class="video-list">
      <div class="video-item" id="playlist-item">
        <div class="video-row">
          <div class="video-icon">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h10v2H4zm13 0l3-2v4z"/></svg>
          </div>
          <div class="video-info">
            <div class="video-name">Playlist detected</div>
            <div class="video-meta">
              <span class="badge">Playlist</span>
              <span id="playlist-status" style="color:#888">Click to load videos</span>
            </div>
          </div>
          <button id="playlist-fetch" class="fetch-btn">
            <svg viewBox="0 0 24 24"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>
          </button>
        </div>
      </div>
    </div>
  `;
  attachPlaylistFetchHandler(pageUrl);
}

function renderPlaylistQualityPicker(pageUrl, playlistData) {
  const itemEl = document.getElementById('playlist-item');
  const existing = itemEl.querySelector('.formats-section');
  if (existing) existing.remove();

  const statusEl = document.getElementById('playlist-status');
  if (statusEl) statusEl.textContent = `${playlistData.count} videos found`;

  const nameEl = itemEl.querySelector('.video-name');
  if (nameEl) nameEl.textContent = playlistData.title || 'Playlist';

  const entries = playlistData.entries || [];
  const qualities = [
    { label: '2160p (4K)', height: 2160 },
    { label: '1440p', height: 1440 },
    { label: '1080p', height: 1080 },
    { label: '720p', height: 720 },
    { label: '480p', height: 480 },
    { label: '360p', height: 360 },
  ];

  const section = document.createElement('div');
  section.className = 'formats-section';

  // Video selection header with Select All / None
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:6px 8px;color:#aaa;font-size:11px';
  header.innerHTML = `
    <span>Select videos to download:</span>
    <div>
      <button class="mini-btn" data-action="all">All</button>
      <button class="mini-btn" data-action="none">None</button>
    </div>
  `;
  section.appendChild(header);

  // Video list with checkboxes
  const videoList = document.createElement('div');
  videoList.className = 'playlist-videos';
  videoList.style.cssText = 'max-height:180px;overflow-y:auto;background:rgba(0,0,0,0.2);border-radius:6px;margin:4px 8px';
  entries.forEach((entry, idx) => {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px;cursor:pointer;font-size:11px;border-bottom:1px solid rgba(255,255,255,0.05)';
    row.innerHTML = `
      <input type="checkbox" class="vid-check" data-index="${idx + 1}" checked style="accent-color:#e53935">
      <span style="color:#888;min-width:20px">${idx + 1}.</span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escape(entry.title || '')}">${escape(entry.title || 'Untitled')}</span>
    `;
    videoList.appendChild(row);
  });
  section.appendChild(videoList);

  // Select All / None handlers
  header.querySelectorAll('.mini-btn').forEach(b => {
    b.style.cssText = 'background:rgba(255,255,255,0.1);border:none;color:#eee;padding:3px 8px;border-radius:4px;cursor:pointer;font-size:10px;margin-right:4px';
    b.addEventListener('click', () => {
      const checked = b.dataset.action === 'all';
      videoList.querySelectorAll('.vid-check').forEach(c => c.checked = checked);
      updateSelectionCount();
    });
  });

  function updateSelectionCount() {
    const checked = videoList.querySelectorAll('.vid-check:checked').length;
    section.querySelectorAll('.sel-count').forEach(el => {
      el.textContent = `${checked} selected`;
    });
  }
  videoList.addEventListener('change', updateSelectionCount);

  // Delay input
  const delayRow = document.createElement('div');
  delayRow.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px;color:#aaa;font-size:11px';
  delayRow.innerHTML = `
    <span>Delay between videos:</span>
    <input type="number" id="pl-delay" min="0" max="60" step="0.5" value="0" style="width:60px;padding:4px 6px;background:#0f1424;border:1px solid rgba(255,255,255,0.1);border-radius:4px;color:#eee;font-size:11px">
    <span style="color:#888">min</span>
  `;
  section.appendChild(delayRow);

  // Quality picker
  qualities.forEach(q => {
    const row = document.createElement('div');
    row.className = 'format-row';
    row.innerHTML = `
      <div class="format-info">
        <span class="badge quality">${q.label}</span>
        <span class="badge audio">Video+Audio</span>
        <span class="sel-count" style="color:#888">${entries.length} selected</span>
      </div>
      <button class="format-dl-btn">Download</button>
    `;
    const dlBtn = row.querySelector('.format-dl-btn');
    dlBtn.addEventListener('click', () => {
      const selectedIndices = [...videoList.querySelectorAll('.vid-check:checked')].map(c => c.dataset.index);
      if (selectedIndices.length === 0) {
        dlBtn.textContent = 'Select videos first';
        setTimeout(() => dlBtn.textContent = 'Download', 1500);
        return;
      }
      const playlistItems = selectedIndices.join(',');
      const delayInput = document.getElementById('pl-delay');
      const sleepMinutes = parseFloat(delayInput?.value || '0') || 0;
      startPlaylistDownload(dlBtn, pageUrl, q.height, playlistData.title, row, playlistItems, sleepMinutes);
    });
    section.appendChild(row);
  });

  itemEl.appendChild(section);
}

async function startPlaylistDownload(btn, pageUrl, maxHeight, title, row, playlistItems, sleepMinutes) {
  btn.disabled = true;
  btn.textContent = 'Choose folder...';

  try {
    const formatSpec = `bestvideo[height<=${maxHeight}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${maxHeight}]+bestaudio/best[height<=${maxHeight}]/best`;

    const resp = await fetch(`${SERVER}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: pageUrl,
        format_id: formatSpec,
        title: title || 'playlist',
        is_playlist: true,
        max_height: maxHeight,
        playlist_items: playlistItems || '',
        sleep_minutes: sleepMinutes || 0,
      }),
    });

    const data = await resp.json();
    if (data.error) {
      if (data.error === 'Download cancelled') {
        btn.textContent = 'Download All';
        btn.disabled = false;
      } else {
        btn.textContent = 'Error';
        btn.title = data.error;
      }
      return;
    }

    let progressBar = row.querySelector('.progress-bar');
    if (!progressBar) {
      progressBar = document.createElement('div');
      progressBar.className = 'progress-bar';
      progressBar.innerHTML = '<div class="progress-fill" style="width:0%"></div>';
      row.appendChild(progressBar);
    }

    pollPlaylistProgress(data.id, btn, progressBar);
  } catch {
    btn.textContent = 'Error';
  }
}

function pollPlaylistProgress(downloadId, btn, progressBar) {
  const fill = progressBar.querySelector('.progress-fill');
  const interval = setInterval(async () => {
    try {
      const resp = await fetch(`${SERVER}/status?id=${downloadId}`);
      const data = await resp.json();

      const pct = Math.round(data.progress || 0);
      fill.style.width = `${pct}%`;

      if (data.total_videos && data.current_video) {
        btn.textContent = `${data.current_video}/${data.total_videos} - ${pct}%`;
      } else if (data.status === 'merging') {
        btn.textContent = 'Merging...';
      } else {
        btn.textContent = `${pct}%`;
      }

      if (data.status === 'done') {
        clearInterval(interval);
        btn.textContent = 'Done!';
        btn.style.background = '#43a047';
        fill.style.width = '100%';
      }

      if (data.status === 'error') {
        clearInterval(interval);
        btn.textContent = 'Failed';
        btn.style.background = '#e53935';
        btn.title = data.error || 'Download failed';
      }
    } catch {
      clearInterval(interval);
      btn.textContent = 'Error';
    }
  }, 1000);
}

let historyPollTimer = null;

function escape(s) {
  const div = document.createElement('div');
  div.textContent = s == null ? '' : String(s);
  return div.innerHTML;
}

function statusBadge(status) {
  const map = {
    downloading: { bg: 'rgba(33,150,243,0.2)', color: '#64b5f6', label: 'Downloading' },
    merging: { bg: 'rgba(255,152,0,0.2)', color: '#ffb74d', label: 'Merging' },
    done: { bg: 'rgba(76,175,80,0.2)', color: '#81c784', label: 'Done' },
    done_with_errors: { bg: 'rgba(255,152,0,0.2)', color: '#ffb74d', label: 'Done (incomplete)' },
    error: { bg: 'rgba(244,67,54,0.2)', color: '#e57373', label: 'Failed' },
    interrupted: { bg: 'rgba(158,158,158,0.2)', color: '#bdbdbd', label: 'Interrupted' },
  };
  const s = map[status] || { bg: 'rgba(158,158,158,0.2)', color: '#bdbdbd', label: status || '?' };
  return `<span class="badge" style="background:${s.bg};color:${s.color}">${s.label}</span>`;
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return d.toLocaleString();
}

function renderHistoryItem(d) {
  const pct = Math.round(d.progress || 0);
  const isPlaylist = d.is_playlist;
  const done = d.videos_done || [];
  const failed = d.videos_failed || [];

  let detail = '';
  const incomplete = d.incomplete_files || [];
  if (isPlaylist) {
    detail = `<div class="video-meta" style="margin-top:4px">
      ${done.length ? `<span class="badge audio">✓ ${done.length} done</span>` : ''}
      ${failed.length ? `<span class="badge" style="background:rgba(244,67,54,0.15);color:#e57373">✗ ${failed.length} failed</span>` : ''}
      ${incomplete.length ? `<span class="badge" style="background:rgba(255,152,0,0.15);color:#ffb74d">⚠ ${incomplete.length} incomplete</span>` : ''}
      ${d.total_videos ? `<span style="color:#888">${d.current_video || 0}/${d.total_videos}</span>` : ''}
    </div>`;

    if (failed.length) {
      const items = failed.slice(0, 5).map(f => `<div style="color:#e57373;font-size:11px;padding:2px 0">• ${escape(f.title)}: ${escape((f.error || '').substring(0, 100))}</div>`).join('');
      detail += `<div style="margin-top:6px;padding:6px;background:rgba(244,67,54,0.08);border-radius:4px">${items}</div>`;
    }

    if (incomplete.length) {
      const items = incomplete.slice(0, 5).map(fn => `<div style="color:#ffb74d;font-size:11px;padding:2px 0">• ${escape(fn)}</div>`).join('');
      detail += `<div style="margin-top:6px;padding:6px;background:rgba(255,152,0,0.08);border-radius:4px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
          <span style="color:#ffb74d;font-size:11px">Incomplete files (.part):</span>
          <button class="retry-btn" data-id="${escape(d.id)}" style="background:#ff9800;border:none;color:#fff;padding:3px 10px;border-radius:4px;font-size:10px;cursor:pointer">Retry</button>
        </div>
        ${items}
      </div>`;
    }
  }

  const progressBar = (d.status === 'downloading' || d.status === 'merging')
    ? `<div class="progress-bar" style="margin-top:8px"><div class="progress-fill" style="width:${pct}%"></div></div>`
    : '';

  return `
    <div class="video-item">
      <div class="video-row">
        <div class="video-info">
          <div class="video-name" title="${escape(d.title || '')}">${escape(d.title || d.filename || 'Download')}</div>
          <div class="video-meta">
            ${statusBadge(d.status)}
            ${isPlaylist ? '<span class="badge">Playlist</span>' : ''}
            <span style="color:#888;font-size:10px">${formatTime(d.started_at)}</span>
          </div>
          ${detail}
          ${progressBar}
        </div>
      </div>
    </div>
  `;
}

async function showHistory() {
  if (historyPollTimer) { clearInterval(historyPollTimer); historyPollTimer = null; }

  const render = async () => {
    try {
      const resp = await fetch(`${SERVER}/downloads`);
      const data = await resp.json();
      const items = data.downloads || [];

      if (items.length === 0) {
        content.innerHTML = `
          <div class="empty">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/>
            </svg>
            <p>No downloads yet</p>
          </div>
        `;
        return;
      }

      const list = items.map(renderHistoryItem).join('');
      content.innerHTML = `<div class="video-list">${list}</div>`;

      // Wire up retry buttons
      content.querySelectorAll('.retry-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.id;
          btn.disabled = true;
          btn.textContent = 'Retrying...';
          try {
            const resp = await fetch(`${SERVER}/retry`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ download_id: id }),
            });
            const data = await resp.json();
            if (data.error) {
              btn.textContent = 'Failed';
              btn.title = data.error;
              btn.style.background = '#e53935';
            } else {
              btn.textContent = 'Started';
              btn.style.background = '#43a047';
              setTimeout(render, 500);
            }
          } catch {
            btn.textContent = 'Error';
            btn.style.background = '#e53935';
          }
        });
      });
    } catch {
      content.innerHTML = '<div class="empty"><p>Server offline</p></div>';
    }
  };

  await render();
  // Auto-refresh for in-progress downloads
  historyPollTimer = setInterval(render, 1500);
}

historyBtn.addEventListener('click', () => {
  if (historyBtn.dataset.active === '1') {
    historyBtn.dataset.active = '';
    historyBtn.textContent = 'History';
    if (historyPollTimer) { clearInterval(historyPollTimer); historyPollTimer = null; }
    loadVideos();
  } else {
    historyBtn.dataset.active = '1';
    historyBtn.textContent = 'Back';
    showHistory();
  }
});

scanBtn.addEventListener('click', () => {
  scanBtn.textContent = '...';
  scanBtn.disabled = true;

  chrome.runtime.sendMessage({ type: 'SCAN_PAGE' }, () => {
    setTimeout(() => {
      loadVideos();
      scanBtn.textContent = 'Scan';
      scanBtn.disabled = false;
    }, 1000);
  });
});

async function hasActiveDownload() {
  try {
    const resp = await fetch(`${SERVER}/downloads`);
    const data = await resp.json();
    return (data.downloads || []).some(d => d.status === 'downloading' || d.status === 'merging');
  } catch { return false; }
}

checkServer().then(async () => {
  if (serverOnline) {
    await syncCookies();
    // If there's an active download, show history view automatically
    if (await hasActiveDownload()) {
      historyBtn.dataset.active = '1';
      historyBtn.textContent = 'Back';
      showHistory();
      return;
    }
  }
  loadVideos();
});
