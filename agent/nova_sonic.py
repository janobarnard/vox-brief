"""
Nova 2 Sonic bidirectional stream handler for vox-brief.

Protocol (matches working shopping list app field names):
  - Events use contentStart/contentName/contentEnd  (NOT contentBlock*)
  - System content: interactive=False, textInputConfiguration
  - Audio content:  interactive=True,  audioInputConfiguration
  - Receiver task starts before setup events are sent
  - Greeting trigger text fires Nova Sonic's opening speech
  - Audio block stays open until close() is called
"""

import asyncio
import json
import logging
import os
import uuid

import boto3
from aws_sdk_bedrock_runtime.client import (
    BedrockRuntimeClient,
    InvokeModelWithBidirectionalStreamOperationInput,
)
from aws_sdk_bedrock_runtime.config import Config, HTTPAuthSchemeResolver, SigV4AuthScheme
from aws_sdk_bedrock_runtime.models import (
    BidirectionalInputPayloadPart,
    InvokeModelWithBidirectionalStreamInputChunk,
    ValidationException,
)
from smithy_aws_core.identity.static import StaticCredentialsResolver
from smithy_core.shapes import ShapeID

from prompt import INTERVIEW_SYSTEM_PROMPT

log = logging.getLogger(__name__)

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
MODEL_ID = "amazon.nova-2-sonic-v1:0"
SAMPLE_RATE = 16000


def _make_client() -> BedrockRuntimeClient:
    creds = boto3.Session().get_credentials().get_frozen_credentials()
    resolver = StaticCredentialsResolver()
    config = Config(
        endpoint_uri=f"https://bedrock-runtime.{REGION}.amazonaws.com",
        region=REGION,
        aws_credentials_identity_resolver=resolver,
        auth_scheme_resolver=HTTPAuthSchemeResolver(),
        auth_schemes={ShapeID("aws.auth#sigv4"): SigV4AuthScheme(service="bedrock")},
        aws_access_key_id=creds.access_key,
        aws_secret_access_key=creds.secret_key,
        aws_session_token=creds.token,
    )
    return BedrockRuntimeClient(config=config)


