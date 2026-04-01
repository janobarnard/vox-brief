# vox-brief

Speech-to-speech customer feedback agent powered by Amazon Nova Sonic, with post-call digest, transcript, and action items.

## What it does

1. **Initiate a call** — click *Talk with Agent* in the browser; Nova Sonic greets the customer and guides them through a structured feedback interview via voice
2. **Live conversation** — bidirectional voice: Nova Sonic speaks, the customer responds naturally; the agent follows a predefined interview flow (product feedback, pain points, NPS, etc.)
3. **Hang up** — end the call at any time
4. **Digest** — the page immediately shows a structured summary: full transcript, key takeaways, action items, danger items, and sentiment analysis

## Architecture

```
Browser (WebSocket) ──► FastAPI / AgentCore ──► Nova Sonic (bidirectional HTTP/2)
                                │
                                └──► Bedrock LLM (digest generation)
                                └──► DynamoDB (call records)
```

| Component | Technology |
|---|---|
| Voice conversation | Amazon Nova 2 Sonic (`amazon.nova-2-sonic-v1:0`) |
| Digest / analysis | Amazon Nova (via Bedrock) |
| Agent framework | Strands Agents SDK |
| Agent runtime | Amazon Bedrock AgentCore |
| Storage | DynamoDB on-demand |
| Frontend | Vanilla HTML/CSS/JS |
| IaC | AWS CloudFormation |

## Repo layout

```
vox-brief/
├── agent/
│   ├── app.py                 # BedrockAgentCore entrypoint
│   ├── local_server.py        # FastAPI dev server (WebSocket + REST)
│   ├── tools.py               # Strands tools
│   ├── requirements.txt       # Production dependencies
│   ├── requirements-local.txt # Local dev dependencies
│   └── .env.example
├── frontend/
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── bootstrap.yaml             # CFN: S3 bucket for deployment artifacts
├── template.yaml              # CFN: full stack (AgentCore, API GW, CloudFront, DDB)
├── cfn-dev.yaml               # CFN: local dev resources (DDB only)
└── deploy.sh
```

## Local dev

```bash
# 1. AWS SSO login
aws sso login --profile cloudvisor-sandbox

# 2. Deploy dev resources (DynamoDB)
aws cloudformation deploy \
  --template-file cfn-dev.yaml \
  --stack-name vox-brief-dev \
  --profile cloudvisor-sandbox

# 3. Python env
cd agent
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-local.txt

# 4. Configure
cp .env.example .env
# Edit .env with your values

# 5. Run
uvicorn local_server:app --reload --port 8000
```

Then open `frontend/index.html` in your browser (or serve it with `python -m http.server`).

## Deployment

```bash
# Bootstrap (first time only)
aws cloudformation deploy \
  --template-file bootstrap.yaml \
  --stack-name vox-brief-bootstrap \
  --profile cloudvisor-sandbox

# Deploy full stack
./deploy.sh cloudvisor-sandbox
```

## Cost

All services are pay-per-use with no idle cost.

| Service | Cost driver |
|---|---|
| Nova 2 Sonic | Per audio second |
| Bedrock LLM (digest) | Per token |
| DynamoDB | Per request (on-demand) |
| AgentCore | Per invocation |

Safe to leave deployed overnight — zero cost when idle.
