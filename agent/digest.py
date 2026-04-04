"""
Post-call digest generator.

Takes the full conversation transcript and calls Nova Pro via Bedrock
to produce a structured JSON digest: summary, takeaways, action items,
danger items, and sentiment.
"""

import json
import logging
import os

import boto3

log = logging.getLogger(__name__)

MODEL_ID = "amazon.nova-pro-v1:0"

DIGEST_PROMPT = """
You are a customer insights analyst. You have just received a transcript of a
structured product feedback interview. Your job is to produce a concise,
actionable digest for the product team.

Return ONLY valid JSON — no markdown, no explanation, no code fences.

The JSON must match this exact schema:
{
  "summary": "<2-3 sentence plain-English summary of the interview>",
  "nps_score": <integer 0-10, or null if the customer did not give a score>,
  "sentiment": "positive" | "neutral" | "negative",
  "highlights": ["<what they liked>", ...],
  "pain_points": ["<what frustrated them or is missing>", ...],
  "action_items": ["<concrete thing the product team should consider doing>", ...],
  "danger_items": ["<urgent issue, churn risk, or strong negative signal>", ...]
}

Rules:
- ONLY include information that was EXPLICITLY stated in the transcript. NEVER invent, infer, or fabricate details that the customer did not actually say.
- If the interview was cut short or barely started, reflect that honestly — use empty lists and a summary like "The interview ended before substantive feedback was gathered."
- Each list item is a single concise sentence
- highlights and pain_points: 0-5 items each (0 if no evidence in transcript)
- action_items: 0-4 items (0 if no evidence in transcript)
- danger_items: 0-3 items (only include real red flags — leave the list empty if none)
- sentiment: overall emotional tone of the customer across the whole interview; use "neutral" if the call was too short to determine
- nps_score: extract the number the customer stated; null if they declined, were unclear, or were not asked
""".strip()


def _bedrock_client():
    session = boto3.Session()
    return session.client(
        "bedrock-runtime",
        region_name=os.environ.get("AWS_DEFAULT_REGION", "us-east-1"),
    )


def _format_transcript(turns: list[dict]) -> str:
    lines = []
    for t in turns:
        role = "Alex (interviewer)" if t["role"] == "agent" else "Customer"
        lines.append(f"{role}: {t['text']}")
    return "\n".join(lines)


def generate_digest(transcript: list[dict]) -> dict:
    """
    transcript: list of {"role": "agent"|"user", "text": "..."}
    Returns the parsed digest dict.
    """
    formatted = _format_transcript(transcript)
    if not formatted.strip():
        raise ValueError("Empty transcript — cannot generate digest")

    client = _bedrock_client()
    log.info("[digest] calling Nova Pro, transcript turns=%d", len(transcript))

    response = client.invoke_model(
        modelId=MODEL_ID,
        contentType="application/json",
        accept="application/json",
        body=json.dumps({
            "system": [{"text": DIGEST_PROMPT}],
            "messages": [
                {"role": "user", "content": [{"text": f"Here is the interview transcript:\n\n{formatted}"}]}
            ],
            "inferenceConfig": {
                "maxTokens": 1024,
                "temperature": 0.1,
                "topP": 0.9,
            },
        }),
    )

    body = json.loads(response["body"].read())
    raw = body["output"]["message"]["content"][0]["text"].strip()
    log.info("[digest] raw response: %r", raw[:200])

    digest = json.loads(raw)
    log.info("[digest] parsed successfully")
    return digest