class NovaSonicSession:
    def __init__(self, on_audio, on_transcript, on_done, on_error, system_prompt=None):
        self.on_audio = on_audio
        self.on_transcript = on_transcript
        self.on_done = on_done
        self.on_error = on_error
        self._system_prompt = system_prompt or INTERVIEW_SYSTEM_PROMPT

        self._client = _make_client()
        self._stream = None
        self._prompt_name = str(uuid.uuid4())
        self._audio_name = str(uuid.uuid4())
        self._closed = False
        self._audio_block_open = False
        self._send_queue: asyncio.Queue = asyncio.Queue()
        self._seen_transcripts: set = set()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def start(self):
        self._stream = await self._client.invoke_model_with_bidirectional_stream(
            InvokeModelWithBidirectionalStreamOperationInput(model_id=MODEL_ID)
        )

        # Start receiver FIRST (same pattern as working shopping list app)
        asyncio.create_task(self._receiver())
        asyncio.create_task(self._sender())

        await self._send_session_start()
        await self._send_prompt_start()
        await self._send_system_prompt()
        await self._send_greeting_trigger()
        # Open the interactive audio block — stays open until close()
        await self._send_audio_start()
        self._audio_block_open = True

    async def send_audio(self, audio_b64: str):
        if not self._closed:
            await self._send_queue.put(("audio", audio_b64))

    async def close(self):
        if not self._closed:
            self._closed = True
            await self._send_queue.put(("close", None))

    # ------------------------------------------------------------------
    # Sender task
    # ------------------------------------------------------------------

    async def _sender(self):
        try:
            while True:
                kind, data = await self._send_queue.get()
                if kind == "audio":
                    await self._send_audio_chunk(data)
                elif kind == "close":
                    if self._audio_block_open:
                        await self._send_audio_end()
                    await self._send_prompt_end()
                    await self._send_connection_end()
                    break
        except Exception as exc:
            log.exception("sender error: %s", exc)
            await self.on_error(str(exc))

    # ------------------------------------------------------------------
    # Receiver task
    # ------------------------------------------------------------------

    async def _receiver(self):
        role = None
        try:
            log.info("[rx] waiting for output...")
            _, output = await self._stream.await_output()
            log.info("[rx] stream open")
            while True:
                result = await output.receive()
                if result is None or not result.value or not result.value.bytes_:
                    continue
                ev = json.loads(result.value.bytes_.decode()).get("event", {})
                log.info("[rx] event: %s", list(ev.keys()))

                if "contentStart" in ev:
                    role = ev["contentStart"].get("role")

                elif "audioOutput" in ev:
                    b64 = ev["audioOutput"].get("content", "")
                    if b64:
                        await self.on_audio(b64)

                elif "textOutput" in ev:
                    text = ev["textOutput"].get("content", "").strip()
                    if text and not text.startswith("{"):
                        mapped = "agent" if role == "ASSISTANT" else "user"
                        key = (mapped, text)
                        if key in self._seen_transcripts:
                            log.info("[rx] duplicate suppressed: %r", text[:60])
                            continue
                        self._seen_transcripts.add(key)
                        log.info("[rx] transcript %s: %r", mapped, text[:80])
                        await self.on_transcript(mapped, text)

                elif "completionEnd" in ev:
                    log.info("[rx] completionEnd — turn finished")

        except StopAsyncIteration:
            log.info("[rx] stream closed (StopAsyncIteration)")
        except ValidationException as exc:
            log.warning("[rx] ValidationException: %s", exc)
            if "No events to transform were found" not in str(exc):
                await self.on_error(str(exc))
        except Exception as exc:
            log.exception("[rx] error: %s", exc)
            await self.on_error(str(exc))
        finally:
            log.info("[rx] done")
            await self.on_done()

    # ------------------------------------------------------------------
    # Low-level send helpers  (field names match working shopping list app)
    # ------------------------------------------------------------------

    async def _send(self, payload: dict):
        await self._stream.input_stream.send(
            InvokeModelWithBidirectionalStreamInputChunk(
                value=BidirectionalInputPayloadPart(
                    bytes_=json.dumps(payload).encode()
                )
            )
        )

    async def _send_session_start(self):
        await self._send({"event": {"sessionStart": {
            "inferenceConfiguration": {
                "maxTokens": 1024,
                "topP": 0.9,
                "temperature": 0.7,
            }
        }}})

    async def _send_prompt_start(self):
        await self._send({"event": {"promptStart": {
            "promptName": self._prompt_name,
            "textOutputConfiguration": {"mediaType": "text/plain"},
            "audioOutputConfiguration": {
                "mediaType": "audio/lpcm",
                "sampleRateHertz": SAMPLE_RATE,
                "sampleSizeBits": 16,
                "channelCount": 1,
                "voiceId": "matthew",
                "encoding": "base64",
                "audioType": "SPEECH",
            },
        }}})

    async def _send_system_prompt(self):
        name = str(uuid.uuid4())
        await self._send({"event": {"contentStart": {
            "promptName": self._prompt_name,
            "contentName": name,
            "type": "TEXT",
            "interactive": False,
            "role": "SYSTEM",
            "textInputConfiguration": {"mediaType": "text/plain"},
        }}})
        await self._send({"event": {"textInput": {
            "promptName": self._prompt_name,
            "contentName": name,
            "content": self._system_prompt,
        }}})
        await self._send({"event": {"contentEnd": {
            "promptName": self._prompt_name,
            "contentName": name,
        }}})

    async def _send_greeting_trigger(self):
        name = str(uuid.uuid4())
        await self._send({"event": {"contentStart": {
            "promptName": self._prompt_name,
            "contentName": name,
            "type": "TEXT",
            "interactive": False,
            "role": "USER",
            "textInputConfiguration": {"mediaType": "text/plain"},
        }}})
        await self._send({"event": {"textInput": {
            "promptName": self._prompt_name,
            "contentName": name,
            "content": "Hello",
        }}})
        await self._send({"event": {"contentEnd": {
            "promptName": self._prompt_name,
            "contentName": name,
        }}})

    async def _send_audio_start(self):
        await self._send({"event": {"contentStart": {
            "promptName": self._prompt_name,
            "contentName": self._audio_name,
            "type": "AUDIO",
            "interactive": True,
            "role": "USER",
            "audioInputConfiguration": {
                "mediaType": "audio/lpcm",
                "sampleRateHertz": SAMPLE_RATE,
                "sampleSizeBits": 16,
                "channelCount": 1,
                "audioType": "SPEECH",
                "encoding": "base64",
            },
        }}})

    async def _send_audio_chunk(self, audio_b64: str):
        await self._send({"event": {"audioInput": {
            "promptName": self._prompt_name,
            "contentName": self._audio_name,
            "content": audio_b64,
        }}})

    async def _send_audio_end(self):
        await self._send({"event": {"contentEnd": {
            "promptName": self._prompt_name,
            "contentName": self._audio_name,
        }}})

    async def _send_prompt_end(self):
        await self._send({"event": {"promptEnd": {
            "promptName": self._prompt_name,
        }}})

    async def _send_connection_end(self):
        await self._send({"event": {"connectionEnd": {}}})
