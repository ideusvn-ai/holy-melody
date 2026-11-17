#!/usr/bin/env python3
"""
Holy Melody AI worker – chạy độc lập với PHP (không chạy trong request web).

Vòng lặp: claim job → gọi adapter theo loại job → báo progress → complete/fail.
- Lỗi tạm thời (mạng, provider quá tải): fail(retryable=True) → backend đưa job về hàng đợi, KHÔNG trừ thêm credit.
- Lỗi hệ thống/provider vĩnh viễn: fail(refundable=True) → backend hoàn credit đúng một lần.
- Lỗi do dữ liệu người dùng (vd bài không có lời): fail(refundable=False).

Chỉ dùng thư viện chuẩn Python 3.10+. Cấu hình bằng biến môi trường:
  HM_API_URL, HM_WORKER_TOKEN, HM_STORAGE_DIR, HM_WORKER_ID
  HM_SVS_URL, HM_SVS_KEY   – nhà cung cấp tổng hợp giọng hát theo nốt (score-conditioned SVS)
Backend chỉ nhận job loại X khi HM_AI_ENABLED_TYPES chứa X, nên worker không bao giờ nhận job không xử lý được.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

API = os.environ.get("HM_API_URL", "").rstrip("/")
TOKEN = os.environ.get("HM_WORKER_TOKEN", "")
STORAGE = Path(os.environ.get("HM_STORAGE_DIR", "./storage"))
WORKER_ID = os.environ.get("HM_WORKER_ID", f"worker-{os.getpid()}")


class TemporaryError(Exception):
    """Lỗi tạm thời → thử lại sau"""


class UserInputError(Exception):
    """Dữ liệu đầu vào không hợp lệ → không hoàn credit"""


class NotConfigured(Exception):
    """Thiếu cấu hình provider → lỗi hệ thống, hoàn credit"""


def call(method: str, path: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(
        API + path,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read()
        return json.loads(raw) if raw else {}


# ---------------------------------------------------------------- adapters


class SingingAdapter:
    """
    Adapter cho dịch vụ tổng hợp giọng hát THEO NỐT (score-conditioned SVS).
    Giao thức chung giả định: POST {url}/jobs (MusicXML + tham số) → {id}; GET {url}/jobs/{id} → {status, progress, outputs:[{kind,url,format}]}.
    Mỗi nhà cung cấp thực tế cần một lớp con điều chỉnh theo API của họ.
    """

    def __init__(self) -> None:
        self.url = os.environ.get("HM_SVS_URL", "").rstrip("/")
        self.key = os.environ.get("HM_SVS_KEY", "")
        if not self.url or not self.key:
            raise NotConfigured("Chưa cấu hình HM_SVS_URL / HM_SVS_KEY cho nhà cung cấp giọng hát")

    def _req(self, method: str, path: str, body: dict | None = None) -> dict:
        req = urllib.request.Request(self.url + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                     headers={"Authorization": f"Bearer {self.key}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            if e.code in (408, 429, 500, 502, 503, 504):
                raise TemporaryError(f"SVS HTTP {e.code}") from e
            raise

    def run(self, job: dict, musicxml: str, progress) -> list[dict]:
        params = json.loads(job.get("params") or "{}")
        if not params.get("strict_melody", True):
            raise UserInputError("Holy Melody chỉ hỗ trợ chế độ giữ đúng giai điệu")
        created = self._req("POST", "/jobs", {"musicxml": musicxml, "melody_part_id": params.get("melody_part_id"), "verse": params.get("verse", 1),
                                              "voice": params.get("voice"), "style": params.get("style"), "language": "vi"})
        pid = created["id"]
        while True:
            st = self._req("GET", f"/jobs/{pid}")
            progress(int(st.get("progress") or 0))
            if st.get("status") == "completed":
                break
            if st.get("status") == "failed":
                raise RuntimeError(st.get("error") or "Nhà cung cấp báo lỗi")
            time.sleep(5)
        outputs = []
        for o in st.get("outputs", []):
            outputs.append(self._store(job, o["url"], o.get("kind", "full_mix"), o.get("format", "wav")))
        if not outputs:
            raise RuntimeError("Nhà cung cấp không trả về file âm thanh")
        return outputs

    def _store(self, job: dict, url: str, kind: str, fmt: str) -> dict:
        rel = Path("outputs") / str(job["user_id"]) / f"{job['id']}-{kind}.{fmt}"
        dest = STORAGE / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(url, timeout=120) as r, open(dest, "wb") as f:
            shutil.copyfileobj(r, f)
        meta = {"sha256": hashlib.sha256(dest.read_bytes()).hexdigest()}
        duration = probe_duration(dest)
        return {"kind": kind, "file_path": str(rel), "format": fmt, "bytes": dest.stat().st_size, "duration": duration, "metadata": meta}


def probe_duration(p: Path) -> float | None:
    if not shutil.which("ffprobe"):
        return None
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)], capture_output=True, text=True, timeout=30)
        return round(float(out.stdout.strip()), 3)
    except Exception:
        return None


ADAPTERS = {"singer": SingingAdapter}


# ---------------------------------------------------------------- vòng lặp


def process(job: dict) -> None:
    jid = job["id"]
    ref = STORAGE / job["input_reference"]
    try:
        if not ref.resolve().is_relative_to(STORAGE.resolve()) or not ref.is_file():
            raise UserInputError("Không tìm thấy bản nhạc đầu vào")
        adapter_cls = ADAPTERS.get(job["job_type"])
        if not adapter_cls:
            raise NotConfigured(f"Worker chưa hỗ trợ loại {job['job_type']}")
        adapter = adapter_cls()
        outputs = adapter.run(job, ref.read_text(encoding="utf-8"),
                              lambda pct: call("POST", f"/api/v1/worker/jobs/{jid}/progress", {"worker_id": WORKER_ID, "progress": pct}))
        call("POST", f"/api/v1/worker/jobs/{jid}/complete", {"worker_id": WORKER_ID, "provider": adapter_cls.__name__, "outputs": outputs})
        print(f"[ok] job {jid}")
    except TemporaryError as e:
        call("POST", f"/api/v1/worker/jobs/{jid}/fail", {"worker_id": WORKER_ID, "error_code": "TEMPORARY", "message": str(e), "retryable": True, "refundable": True})
    except UserInputError as e:
        call("POST", f"/api/v1/worker/jobs/{jid}/fail", {"worker_id": WORKER_ID, "error_code": "INVALID_INPUT", "message": str(e), "retryable": False, "refundable": False})
    except Exception as e:  # lỗi hệ thống / provider → hoàn credit
        call("POST", f"/api/v1/worker/jobs/{jid}/fail", {"worker_id": WORKER_ID, "error_code": type(e).__name__.upper(), "message": str(e)[:900], "retryable": False, "refundable": True})
        print(f"[fail] job {jid}: {e}", file=sys.stderr)


def main() -> None:
    if not API or not TOKEN:
        sys.exit("Cần HM_API_URL và HM_WORKER_TOKEN")
    print(f"Holy Melody AI worker {WORKER_ID} → {API}")
    while True:
        try:
            job = call("POST", "/api/v1/worker/claim", {"worker_id": WORKER_ID}).get("job")
        except Exception as e:
            print(f"[warn] claim: {e}", file=sys.stderr)
            time.sleep(10)
            continue
        if job:
            process(job)
        else:
            time.sleep(3)


if __name__ == "__main__":
    main()
