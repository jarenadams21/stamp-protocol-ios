FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && git clone https://github.com/nfc-developer/sdm-backend.git /opt/sdm-upstream \
    && git -C /opt/sdm-upstream checkout --detach 37585f0c76eded73798b936b17aa5e187075b78f \
    && test "$(git -C /opt/sdm-upstream rev-parse HEAD)" = "37585f0c76eded73798b936b17aa5e187075b78f" \
    && rm -rf /opt/sdm-upstream/.git /var/lib/apt/lists/*

WORKDIR /opt/sdm
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && useradd --system --uid 10001 --no-create-home sdm
COPY config.py wsgi.py ./
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 DERIVE_MODE=legacy
USER sdm
EXPOSE 5005
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5005/healthz', timeout=2)" || exit 1
CMD ["gunicorn", "--bind", "127.0.0.1:5005", "--workers", "2", "--worker-tmp-dir", "/dev/shm", "--access-logfile", "/dev/null", "--error-logfile", "/dev/null", "wsgi:app"]
