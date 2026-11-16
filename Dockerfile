FROM python:3.14-slim
WORKDIR /app
COPY server.py seed.json ./
COPY public ./public
RUN useradd --system --uid 10001 --create-home guihang \
    && mkdir -p /app/data \
    && chown -R guihang:guihang /app/data
USER guihang
EXPOSE 8765
VOLUME ["/app/data"]
CMD ["python", "server.py", "--host", "0.0.0.0", "--port", "8765", "--data-dir", "/app/data"]
