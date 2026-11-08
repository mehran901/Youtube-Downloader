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
HISTORY_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "downloads.json")
PORT = 9876

downloads = {}
download_counter = 0
lock = threading.Lock()


def load_history():
    global downloads, download_counter
    if not os.path.exists(HISTORY_FILE):
        return
    try:
        with open(HISTORY_FILE, "r", encoding="utf-8") as f:
            content = f.read().strip()
        if not content:
            print("[History] File empty, starting fresh")
            return
        data = json.loads(content)
        downloads = data.get("downloads", {})
        download_counter = data.get("counter", 0)
        # Mark any "downloading" states as "interrupted" since server restarted
        for d in downloads.values():
            if d.get("status") in ("downloading", "merging"):
                d["status"] = "interrupted"
        print(f"[History] Loaded {len(downloads)} past downloads")
    except Exception as e:
        print(f"[History] Load error: {e}")


def save_history():
    try:
        tmp = HISTORY_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"downloads": downloads, "counter": download_counter}, f, ensure_ascii=False)
        os.replace(tmp, HISTORY_FILE)
    except Exception as e:
        print(f"[History] Save error: {e}")


def sanitize_filename(name):
    return re.sub(r'[<>:"/\\|?*]', '_', name)[:200]


def get_cookie_args(require_cookies=False):
    if not require_cookies:
        return []
    if os.path.exists(COOKIES_FILE):
        return ["--cookies", COOKIES_FILE]
    return ["--cookies-from-browser", "chrome"]


def ask_save_path(default_name, default_dir=None):
    """Show Windows Save As dialog using tkinter. Returns chosen path or None."""
    result = [None]

    def run_dialog():
        try:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk()
            root.withdraw()
            root.attributes('-topmost', True)
            root.focus_force()

            ext = os.path.splitext(default_name)[1] or '.mp4'
            path = filedialog.asksaveasfilename(
                initialdir=default_dir or DOWNLOAD_DIR,
                initialfile=default_name,
                defaultextension=ext,
                filetypes=[
                    ("MP4 Video", "*.mp4"),
                    ("WebM Video", "*.webm"),
                    ("MKV Video", "*.mkv"),
                    ("All Files", "*.*"),
                ],
                title="Save Video As",
            )
            root.destroy()
            result[0] = path if path else None
        except Exception as e:
            print(f"[Dialog Error] {e}")
            result[0] = None

    t = threading.Thread(target=run_dialog)
    t.start()
    t.join(timeout=120)
    return result[0]


