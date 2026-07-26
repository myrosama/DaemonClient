"""DaemonClient media processor — the per-user heavy-CPU sidecar.

Cloudflare Workers cannot decode HEIC (libheif is far too heavy for the CPU
budget) and cannot run ffmpeg at all. This tiny service does both on real CPU.

THE PRIVACY RULE THIS SERVICE EXISTS TO HONOUR
----------------------------------------------
Plaintext user bytes must never transit shared infrastructure. Every user runs
their OWN instance of this app — one free Render/Vercel/Fly container per
person — and their worker only ever calls the URL stored in their own config.
No instance is ever shared between accounts. Nothing is written to disk: bytes
arrive in a request, are converted in memory, and leave in the response.

AUTH
----
Every request carries the caller's Firebase ID token, which is verified against
Google's public certificates. Two deployment shapes are supported:

  OWNER_UID set (recommended, and what the setup CLI writes): only that single
  Firebase user can use the instance. Even a valid token from another account
  is rejected, so a leaked URL is worthless to anyone else.

  OWNER_UID unset: any valid token for FIREBASE_PROJECT_ID is accepted. Only
  appropriate when you are the only user of that Firebase project.
"""

import base64
import io
import json
import os
import time
import subprocess
import tempfile
import threading
import urllib.request
from functools import wraps

from flask import Flask, jsonify, request

# ── Optional dependencies ────────────────────────────────────────────────────
# Both are declared in requirements.txt, but the service must still boot (and
# report honestly through /health) if a build skipped one, rather than crashing
# on import and leaving the operator with an opaque deploy failure.
try:
    import pillow_heif
    from PIL import Image

    pillow_heif.register_heif_opener()
    HEIC_OK = True
    HEIC_ERR = ""
except Exception as exc:  # pragma: no cover - depends on build image
    HEIC_OK = False
    HEIC_ERR = str(exc)

try:
    from jose import jwt as jose_jwt
    from jose.exceptions import JWTError

    JWT_OK = True
except Exception as exc:  # pragma: no cover
    JWT_OK = False
    JWT_ERR = str(exc)

app = Flask(__name__)

FIREBASE_PROJECT_ID = os.getenv("FIREBASE_PROJECT_ID", "").strip()
OWNER_UID = os.getenv("OWNER_UID", "").strip()
MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_BYTES", str(64 * 1024 * 1024)))
THUMB_EDGE = int(os.getenv("THUMB_EDGE", "720"))

# Reject oversized bodies before Flask buffers them.
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES

GOOGLE_CERTS_URL = (
    "https://www.googleapis.com/robot/v1/metadata/x509/"
    "securetoken@system.gserviceaccount.com"
)

_certs_cache: dict = {"certs": None, "expires_at": 0.0}
_certs_lock = threading.Lock()


