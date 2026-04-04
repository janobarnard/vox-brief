# vox-brief — Architecture

Fully serverless architecture on AWS. No EC2 instances, no ECS clusters, no persistent servers to manage.

## AWS Services

### Voice & AI
- **Amazon Nova Sonic** (Bedrock) — real-time bidirectional voice streaming for the interview agent
- **Amazon Nova Pro** (Bedrock) — generates the post-call digest (summary, takeaways, action items)

### Compute & Runtime
- **Amazon Bedrock AgentCore Runtime** — hosts the agent container (FastAPI + WebSocket server) with managed scaling, SigV4 auth, and WebSocket proxy

### API & Networking
- **Amazon API Gateway** (HTTP API) — single POST /presign endpoint that generates SigV4 presigned WebSocket URLs for the frontend
- **AWS Lambda** (Python 3.12) — presign URL generator, inline in CloudFormation

### Frontend & CDN
- **Amazon S3** — hosts static frontend assets (HTML, JS, CSS)
- **Amazon CloudFront** — HTTPS CDN with Origin Access Control, serves the frontend globally
- **CloudFront Functions** — HTTP Basic Auth for demo access control

### Storage
- **Amazon DynamoDB** — call records table (provisioned for future use)

### Container & Deployment
- **Amazon ECR** — stores the agent Docker image (ARM64)
- **AWS CloudFormation** — all infrastructure defined as IaC (two stacks: bootstrap + main)

### Security
- **AWS IAM** — roles for AgentCore Runtime and presign Lambda
- **SigV4 presigned URLs** — secures WebSocket connections to AgentCore
