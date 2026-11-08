// Injected into the page context to intercept video source assignments
(function() {
  const originalCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function(blob) {
    const url = originalCreateObjectURL.call(this, blob);
    if (blob instanceof Blob && blob.type && blob.type.startsWith('video/')) {
      window.postMessage({
        type: '__VIDEO_DOWNLOADER_BLOB__',
        blobUrl: url,
        mimeType: blob.type,
        size: blob.size
      }, '*');
    }
    return url;
  };
})();
