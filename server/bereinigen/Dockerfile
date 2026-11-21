# Basis-Image, Pakete und LaMa-Modell fest angeheftet (Digest + Prüfsummen), siehe GitHub-Issue #5
FROM python:3.12-slim@sha256:4840d514c583a4d3d8cad3940e68dee6f0f6f3635c12fcd0a3d74c21a5b93a54
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOME=/tmp
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --require-hashes -r /tmp/requirements.txt && rm /tmp/requirements.txt \
 && groupadd --gid 10001 app && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin app
ARG LAMA_SHA256=1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6
RUN mkdir /models && python -c "import urllib.request; urllib.request.urlretrieve('https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx', '/models/lama_fp32.onnx')" \
 && echo "${LAMA_SHA256}  /models/lama_fp32.onnx" | sha256sum -c - \
 && chmod -R a+rX /models
COPY bereinigen.py /app/bereinigen.py
# ohne Root-Rechte (GitHub-Issue #4)
USER 10001:10001
CMD ["python", "-u", "/app/bereinigen.py"]
