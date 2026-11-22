# HA SolarPayBack Add-on — Dockerfile
# No build.yaml (deprecated) and no published registry image, so we build directly
# from a fixed base image here. HA does not inject BUILD_FROM in this mode.
FROM alpine:3.20

# Install Python + packages (Alpine)
RUN apk add --no-cache \
        python3 \
        py3-pip \
    && pip3 install --no-cache-dir \
        fastapi==0.112.0 \
        uvicorn==0.30.0 \
        aiohttp==3.10.0 \
        aiofiles==23.2.0

# Copy application code
WORKDIR /app
COPY rootfs/app/ /app/

# Make entrypoint executable
RUN chmod a+x /app/run.sh

# Data directory (HA mounts /data)
RUN mkdir -p /data && chown -R root:root /data

# Health check (server listens on 8099 for ingress)
EXPOSE 8099
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD python3 -c "import urllib.request; urllib.request.urlopen('http://localhost:8099/health')" || exit 1

# Entrypoint
CMD [ "/app/run.sh" ]