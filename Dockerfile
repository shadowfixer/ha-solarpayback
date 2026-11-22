# HA SolarPayBack Add-on — Dockerfile
# Alpine 3.20 + Python 3.11 + uvicorn + fastapi

FROM alpine:3.20

# Install Python and dependencies
RUN apk add --no-cache \
    python3=~3.11 \
    py3-pip \
    && python3 -m ensurepip --upgrade \
    && pip3 install --no-cache-dir --upgrade pip

# Install Python packages
RUN pip3 install --no-cache-dir \
    fastapi==0.112.0 \
    uvicorn[standard]==0.30.0 \
    aiohttp==3.10.0 \
    aiofiles==23.2.0

# Create app directory
WORKDIR /app

# Copy application code
COPY rootfs/app/ /app/

# Create non-root user (UID 1000 matches HA default)
RUN adduser -D -u 1000 -h /app appuser \
    && chown -R appuser:appuser /app

# Data directory (mounted by HA at /data)
RUN mkdir -p /data && chown appuser:appuser /data

# Switch to non-root
USER appuser

# Expose ingress port
EXPOSE 8099

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD python3 -c "import urllib.request; urllib.request.urlopen('http://localhost:8099/health')" || exit 1

# Entrypoint
ENTRYPOINT ["/app/run.sh"]