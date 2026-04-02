# AgentCore Runtime requires ARM64 containers.
# Build with: docker buildx build --platform linux/arm64 -t <tag> .
FROM python:3.12-slim

WORKDIR /app

# uv is required to install aws-sdk-bedrock-runtime (not on PyPI)
RUN pip install --no-cache-dir uv

COPY requirements.txt .
RUN uv pip install --system --no-cache -r requirements.txt

COPY server.py nova_sonic.py prompt.py digest.py ./

EXPOSE 8080
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080"]