def ask_save_directory(playlist_name=""):
    """Ask user to select a folder for playlist downloads. Creates a subfolder named after the playlist."""
    result = [None]

    def run_dialog():
        try:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk()
            root.withdraw()
            root.attributes('-topmost', True)
            root.focus_force()

            path = filedialog.askdirectory(
                initialdir=DOWNLOAD_DIR,
                title=f"Choose folder for playlist: {playlist_name}",
                mustexist=True,
            )
            root.destroy()
            if path and playlist_name:
                sub = os.path.join(path, playlist_name)
                os.makedirs(sub, exist_ok=True)
                result[0] = sub
            else:
                result[0] = path if path else None
        except Exception as e:
            print(f"[Dialog Error] {e}")
            result[0] = None

    t = threading.Thread(target=run_dialog)
    t.start()
    t.join(timeout=120)
    return result[0]


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
            self._json_response({"status": "ok", "version": "1.2"})
            return

        if path == "/formats":
            url = params.get("url", [None])[0]
            if not url:
                self._json_response({"error": "Missing url parameter"}, 400)
                return
            self._get_formats(url)
            return

        if path == "/playlist":
            url = params.get("url", [None])[0]
            if not url:
                self._json_response({"error": "Missing url parameter"}, 400)
                return
            self._get_playlist(url)
            return

        if path == "/status":
            did = params.get("id", [None])[0]
            if did and did in downloads:
                self._json_response(downloads[did])
            else:
                self._json_response({"error": "Not found"}, 404)
            return

        if path == "/downloads":
            # Return all tracked downloads sorted by newest first
            items = sorted(
                downloads.values(),
                key=lambda d: d.get("started_at", 0),
                reverse=True,
            )
            self._json_response({"downloads": items[:20]})
            return

        self._json_response({"error": "Not found"}, 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length else {}

        if parsed.path == "/cookies":
            self._save_cookies(body)
            return

        if parsed.path == "/download":
            self._start_download(body)
            return

        if parsed.path == "/retry":
            self._retry_download(body)
            return

        self._json_response({"error": "Not found"}, 404)

    def _retry_download(self, body):
        global download_counter
        orig_id = str(body.get("download_id", ""))
        orig = downloads.get(orig_id)
        if not orig:
            self._json_response({"error": "Download not found"}, 404)
            return

        save_dir = orig.get("save_dir", "")
        if not save_dir or not os.path.isdir(save_dir):
            self._json_response({"error": "Save directory not found"}, 400)
            return

        with lock:
            download_counter += 1
            did = str(download_counter)

        import time
        downloads[did] = {
            "id": did,
            "status": "downloading",
            "progress": 0,
            "filename": "",
            "title": (orig.get("title") or "") + " (retry)",
            "phase": "video",
            "is_playlist": orig.get("is_playlist", False),
            "current_video": 0,
            "total_videos": 0,
            "started_at": int(time.time()),
            "save_dir": save_dir,
            "url": orig.get("url", ""),
            "videos_done": [],
            "videos_failed": [],
            "current_title": "",
            "format_id": orig.get("format_id", "best"),
            "output_template": orig.get("output_template", ""),
            "playlist_items": orig.get("playlist_items", ""),
            "sleep_minutes": orig.get("sleep_minutes", 0),
            "chosen_name": orig.get("chosen_name", ""),
            "is_retry": True,
        }

        # Migrate any .part files from save_dir into the temp subdir so yt-dlp resumes them
        temp_dir_init = os.path.join(save_dir, ".tmp_download")
        os.makedirs(temp_dir_init, exist_ok=True)
        for fn in os.listdir(save_dir):
            full = os.path.join(save_dir, fn)
            if fn.endswith(".ytdl"):
                try:
                    os.remove(full)
                except OSError:
                    pass
            elif fn.endswith(".part"):
                try:
                    import shutil
                    shutil.move(full, os.path.join(temp_dir_init, fn))
                except OSError:
                    pass

        def run():
            try:
                temp_dir = os.path.join(save_dir, ".tmp_download")
                os.makedirs(temp_dir, exist_ok=True)

                cmd = [
                    sys.executable, "-m", "yt_dlp",
                    "--ignore-config",
                    "--no-warnings",
                    "--newline",
                    "--progress",
                    "--concurrent-fragments", "4",
                    "--continue",
                    "--no-overwrites",
                    "--paths", f"home:{save_dir}",
                    "--paths", f"temp:{temp_dir}",
                    "-f", downloads[did]["format_id"],
                    "--merge-output-format", "mp4",
                    "-o", os.path.basename(downloads[did]["output_template"]),
                ]
                if downloads[did]["is_playlist"]:
                    cmd.extend(["--yes-playlist", "--ignore-errors"])
                    if downloads[did]["playlist_items"]:
                        cmd.extend(["--playlist-items", downloads[did]["playlist_items"]])
                cmd.extend(get_cookie_args(require_cookies=True))
                cmd.append(downloads[did]["url"])

                print(f"[Retry {did}] Starting retry of #{orig_id}")
                proc = subprocess.Popen(
                    cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    text=True, encoding="utf-8", errors="replace"
                )

                for line in proc.stdout:
                    line = line.strip()
                    if not line:
                        continue
                    print(f"[Retry {did}] {line}")

                    m = re.search(r'Downloading item (\d+) of (\d+)', line)
                    if m:
                        downloads[did]["current_video"] = int(m.group(1))
                        downloads[did]["total_videos"] = int(m.group(2))
                        continue

                    if "[download]" in line and "%" in line:
                        match = re.search(r'(\d+\.?\d*)%', line)
                        if match:
                            downloads[did]["progress"] = float(match.group(1))

                    if "[Merger]" in line or "Merging formats" in line:
                        downloads[did]["status"] = "merging"

                proc.wait()

                # Check for remaining .part files in temp dir
                incomplete = []
                if os.path.isdir(temp_dir):
                    try:
                        for fn in os.listdir(temp_dir):
                            if fn.endswith(".part") or fn.endswith(".ytdl"):
                                incomplete.append(fn)
                    except OSError:
                        pass
                downloads[did]["incomplete_files"] = incomplete

                # Clean up temp dir if empty
                if not incomplete and os.path.isdir(temp_dir):
                    try:
                        for fn in os.listdir(temp_dir):
                            try:
                                os.remove(os.path.join(temp_dir, fn))
                            except OSError:
                                pass
                        os.rmdir(temp_dir)
                    except OSError:
                        pass

                if incomplete:
                    downloads[did]["status"] = "done_with_errors"
                    downloads[did]["error"] = f"{len(incomplete)} file(s) still incomplete"
                else:
                    downloads[did]["status"] = "done"
                downloads[did]["progress"] = 100
                print(f"[Retry {did}] Done (incomplete: {len(incomplete)})")

            except Exception as e:
                downloads[did]["status"] = "error"
                downloads[did]["error"] = str(e)
                print(f"[Retry {did}] Exception: {e}")
            finally:
                save_history()

        thread = threading.Thread(target=run, daemon=True)
        thread.start()

        save_history()
        self._json_response({"id": did, "status": "downloading"})

    def _save_cookies(self, body):
        cookies = body.get("cookies", [])
        if not cookies:
            self._json_response({"error": "No cookies"}, 400)
            return

        try:
            import time
            default_exp = int(time.time()) + 365 * 24 * 3600
            with open(COOKIES_FILE, "w", encoding="utf-8", newline="\n") as f:
                f.write("# Netscape HTTP Cookie File\n")
                f.write("# This is a generated file!  Do not edit.\n\n")
                saved = 0
                for c in cookies:
                    domain = c.get("domain", "")
                    name = c.get("name", "")
                    if not domain or not name:
                        continue
                    flag = "TRUE" if domain.startswith(".") else "FALSE"
                    path = c.get("path", "/")
                    secure = "TRUE" if c.get("secure") else "FALSE"
                    exp_raw = c.get("expirationDate", 0)
                    expires = int(exp_raw) if exp_raw else default_exp
                    value = c.get("value", "")
                    f.write(f"{domain}\t{flag}\t{path}\t{secure}\t{expires}\t{name}\t{value}\n")
                    saved += 1
            print(f"[Cookies] Saved {saved} cookies to cookies.txt")
            self._json_response({"status": "ok", "count": saved})
        except Exception as e:
            print(f"[Cookies] Error: {e}")
            self._json_response({"error": str(e)}, 500)

    def _get_formats(self, url):
        try:
            cmd = [
                sys.executable, "-m", "yt_dlp",
                "--ignore-config",
                "-J", "--no-warnings",
            ]
            cmd.extend(get_cookie_args(require_cookies=False))
            cmd.append(url)
            print(f"[Formats] Fetching: {url}")
            result = subprocess.run(
                cmd,
                capture_output=True, text=True, timeout=120,
                encoding="utf-8", errors="replace"
            )
            if result.returncode != 0:
                err = result.stderr.strip()
                print(f"[Formats] yt-dlp error: {err[:300]}")
                if any(kw in err for kw in ("members-only", "Sign in", "Private", "not a bot", "cookies")):
                    cmd2 = [
                        sys.executable, "-m", "yt_dlp",
                        "--ignore-config",
                        "-J", "--no-warnings",
                    ]
                    cmd2.extend(get_cookie_args(require_cookies=True))
                    cmd2.append(url)
                    print("[Formats] Retrying with cookies...")
                    result = subprocess.run(
                        cmd2,
                        capture_output=True, text=True, timeout=120,
                        encoding="utf-8", errors="replace"
                    )
                if result.returncode != 0:
                    err_msg = result.stderr.strip()[:200] or "yt-dlp failed"
                    print(f"[Formats] Final error: {err_msg}")
                    self._safe_json({"error": err_msg}, 500)
                    return
            print(f"[Formats] Success, parsing...")

            info = json.loads(result.stdout)
            title = info.get("title", "video")
            duration = info.get("duration", 0)
            thumbnail = info.get("thumbnail", "")

            # Find best audio streams for size estimation
            best_audio_m4a = {"size": 0, "id": "", "abr": 0}
            best_audio_any = {"size": 0, "id": "", "abr": 0}
            for fmt in info.get("formats", []):
                vc = fmt.get("vcodec", "none")
                ac = fmt.get("acodec", "none")
                if (vc == "none" or vc is None) and ac and ac != "none":
                    sz = fmt.get("filesize") or fmt.get("filesize_approx") or 0
                    abr = fmt.get("abr") or 0
                    ext = fmt.get("ext", "")
                    # Estimate size from bitrate if not reported
                    if not sz and abr and duration:
                        sz = int(abr * 1000 / 8 * duration)
                    if abr > best_audio_any["abr"]:
                        best_audio_any = {"size": sz, "id": fmt.get("format_id", ""), "abr": abr}
                    if ext == "m4a" and abr > best_audio_m4a["abr"]:
                        best_audio_m4a = {"size": sz, "id": fmt.get("format_id", ""), "abr": abr}

            audio_size = best_audio_m4a["size"] or best_audio_any["size"]

            all_video = []
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
                vbr = fmt.get("vbr") or fmt.get("tbr") or 0

                if not filesize and vbr and duration:
                    filesize = int(vbr * 1000 / 8 * duration)

                quality = fmt.get("format_note", "") or f"{height}p"
                fps = fmt.get("fps") or 0

                if has_audio:
                    total_size = filesize
                else:
                    total_size = (filesize + audio_size) if filesize else audio_size

                all_video.append({
                    "format_id": format_id,
                    "quality": quality,
                    "height": height,
                    "ext": ext,
                    "filesize": filesize,
                    "totalSize": total_size,
                    "filesizeText": format_bytes(total_size) if total_size else "",
                    "fps": fps,
                    "vcodec": vcodec.split(".")[0] if vcodec else "",
                    "acodec": acodec.split(".")[0] if acodec else "",
                    "hasAudio": has_audio,
                    "type": "combined" if has_audio else "video_only",
                })

            # Deduplicate: one entry per resolution, prefer mp4 + smallest size
            best_per_height = {}
            for entry in all_video:
                h = entry["height"]
                if h not in best_per_height:
                    best_per_height[h] = entry
                else:
                    prev = best_per_height[h]
                    e_mp4 = entry["ext"] == "mp4"
                    p_mp4 = prev["ext"] == "mp4"
                    e_sz = entry["totalSize"] or float("inf")
                    p_sz = prev["totalSize"] or float("inf")
                    if e_mp4 and not p_mp4:
                        best_per_height[h] = entry
                    elif p_mp4 and not e_mp4:
                        pass
                    elif e_sz < p_sz:
                        best_per_height[h] = entry

            formats = list(best_per_height.values())
            formats.sort(key=lambda f: -(f["height"] or 0))

            print(f"[Formats] Returning {len(formats)} formats")
            self._safe_json({
                "title": title,
                "duration": duration,
                "thumbnail": thumbnail,
                "formats": formats,
                "audioSize": audio_size,
                "audioSizeText": format_bytes(audio_size),
            })

        except subprocess.TimeoutExpired:
            print("[Formats] Timeout")
            self._safe_json({"error": "Timeout fetching formats"}, 500)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            print("[Formats] Client disconnected")
        except Exception as e:
            print(f"[Formats] Exception: {e}")
            self._safe_json({"error": str(e)}, 500)

    def _get_playlist(self, url):
        try:
            cmd = [
                sys.executable, "-m", "yt_dlp",
                "--ignore-config",
                "--flat-playlist", "-J",
                "--no-warnings",
            ]
            cmd.extend(get_cookie_args(require_cookies=False))
            cmd.append(url)
            print(f"[Playlist] Fetching: {url}")
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=120,
                encoding="utf-8", errors="replace"
            )
            if result.returncode != 0:
                err = result.stderr.strip()
                print(f"[Playlist] Error: {err[:300]}")
                if any(kw in err for kw in ("members-only", "Sign in", "Private", "not a bot", "cookies")):
                    cmd2 = [
                        sys.executable, "-m", "yt_dlp",
                        "--ignore-config",
                        "--flat-playlist", "-J",
                        "--no-warnings",
                    ]
                    cmd2.extend(get_cookie_args(require_cookies=True))
                    cmd2.append(url)
                    result = subprocess.run(
                        cmd2, capture_output=True, text=True, timeout=120,
                        encoding="utf-8", errors="replace"
                    )
                if result.returncode != 0:
                    self._safe_json({"error": result.stderr.strip()[:200] or "yt-dlp failed"}, 500)
                    return

            info = json.loads(result.stdout)
            entries = info.get("entries", []) or []
            items = []
            for e in entries:
                if not e:
                    continue
                items.append({
                    "id": e.get("id", ""),
                    "title": e.get("title", ""),
                    "url": e.get("url") or f"https://www.youtube.com/watch?v={e.get('id', '')}",
                    "duration": e.get("duration", 0),
                })
            print(f"[Playlist] Found {len(items)} videos")
            self._safe_json({
                "title": info.get("title", "Playlist"),
                "count": len(items),
                "entries": items,
            })
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            print("[Playlist] Client disconnected")
        except Exception as e:
            print(f"[Playlist] Exception: {e}")
            self._safe_json({"error": str(e)}, 500)

    def _start_download(self, body):
        global download_counter
        url = body.get("url")
        format_id = body.get("format_id", "best")
        title = body.get("title", "video")
        is_playlist = body.get("is_playlist", False)
        max_height = body.get("max_height", 0)
        playlist_items = body.get("playlist_items", "")  # e.g. "1,3,5-8"
        sleep_minutes = float(body.get("sleep_minutes", 0) or 0)

        if not url:
            self._json_response({"error": "Missing url"}, 400)
            return

        with lock:
            download_counter += 1
            did = str(download_counter)

        safe_title = sanitize_filename(title)
        chosen_name = ""

        if is_playlist:
            # For playlists: ask for a folder, apply generic quality selector per video
            save_dir = ask_save_directory(safe_title)
            if not save_dir:
                self._json_response({"error": "Download cancelled"}, 400)
                return
            output_template = os.path.join(save_dir, "%(playlist_index)03d - %(title)s.%(ext)s")
        else:
            default_filename = f"{safe_title}.mp4"
            save_path = ask_save_path(default_filename)
            if not save_path:
                self._json_response({"error": "Download cancelled"}, 400)
                return
            save_dir = os.path.dirname(save_path)
            chosen_name = os.path.splitext(os.path.basename(save_path))[0]
            output_template = os.path.join(save_dir, f"{chosen_name}.%(ext)s")

        import time
        downloads[did] = {
            "id": did,
            "status": "downloading",
            "progress": 0,
            "filename": "",
            "title": title,
            "phase": "video",
            "is_playlist": is_playlist,
            "current_video": 0,
            "total_videos": 0,
            "started_at": int(time.time()),
            "save_dir": save_dir,
            "url": url,
            "videos_done": [],
            "videos_failed": [],
            "current_title": "",
            "format_id": format_id,
            "output_template": output_template,
            "playlist_items": playlist_items,
            "sleep_minutes": sleep_minutes,
            "chosen_name": chosen_name,
        }

        def run():
            try:
                # Isolate intermediate stream files in a hidden temp subfolder
                # so users only see the final merged mp4 in their save folder
                temp_dir = os.path.join(save_dir, ".tmp_download")
                os.makedirs(temp_dir, exist_ok=True)
                try:
                    import ctypes
                    FILE_ATTRIBUTE_HIDDEN = 0x02
                    ctypes.windll.kernel32.SetFileAttributesW(temp_dir, FILE_ATTRIBUTE_HIDDEN)
                except Exception:
                    pass

                cmd = [
                    sys.executable, "-m", "yt_dlp",
                    "--ignore-config",
                    "--no-warnings",
                    "--newline",
                    "--progress",
                    "--concurrent-fragments", "4",
                    "--paths", f"home:{save_dir}",
                    "--paths", f"temp:{temp_dir}",
                    "-f", format_id,
                    "--merge-output-format", "mp4",
                    "-o", os.path.basename(output_template),
                ]
                if is_playlist:
                    cmd.extend(["--yes-playlist", "--ignore-errors"])
                    if playlist_items:
                        cmd.extend(["--playlist-items", playlist_items])
                    if sleep_minutes > 0:
                        sleep_sec = int(sleep_minutes * 60)
                        cmd.extend([
                            "--min-sleep-interval", str(sleep_sec),
                            "--max-sleep-interval", str(sleep_sec),
                        ])
                cmd.extend(get_cookie_args(require_cookies=True))
                cmd.append(url)

                print(f"[Download {did}] Starting: {' '.join(cmd[-3:])}")
                proc = subprocess.Popen(
                    cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    text=True, encoding="utf-8", errors="replace"
                )

                download_count = 0
                is_merging = format_id and "+" in format_id
                current_item_title = ""
                current_item_merged = False

                for line in proc.stdout:
                    line = line.strip()
                    if not line:
                        continue

                    print(f"[Download {did}] {line}")

                    # Playlist progress: [download] Downloading item N of M
                    m = re.search(r'Downloading item (\d+) of (\d+)', line)
                    if m:
                        # Previous item wrap-up
                        if current_item_title:
                            if current_item_merged:
                                downloads[did]["videos_done"].append(current_item_title)
                            elif downloads[did].get("_last_error"):
                                downloads[did]["videos_failed"].append(downloads[did]["_last_error"])
                        downloads[did]["_last_error"] = None
                        downloads[did]["current_video"] = int(m.group(1))
                        downloads[did]["total_videos"] = int(m.group(2))
                        download_count = 0
                        current_item_merged = False
                        current_item_title = ""  # Reset so new item doesn't inherit old title
                        continue

                    # Capture YouTube video ID early (shown before Destination: line)
                    # Format: [youtube] <id>: Downloading webpage
                    yt_id_match = re.search(r'\[youtube\]\s+([^\s:]+):\s+Downloading webpage', line)
                    if yt_id_match and not current_item_title:
                        current_item_title = f"Video {downloads[did]['current_video']} ({yt_id_match.group(1)})"
                        downloads[did]["current_title"] = current_item_title

                    # Get title of current playlist item
                    tm = re.search(r'\[youtube\]\s+\S+:\s+Downloading webpage', line)
                    # ...title appears in later lines; capture via Destination filename instead

                    # yt-dlp error for one item in playlist (ignore-errors keeps going)
                    # Note: yt-dlp tries format fallbacks on error, so track last error
                    # but don't commit to "failed" until next item starts without a merge
                    if line.startswith("ERROR:") and is_playlist:
                        err_summary = line[:200]
                        name = current_item_title or f"Video {downloads[did]['current_video']}"
                        downloads[did]["_last_error"] = {"title": name, "error": err_summary}
                        continue

                    # Track which file is being downloaded
                    if "Destination:" in line:
                        download_count += 1
                        dest = line.split("Destination:", 1)[1].strip()
                        base = os.path.basename(dest)
                        downloads[did]["filename"] = base
                        # Record readable title (strip "NNN - " prefix and .ext)
                        name = os.path.splitext(base)[0]
                        name = re.sub(r'^\d+\s*-\s*', '', name)
                        # Strip .f<fmt> suffix that yt-dlp adds for separate streams
                        name = re.sub(r'\.f\d+$', '', name)
                        current_item_title = name
                        downloads[did]["current_title"] = name
                        if is_merging:
                            if download_count == 1:
                                downloads[did]["phase"] = "video"
                            else:
                                downloads[did]["phase"] = "audio"

                    # Parse progress percentage
                    if "[download]" in line and "%" in line:
                        match = re.search(r'(\d+\.?\d*)%', line)
                        if match:
                            raw_pct = float(match.group(1))
                            if is_merging:
                                if downloads[did]["phase"] == "video":
                                    downloads[did]["progress"] = raw_pct * 0.8
                                else:
                                    downloads[did]["progress"] = 80 + raw_pct * 0.15
                            else:
                                downloads[did]["progress"] = raw_pct

                    if "[Merger]" in line or "Merging formats" in line:
                        downloads[did]["status"] = "merging"
                        downloads[did]["progress"] = 95
                        current_item_merged = True

                    if "has already been downloaded" in line:
                        downloads[did]["progress"] = 100
                        current_item_merged = True

                # Last playlist item wrap-up after loop
                if is_playlist and current_item_title:
                    if current_item_merged:
                        if current_item_title not in downloads[did]["videos_done"]:
                            downloads[did]["videos_done"].append(current_item_title)
                    elif downloads[did].get("_last_error"):
                        downloads[did]["videos_failed"].append(downloads[did]["_last_error"])
                downloads[did].pop("_last_error", None)

                proc.wait()

                # Scan the temp folder for any .part files (incomplete downloads)
                incomplete = []
                if os.path.isdir(temp_dir):
                    try:
                        for fn in os.listdir(temp_dir):
                            if fn.endswith(".part") or fn.endswith(".ytdl"):
                                incomplete.append(fn)
                    except OSError:
                        pass
                downloads[did]["incomplete_files"] = incomplete
                downloads[did]["temp_dir"] = temp_dir

                # Clean up empty temp dir if everything succeeded
                if not incomplete and os.path.isdir(temp_dir):
                    try:
                        # Remove any leftover intermediate files first
                        for fn in os.listdir(temp_dir):
                            try:
                                os.remove(os.path.join(temp_dir, fn))
                            except OSError:
                                pass
                        os.rmdir(temp_dir)
                    except OSError:
                        pass

                if proc.returncode == 0 or (is_playlist and len(downloads[did]["videos_done"]) > 0):
                    if incomplete:
                        downloads[did]["status"] = "done_with_errors"
                        downloads[did]["error"] = f"{len(incomplete)} file(s) incomplete"
                    else:
                        downloads[did]["status"] = "done"
                    downloads[did]["progress"] = 100
                    # Find the final merged file (single-video case)
                    if not is_playlist and (not downloads[did]["filename"] or not os.path.exists(
                        os.path.join(save_dir, downloads[did]["filename"])
                    )):
                        for ext in ["mp4", "webm", "mkv"]:
                            path = os.path.join(save_dir, f"{chosen_name}.{ext}")
                            if os.path.exists(path):
                                downloads[did]["filename"] = f"{chosen_name}.{ext}"
                                break
                    print(f"[Download {did}] Done: {downloads[did]['filename']} (incomplete: {len(incomplete)})")
                else:
                    downloads[did]["status"] = "error"
                    downloads[did]["error"] = "yt-dlp exited with error"
                    print(f"[Download {did}] Failed with code {proc.returncode}")

            except Exception as e:
                downloads[did]["status"] = "error"
                downloads[did]["error"] = str(e)
                print(f"[Download {did}] Exception: {e}")
            finally:
                save_history()

        thread = threading.Thread(target=run, daemon=True)
        thread.start()

        save_history()
        self._json_response({"id": did, "status": "downloading"})

    def _json_response(self, data, code=200):
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode("utf-8"))

    def _safe_json(self, data, code=200):
        try:
            self._json_response(data, code)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            print("[Server] Client disconnected before response sent")

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
    print(f"Video Downloader Server v1.2")
    print(f"  URL: http://localhost:{PORT}")
    print(f"  Default save dir: {DOWNLOAD_DIR}")
    print(f"  Cookies: {'cookies.txt' if os.path.exists(COOKIES_FILE) else 'Chrome browser'}")
    load_history()
    print()
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
