import json
import os
import subprocess
import sys
import threading
import re
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

DOWNLOAD_DIR = os.path.join(os.path.expanduser("~"), "Downloads")
COOKIES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cookies.txt")
PORT = 9876

downloads = {}
download_counter = 0
lock = threading.Lock()


def sanitize_filename(name):
    return re.sub(r'[<>:"/\\|?*]', '_', name)[:200]


class Handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)

        if path == "/ping":
            self._json_response({"status": "ok", "version": "1.0"})
            return

        if path == "/formats":
            url = params.get("url", [None])[0]
            if not url:
                self._json_response({"error": "Missing url parameter"}, 400)
                return
            self._get_formats(url)
            return

        if path == "/status":
            did = params.get("id", [None])[0]
            if did and did in downloads:
                self._json_response(downloads[did])
            else:
                self._json_response({"error": "Not found"}, 404)
            return

        self._json_response({"error": "Not found"}, 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/download":
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            self._start_download(body)
            return

        self._json_response({"error": "Not found"}, 404)

    def _get_formats(self, url):
        try:
            cmd = [sys.executable, "-m", "yt_dlp", "-J", "--no-warnings"]
            if os.path.exists(COOKIES_FILE):
                cmd.extend(["--cookies", COOKIES_FILE])
            else:
                cmd.extend(["--cookies-from-browser", "chrome"])
            cmd.append(url)
            result = subprocess.run(
                cmd,
                capture_output=True, text=True, timeout=30,
                encoding="utf-8", errors="replace"
            )
            if result.returncode != 0:
                self._json_response({"error": result.stderr.strip()}, 500)
                return

            info = json.loads(result.stdout)
            title = info.get("title", "video")
            duration = info.get("duration", 0)
            thumbnail = info.get("thumbnail", "")

            formats = []
            seen = set()

            for fmt in info.get("formats", []):
                vcodec = fmt.get("vcodec", "none")
                acodec = fmt.get("acodec", "none")

                if vcodec == "none" or vcodec is None:
                    continue

                format_id = fmt.get("format_id", "")
                if format_id in seen:
                    continue
                seen.add(format_id)

                has_audio = acodec != "none" and acodec is not None
                height = fmt.get("height") or 0
                ext = fmt.get("ext", "mp4")
                filesize = fmt.get("filesize") or fmt.get("filesize_approx") or 0

                quality = fmt.get("format_note", "") or f"{height}p"
                fps = fmt.get("fps") or 0

                formats.append({
                    "format_id": format_id,
                    "quality": quality,
                    "height": height,
                    "ext": ext,
                    "filesize": filesize,
                    "filesizeText": format_bytes(filesize),
                    "fps": fps,
                    "vcodec": vcodec.split(".")[0] if vcodec else "",
                    "acodec": acodec.split(".")[0] if acodec else "",
                    "hasAudio": has_audio,
                    "type": "combined" if has_audio else "video_only",
                })

            formats.sort(key=lambda f: (
                0 if f["hasAudio"] else 1,
                -(f["height"] or 0),
            ))

            self._json_response({
                "title": title,
                "duration": duration,
                "thumbnail": thumbnail,
                "formats": formats,
            })

        except subprocess.TimeoutExpired:
            self._json_response({"error": "Timeout fetching formats"}, 500)
        except Exception as e:
            self._json_response({"error": str(e)}, 500)

    def _start_download(self, body):
        global download_counter
        url = body.get("url")
        format_id = body.get("format_id", "best")
        title = body.get("title", "video")

        if not url:
            self._json_response({"error": "Missing url"}, 400)
            return

        with lock:
            download_counter += 1
            did = str(download_counter)

        safe_title = sanitize_filename(title)
        output_template = os.path.join(DOWNLOAD_DIR, f"{safe_title}.%(ext)s")

        downloads[did] = {
            "id": did,
            "status": "downloading",
            "progress": 0,
            "filename": "",
            "title": title,
        }

        def run():
            try:
                cmd = [
                    sys.executable, "-m", "yt_dlp",
                    "--no-warnings",
                    "--newline",
                    "-f", format_id,
                    "--merge-output-format", "mp4",
                    "-o", output_template,
                ]
                if os.path.exists(COOKIES_FILE):
                    cmd.extend(["--cookies", COOKIES_FILE])
                else:
                    cmd.extend(["--cookies-from-browser", "chrome"])
                cmd.append(url)
                proc = subprocess.Popen(
                    cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    text=True, encoding="utf-8", errors="replace"
                )

                for line in proc.stdout:
                    line = line.strip()
                    if "[download]" in line and "%" in line:
                        match = re.search(r'(\d+\.?\d*)%', line)
                        if match:
                            downloads[did]["progress"] = float(match.group(1))
                    if "[Merger]" in line or "Merging formats" in line:
                        downloads[did]["status"] = "merging"
                    if "Destination:" in line:
                        dest = line.split("Destination:", 1)[1].strip()
                        downloads[did]["filename"] = os.path.basename(dest)
                    if "has already been downloaded" in line:
                        downloads[did]["progress"] = 100

                proc.wait()

                if proc.returncode == 0:
                    downloads[did]["status"] = "done"
                    downloads[did]["progress"] = 100
                    if not downloads[did]["filename"]:
                        for ext in ["mp4", "webm", "mkv"]:
                            path = os.path.join(DOWNLOAD_DIR, f"{safe_title}.{ext}")
                            if os.path.exists(path):
                                downloads[did]["filename"] = f"{safe_title}.{ext}"
                                break
                else:
                    downloads[did]["status"] = "error"
                    downloads[did]["error"] = "yt-dlp exited with error"

            except Exception as e:
                downloads[did]["status"] = "error"
                downloads[did]["error"] = str(e)

        thread = threading.Thread(target=run, daemon=True)
        thread.start()

        self._json_response({"id": did, "status": "downloading"})

    def _json_response(self, data, code=200):
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode("utf-8"))

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def log_message(self, format, *args):
        print(f"[Server] {args[0]}")


def format_bytes(b):
    if not b:
        return ""
    for unit in ["B", "KB", "MB", "GB"]:
        if b < 1024:
            return f"{b:.1f} {unit}"
        b /= 1024
    return f"{b:.1f} TB"


if __name__ == "__main__":
    print(f"Video Downloader Server starting on http://localhost:{PORT}")
    print(f"Downloads will be saved to: {DOWNLOAD_DIR}")
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
