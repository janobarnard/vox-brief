# vox-brief

Voice-powered customer feedback agent with real-time conversation and AI-generated call digests.

## What it does

1. **Start a call** — click *Talk with Agent* in the browser; Alex greets the customer and guides them through a structured feedback interview via voice
2. **Live conversation** — bidirectional voice powered by Amazon Nova 2 Sonic; the customer responds naturally while a live transcript appears
3. **Hang up** — end the call at any time
4. **Digest** — a structured summary is generated instantly: call summary, key takeaways, action items, danger signals, and sentiment analysis

## Architecture

Fully serverless — zero cost when idle. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full service breakdown.

```
Browser (WebSocket) ──► FastAPI / AgentCore Runtime ──► Nova 2 Sonic (bidirectional voice)
                                    │
                                    └──► Nova Pro (digest generation)
```

| Component | Technology |
|---|---|
| Voice conversation | Amazon Nova 2 Sonic (`amazon.nova-2-sonic-v1:0`) |
| Digest / analysis | Amazon Nova Pro (`amazon.nova-pro-v1:0`) |
| Agent runtime | Amazon Bedrock AgentCore |
| Frontend | Vanilla HTML/CSS/JS via CloudFront |
| IaC | AWS CloudFormation |

## Repo layout

```
vox-brief/
├── agent/
│   ├── server.py            # FastAPI WebSocket server (runs in AgentCore)
│   ├── local_server.py      # Local dev server
│   ├── nova_sonic.py        # Nova 2 Sonic bidirectional stream client
│   ├── digest.py            # Post-call digest via Nova Pro
│   ├── prompt.py            # Interview system prompt
│   ├── Dockerfile
│   └── requirements.txt
├── frontend/
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── infra/
│   ├── bootstrap.yaml       # CFN: ECR repository (first-time setup)
│   └── template.yaml        # CFN: full stack (AgentCore, API GW, CloudFront, WAF, DDB)
├── deploy.sh                # One-command deploy script
├── ARCHITECTURE.md
└── DEPLOYMENT.md
```

## Quick start

```bash
./deploy.sh --profile <your-aws-profile> --password <demo-password>
```

See [DEPLOYMENT.md](DEPLOYMENT.md) for full instructions including WAF, tear down, and cold start notes.

## Local dev

```bash
cd agent
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-local.txt
cp .env.example .env   # edit with your values
uvicorn local_server:app --reload --port 8000
```

Then open `frontend/index.html` in your browser (or serve with `python -m http.server 3000 -d frontend`).

## Cost

All services are pay-per-use with no idle cost.

| Service | Cost driver |
|---|---|
| Nova 2 Sonic | Per audio second |
| Nova Pro (digest) | Per token |
| AgentCore Runtime | Per invocation |
| DynamoDB | Per request (on-demand) |
| WAF (optional) | ~$7/month flat + $0.60/M requests |

## License

[MIT](LICENSE)
