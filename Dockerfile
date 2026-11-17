FROM python:3.14-slim
LABEL org.opencontainers.image.title="轻航 LiteNav" \
      org.opencontainers.image.description="Lightweight personal website and service dashboard"
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
WORKDIR /app
COPY server.py seed.json ./
COPY public ./public
RUN useradd --system --uid 10001 --create-home litenav \
    && mkdir -p /app/data \
    && chown -R litenav:litenav /app/data
USER litenav
EXPOSE 8765
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-c", "from urllib.request import urlopen; urlopen('http://127.0.0.1:8765/api/health', timeout=3).close()"]
CMD ["python", "server.py", "--host", "0.0.0.0", "--port", "8765", "--data-dir", "/app/data"]
