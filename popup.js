const SERVER = 'http://127.0.0.1:9876';
const content = document.getElementById('content');
const scanBtn = document.getElementById('scanBtn');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');

let serverOnline = false;

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
        const resp = await fetch(`${SERVER}/formats?url=${encodeURIComponent(pageUrl)}`);
        const data = await resp.json();

        if (data.error) {
          btn.innerHTML = '!';
          btn.title = data.error;
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

    const audioLabel = fmt.hasAudio ? 'A+V' : 'V';
    const audioBadge = fmt.hasAudio
      ? '<span class="badge audio">Video+Audio</span>'
      : '<span class="badge" style="background:rgba(255,152,0,0.15);color:#ffa726">Video only</span>';

    row.innerHTML = `
      <div class="format-info">
        <span class="badge quality">${escapeHtml(fmt.quality)}</span>
        <span class="badge">${fmt.ext.toUpperCase()}</span>
        ${audioBadge}
        ${fmt.filesizeText ? `<span style="color:#888">${fmt.filesizeText}</span>` : ''}
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
  btn.textContent = 'Starting...';

  try {
    const formatSpec = fmt.hasAudio
      ? fmt.format_id
      : `${fmt.format_id}+bestaudio`;

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
      btn.textContent = 'Error';
      btn.title = data.error;
      return;
    }

    // Add progress bar
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

      fill.style.width = `${data.progress || 0}%`;
      btn.textContent = `${Math.round(data.progress || 0)}%`;

      if (data.status === 'merging') {
        btn.textContent = 'Merging...';
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

  chrome.runtime.sendMessage({ type: 'GET_VIDEOS' }, (response) => {
    if (chrome.runtime.lastError) {
      if (isYouTube && serverOnline) {
        renderYouTubePlaceholder(pageUrl);
      } else {
        renderEmpty();
      }
      return;
    }

    let videos = response?.videos || [];

    // If on YouTube, mark videos and add page URL
    if (isYouTube) {
      if (videos.length === 0) {
        renderYouTubePlaceholder(pageUrl);
        return;
      }
      videos = videos.map(v => ({ ...v, isYouTube: v.source === 'youtube', pageUrl }));
      // If server is online and no YouTube-sourced videos, add a YouTube entry
      if (serverOnline && !videos.some(v => v.source === 'youtube')) {
        videos.unshift({
          filename: getYouTubeTitle(pageUrl),
          type: 'video/mp4',
          source: 'youtube',
          isYouTube: true,
          pageUrl,
          url: pageUrl,
        });
      }
    }

    renderVideos(videos);
  });
}

function getYouTubeTitle(url) {
  return 'YouTube Video';
}

function renderYouTubePlaceholder(pageUrl) {
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

  renderVideos([{
    filename: 'YouTube Video',
    type: 'video/mp4',
    source: 'youtube',
    isYouTube: true,
    pageUrl,
    url: pageUrl,
  }]);
}

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

checkServer().then(() => loadVideos());
