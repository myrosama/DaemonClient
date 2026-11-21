# Basis-Image und Pakete fest angeheftet (Digest + Prüfsummen), siehe GitHub-Issue #5. Neu erzeugen:
#   pip-compile --generate-hashes --allow-unsafe -o requirements.txt requirements.in
FROM python:3.12-slim@sha256:4840d514c583a4d3d8cad3940e68dee6f0f6f3635c12fcd0a3d74c21a5b93a54
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOME=/tmp
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --require-hashes -r /tmp/requirements.txt && rm /tmp/requirements.txt \
 && groupadd --gid 10001 app && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin app
COPY kategorien.py relevanz.py /app/
# ohne Root-Rechte (GitHub-Issue #4)
USER 10001:10001
CMD ["python", "-u", "/app/kategorien.py"]