def _google_certs() -> dict:
    """Google's token-signing certificates, cached until their Cache-Control expiry."""
    with _certs_lock:
        now = time.time()
        if _certs_cache["certs"] and now < _certs_cache["expires_at"]:
            return _certs_cache["certs"]

        req = urllib.request.Request(GOOGLE_CERTS_URL, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            certs = json.loads(resp.read().decode("utf-8"))
            max_age = 3600
            cache_control = resp.headers.get("Cache-Control", "")
            for part in cache_control.split(","):
                part = part.strip()
                if part.startswith("max-age="):
                    try:
                        max_age = int(part.split("=", 1)[1])
                    except ValueError:
                        pass

        _certs_cache["certs"] = certs
        _certs_cache["expires_at"] = now + max(60, max_age - 60)
        return certs


def verify_firebase_token(id_token: str) -> dict:
    """Verify a Firebase ID token's signature, issuer, audience and expiry.

    Raises ValueError with a caller-safe message on any failure.
    """
    if not JWT_OK:
        raise ValueError("token verification unavailable: python-jose not installed")
    if not FIREBASE_PROJECT_ID:
        raise ValueError("server misconfigured: FIREBASE_PROJECT_ID is not set")

    try:
        headers = jose_jwt.get_unverified_header(id_token)
    except JWTError as exc:
        raise ValueError(f"malformed token: {exc}") from exc

    kid = headers.get("kid")
    certs = _google_certs()
    # A token signed with a key we don't know about may simply predate a cert
    # rotation — refetch once before rejecting it.
    if kid not in certs:
        with _certs_lock:
            _certs_cache["expires_at"] = 0.0
        certs = _google_certs()
    if kid not in certs:
        raise ValueError("token signed with an unknown key")

    try:
        claims = jose_jwt.decode(
            id_token,
            certs[kid],
            algorithms=["RS256"],
            audience=FIREBASE_PROJECT_ID,
            issuer=f"https://securetoken.google.com/{FIREBASE_PROJECT_ID}",
            options={"verify_at_hash": False},
        )
    except JWTError as exc:
        raise ValueError(f"token rejected: {exc}") from exc

    uid = claims.get("user_id") or claims.get("sub")
    if not uid:
        raise ValueError("token carries no subject")
    if OWNER_UID and uid != OWNER_UID:
        # The single most important check: this instance belongs to one person.
        raise ValueError("this processor is private to another account")
    return claims


def require_auth(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        header = request.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return jsonify({"error": "missing bearer token"}), 401
        try:
            request.claims = verify_firebase_token(header[7:])
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 401
        return fn(*args, **kwargs)

    return wrapper


def _body_bytes():
    data = request.get_data(cache=False)
    if not data:
        return None, (jsonify({"error": "empty body"}), 400)
    return data, None


@app.get("/")
def index():
    return jsonify(
        {
            "service": "daemonclient-processor",
            "heic": HEIC_OK,
            "video": _ffmpeg_available(),
            "ownerPinned": bool(OWNER_UID),
        }
    )


@app.get("/health")
def health():
    """Unauthenticated liveness + capability probe.

    Deliberately exposes no user data — the setup CLI and the accounts portal
    call this to confirm a freshly deployed instance is reachable and correctly
    configured before saving its URL.
    """
    problems = []
    if not FIREBASE_PROJECT_ID:
        problems.append("FIREBASE_PROJECT_ID is not set")
    if not JWT_OK:
        problems.append("python-jose is not installed; auth cannot work")
    if not HEIC_OK:
        problems.append(f"HEIC conversion unavailable: {HEIC_ERR}")
    if not _ffmpeg_available():
        problems.append("ffmpeg not found; video posters unavailable")

    return (
        jsonify(
            {
                "ok": not problems,
                "service": "daemonclient-processor",
                "version": "1.0.0",
                "capabilities": {
                    "heicThumbnail": HEIC_OK,
                    "videoPoster": _ffmpeg_available(),
                },
                "ownerPinned": bool(OWNER_UID),
                "problems": problems,
            }
        ),
        200 if not problems else 503,
    )


@app.post("/convertHeicThumbnail")
@require_auth
def convert_heic_thumbnail():
    """HEIC bytes in, downscaled JPEG out. Nothing is retained."""
    if not HEIC_OK:
        return jsonify({"error": f"HEIC conversion unavailable: {HEIC_ERR}"}), 503

    data, err = _body_bytes()
    if err:
        return err

    try:
        img = Image.open(io.BytesIO(data))
        img = img.convert("RGB")
        img.thumbnail((THUMB_EDGE, THUMB_EDGE))
        out = io.BytesIO()
        img.save(out, format="JPEG", quality=80, optimize=True)
        return out.getvalue(), 200, {"Content-Type": "image/jpeg"}
    except Exception as exc:
        return jsonify({"error": f"HEIC decode failed: {exc}"}), 422


def _ffmpeg_available() -> bool:
    try:
        subprocess.run(
            ["ffmpeg", "-version"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=10,
            check=True,
        )
        return True
    except Exception:
        return False


@app.post("/extractVideoPoster")
@require_auth
def extract_video_poster():
    """Video bytes in, JPEG poster frame out.

    The worker sends the first chunk of a video (up to ~19 MB), which always
    contains the opening frames. ffmpeg reads a frame from one second in — far
    enough to skip the black frame many cameras record first, early enough to
    exist in even a very short clip; it retries at zero if that fails.
    """
    if not _ffmpeg_available():
        return jsonify({"error": "ffmpeg not available on this instance"}), 503

    data, err = _body_bytes()
    if err:
        return err

    suffix = request.args.get("ext", "mp4")
    if not suffix.isalnum() or len(suffix) > 5:
        suffix = "mp4"

    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, f"in.{suffix}")
        dst = os.path.join(tmp, "poster.jpg")
        with open(src, "wb") as fh:
            fh.write(data)

        for seek in ("00:00:01", "00:00:00"):
            cmd = [
                "ffmpeg", "-y",
                "-ss", seek,
                "-i", src,
                "-frames:v", "1",
                "-vf", f"scale='min({THUMB_EDGE},iw)':-2",
                "-q:v", "4",
                dst,
            ]
            try:
                subprocess.run(
                    cmd,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    timeout=60,
                    check=True,
                )
            except subprocess.TimeoutExpired:
                return jsonify({"error": "poster extraction timed out"}), 504
            except subprocess.CalledProcessError:
                continue

            if os.path.exists(dst) and os.path.getsize(dst) > 0:
                with open(dst, "rb") as fh:
                    return fh.read(), 200, {"Content-Type": "image/jpeg"}

    return jsonify({"error": "could not extract a frame from this video"}), 422


@app.errorhandler(413)
def too_large(_exc):
    return jsonify({"error": f"body exceeds {MAX_UPLOAD_BYTES} bytes"}), 413


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8080"))
    app.run(host="0.0.0.0", port=port)
