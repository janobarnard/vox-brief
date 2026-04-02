"""
Production server for vox-brief — runs inside AgentCore Runtime container.

Differences from local_server.py:
  - No dotenv loading
  - No static file serving (frontend lives on S3/CloudFront)
  - WebSocket path: /ws  (AgentCore routes wss://.../ws to container /ws)
  - Health check: POST /invocations  (AgentCore platform contract)
  - Port 8080 (set in Dockerfile CMD)
"""

import asyncio
import json
import logging
import os

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from digest import generate_digest
from nova_sonic import NovaSonicSession

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

app = FastAPI(title="vox-brief")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/ping")
async def ping():
    return {"status": "ok"}


@app.post("/invocations")
async def invocations():
    """AgentCore Runtime health check endpoint."""
    return JSONResponse({"status": "ok"})


@app.websocket("/ws")
async def call_ws(ws: WebSocket):
    await ws.accept()
    log.info("WebSocket connected")

    transcript = []
    done_event = asyncio.Event()

    async def send(msg: dict):
        try:
            await ws.send_text(json.dumps(msg))
        except Exception:
            pass

    async def on_audio(audio_b64: str):
        await send({"type": "audio", "data": audio_b64})

    async def on_transcript(role: str, text: str):
        log.info("[transcript] %s: %s", role, text[:80])
        transcript.append({"role": role, "text": text})
        await send({"type": "transcript", "role": role, "text": text})

    async def on_done():
        log.info("Nova Sonic session done")
        if transcript:
            try:
                await send({"type": "status", "state": "processing"})
                digest = await asyncio.to_thread(generate_digest, transcript)
                await send({"type": "digest", "data": digest})
            except Exception as exc:
                log.exception("Digest generation failed: %s", exc)
                await send({"type": "error", "message": f"Digest failed: {exc}"})
                await send({"type": "status", "state": "done"})
        else:
            await send({"type": "status", "state": "done"})
        done_event.set()

    async def on_error(message: str):
        log.error("Nova Sonic error: %s", message)
        await send({"type": "error", "message": message})

    session = NovaSonicSession(
        on_audio=on_audio,
        on_transcript=on_transcript,
        on_done=on_done,
        on_error=on_error,
    )

    try:
        await send({"type": "status", "state": "connecting"})
        await session.start()
        await send({"type": "status", "state": "live"})

        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)

            if msg.get("type") == "audio":
                await session.send_audio(msg["data"])

            elif msg.get("type") == "hangup":
                log.info("Hangup received")
                await session.close()
                await done_event.wait()
                break

    except WebSocketDisconnect:
        log.info("WebSocket disconnected")
        await session.close()
    except Exception as exc:
        log.exception("Unexpected error: %s", exc)
        await send({"type": "error", "message": str(exc)})
        await session.close()
