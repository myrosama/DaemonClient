# Portable image for the per-user media processor. Runs as-is on Render, Fly,
# Cloud Run, Railway, or your own machine — the app itself has no host-specific
# code, it just listens on $PORT.
FROM python:3.12-slim

# ffmpeg for video posters; the HEIC decoder ships as a pillow-heif wheel.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

# Never run as root: this process handles user photo bytes.
RUN useradd --create-home --uid 10001 processor
USER processor

ENV PORT=8080
EXPOSE 8080

# One worker, a few threads: conversions are CPU-bound and free instances have
# a single core, so extra workers would only multiply memory use.
CMD exec gunicorn app:app --bind 0.0.0.0:$PORT --workers 1 --threads 4 --timeout 120
