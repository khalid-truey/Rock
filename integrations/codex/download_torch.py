"""Download the pinned official Windows wheel in verified resumable ranges."""
import concurrent.futures
import hashlib
from pathlib import Path
import time
import urllib.request

URL = "https://download.pytorch.org/whl/cu128/torch-2.7.1%2Bcu128-cp312-cp312-win_amd64.whl"
SHA256 = "2bb8c05d48ba815b316879a18195d53a6472a03e297d971e916753f8e1053d30"
SIZE = 3273024349
CHUNK = 16 * 1024 * 1024
directory = Path(__file__).resolve().parents[3] / "data/downloads"
directory.mkdir(parents=True, exist_ok=True)
target = directory / "torch-2.7.1+cu128-cp312-cp312-win_amd64.whl"
partial = target.with_suffix(".partial")
markers = directory / "torch-parts"
markers.mkdir(exist_ok=True)
if not target.exists() and not partial.exists():
    with partial.open("wb") as file:
        file.truncate(SIZE)

def fetch(index):
    start = index * CHUNK
    end = min(SIZE, start + CHUNK) - 1
    marker = markers / str(index)
    if marker.exists():
        return
    for attempt in range(4):
        try:
            req = urllib.request.Request(URL, headers={"Range": f"bytes={start}-{end}"})
            with urllib.request.urlopen(req, timeout=60) as response:
                assert response.status == 206
                assert response.headers["Content-Range"] == f"bytes {start}-{end}/{SIZE}"
                with partial.open("r+b") as file:
                    file.seek(start)
                    remaining = end - start + 1
                    while remaining:
                        data = response.read(min(1024 * 1024, remaining))
                        if not data:
                            raise IOError("Truncated range")
                        file.write(data)
                        remaining -= len(data)
            marker.touch()
            return
        except Exception:
            if attempt == 3:
                raise
            time.sleep(attempt + 1)

if not target.exists():
    count = (SIZE + CHUNK - 1) // CHUNK
    started = time.monotonic()
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        for completed, future in enumerate(concurrent.futures.as_completed([executor.submit(fetch, i) for i in range(count)]), 1):
            future.result()
            if completed % 16 == 0 or completed == count:
                print(f"Downloaded {completed}/{count} ranges in {time.monotonic()-started:.0f}s", flush=True)
    with partial.open("rb") as file:
        actual = hashlib.file_digest(file, "sha256").hexdigest()
    if actual != SHA256:
        raise RuntimeError(f"Wheel checksum mismatch: {actual}")
    partial.rename(target)
else:
    with target.open("rb") as file:
        assert hashlib.file_digest(file, "sha256").hexdigest() == SHA256
print(f"Verified wheel: {target}", flush=True)
