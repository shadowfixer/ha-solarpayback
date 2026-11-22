# HA SolarPayBack Add-on — Dockerfile (standard HA add-on pattern)
# The Supervisor injects BUILD_FROM via --build-arg (a valid per-arch base image).
# Do NOT put {arch} in a default here — {arch} is only substituted by HA into the build-arg.
ARG BUILD_FROM
FROM $BUILD_FROM

# Install Python packages on the HA base image (Alpine, has python3 + pip)
RUN \
    pip3 install --no-cache-dir \
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