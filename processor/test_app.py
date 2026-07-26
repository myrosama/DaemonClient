"""Tests for the per-user media processor.

The security-critical property is the one exercised hardest here: an instance
with OWNER_UID set must refuse every caller except that one Firebase user, and
must refuse unsigned/forged tokens outright. Everything else about this service
is replaceable; that check is what makes a public URL safe to hand out.

Run: cd processor && python -m pytest test_app.py -q
"""

import base64
import importlib
import io
import json
import os
import sys

import pytest

# Sign real RS256 tokens so signature verification is genuinely exercised
# rather than mocked away.
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes
import datetime

from jose import jwt as jose_jwt

PROJECT = "test-project"
OWNER = "owner-uid-123"
KID = "testkey1"


def _make_keypair_and_cert():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "test")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=1))
        .sign(key, hashes.SHA256())
    )
    pem_key = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    pem_cert = cert.public_bytes(serialization.Encoding.PEM).decode()
    return pem_key, pem_cert


PRIVATE_PEM, CERT_PEM = _make_keypair_and_cert()
OTHER_PRIVATE_PEM, _ = _make_keypair_and_cert()


def _token(private_pem, uid=OWNER, aud=PROJECT, iss=None, expired=False):
    now = datetime.datetime.now(datetime.timezone.utc)
    exp = now - datetime.timedelta(hours=1) if expired else now + datetime.timedelta(hours=1)
    claims = {
        "iss": iss or f"https://securetoken.google.com/{aud}",
        "aud": aud,
        "sub": uid,
        "user_id": uid,
        "iat": int((now - datetime.timedelta(minutes=1)).timestamp()),
        "exp": int(exp.timestamp()),
    }
    return jose_jwt.encode(claims, private_pem, algorithm="RS256", headers={"kid": KID})


@pytest.fixture
def client(monkeypatch):
    os.environ["FIREBASE_PROJECT_ID"] = PROJECT
    os.environ["OWNER_UID"] = OWNER
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import app as app_module

    importlib.reload(app_module)
    # Serve our test certificate instead of reaching out to Google.
    monkeypatch.setattr(app_module, "_google_certs", lambda: {KID: CERT_PEM})
    app_module.app.config["TESTING"] = True
    return app_module.app.test_client()


def test_health_is_open_and_reports_capabilities(client):
    res = client.get("/health")
    body = res.get_json()
    assert body["service"] == "daemonclient-processor"
    assert body["ownerPinned"] is True
    assert "heicThumbnail" in body["capabilities"]


def test_conversion_requires_a_token(client):
    res = client.post("/convertHeicThumbnail", data=b"whatever")
    assert res.status_code == 401
    assert "missing bearer token" in res.get_json()["error"]


def test_forged_token_signed_by_the_wrong_key_is_rejected(client):
    forged = _token(OTHER_PRIVATE_PEM)
    res = client.post(
        "/convertHeicThumbnail",
        data=b"whatever",
        headers={"Authorization": f"Bearer {forged}"},
    )
    assert res.status_code == 401


def test_token_for_a_different_user_is_rejected_when_owner_pinned(client):
    intruder = _token(PRIVATE_PEM, uid="someone-else")
    res = client.post(
        "/convertHeicThumbnail",
        data=b"whatever",
        headers={"Authorization": f"Bearer {intruder}"},
    )
    assert res.status_code == 401
    assert "private to another account" in res.get_json()["error"]


def test_expired_token_is_rejected(client):
    stale = _token(PRIVATE_PEM, expired=True)
    res = client.post(
        "/convertHeicThumbnail",
        data=b"whatever",
        headers={"Authorization": f"Bearer {stale}"},
    )
    assert res.status_code == 401


def test_token_from_another_firebase_project_is_rejected(client):
    foreign = _token(PRIVATE_PEM, aud="somebody-elses-project")
    res = client.post(
        "/convertHeicThumbnail",
        data=b"whatever",
        headers={"Authorization": f"Bearer {foreign}"},
    )
    assert res.status_code == 401


def test_token_with_a_spoofed_issuer_is_rejected(client):
    spoofed = _token(PRIVATE_PEM, iss="https://evil.example.com/")
    res = client.post(
        "/convertHeicThumbnail",
        data=b"whatever",
        headers={"Authorization": f"Bearer {spoofed}"},
    )
    assert res.status_code == 401


def test_owner_token_is_accepted_and_empty_body_is_a_400_not_a_401(client):
    good = _token(PRIVATE_PEM)
    res = client.post(
        "/convertHeicThumbnail",
        data=b"",
        headers={"Authorization": f"Bearer {good}"},
    )
    # Auth passed (not 401); the request fails only because there are no bytes.
    assert res.status_code == 400


def test_owner_token_converts_a_real_image(client):
    """A JPEG stands in for HEIC: pillow-heif registers into the same Pillow
    decode path, so this proves the conversion+response plumbing end to end."""
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (1600, 1200), (10, 120, 90)).save(buf, format="JPEG")

    good = _token(PRIVATE_PEM)
    res = client.post(
        "/convertHeicThumbnail",
        data=buf.getvalue(),
        headers={"Authorization": f"Bearer {good}"},
    )
    assert res.status_code == 200
    assert res.headers["Content-Type"] == "image/jpeg"

    out = Image.open(io.BytesIO(res.data))
    assert max(out.size) <= 720  # downscaled to the thumbnail edge
    assert out.size[0] > out.size[1]  # aspect ratio preserved


def test_undecodable_bytes_return_422_not_500(client):
    good = _token(PRIVATE_PEM)
    res = client.post(
        "/convertHeicThumbnail",
        data=b"this is not an image at all",
        headers={"Authorization": f"Bearer {good}"},
    )
    assert res.status_code == 422


def test_unpinned_instance_accepts_any_valid_project_user(monkeypatch):
    """With OWNER_UID unset the instance serves the whole Firebase project."""
    os.environ["FIREBASE_PROJECT_ID"] = PROJECT
    os.environ.pop("OWNER_UID", None)
    import app as app_module

    importlib.reload(app_module)
    monkeypatch.setattr(app_module, "_google_certs", lambda: {KID: CERT_PEM})
    app_module.app.config["TESTING"] = True
    c = app_module.app.test_client()

    res = c.post(
        "/convertHeicThumbnail",
        data=b"",
        headers={"Authorization": f"Bearer {_token(PRIVATE_PEM, uid='anyone')}"},
    )
    assert res.status_code == 400  # auth passed, body empty
    assert c.get("/health").get_json()["ownerPinned"] is False
