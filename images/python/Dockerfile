# Versum standard Python image — what every kind=python job runs in (stage 2f, 2026-10-25).
# Published as ghcr.io/sudzikcoin/versum-python:3.12 by .github/workflows/python-image.yml; the hub pins the
# DIGEST (marketplace_config.python_image = ghcr.io/sudzikcoin/versum-python@sha256:…), never the tag.
# Small on purpose: the node pulls it once per machine; a job sees /job/in (inputs) and writes /job/out.
FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN pip install --no-cache-dir \
      numpy==2.1.3 \
      pandas==2.2.3 \
      pillow==11.0.0 \
      requests==2.32.3 \
    && python -c "import numpy, pandas, PIL, requests; print(numpy.__version__, pandas.__version__, PIL.__version__, requests.__version__)" \
    && rm -rf /root/.cache
# the node runs the container with its own uid; /job is the only mount, nothing here is writable but /tmp
WORKDIR /job
LABEL org.opencontainers.image.source="https://github.com/sudzikcoin/versum-node" \
      org.opencontainers.image.description="Versum standard Python 3.12 image: numpy, pandas, pillow, requests" \
      org.opencontainers.image.licenses="Apache-2.0"
CMD ["python", "-c", "print('versum-python ready')"]
