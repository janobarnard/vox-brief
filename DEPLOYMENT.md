# vox-brief — Deployment Guide

## Prerequisites

- AWS CLI configured with a profile (e.g. `cloudvisor-sandbox`)
- Docker with buildx support (Docker Desktop or similar)
- `jq` installed
- Bedrock model access enabled for Nova Sonic and Nova Pro in the target region

## Deploy

```bash
# Without WAF (basic auth only)
./deploy.sh --profile cloudvisor-sandbox --password <your-demo-password>

# With WAF (adds rate limiting + AWS managed rules, ~$7/month)
./deploy.sh --profile cloudvisor-sandbox --password <your-demo-password> --waf

# Without auth (open access — not recommended)
./deploy.sh --profile cloudvisor-sandbox
```

The script will:
1. Create an ECR repository (bootstrap stack, first run only)
2. Build and push an ARM64 Docker image
3. Deploy the main CloudFormation stack (AgentCore Runtime, API Gateway, S3, CloudFront, DynamoDB)
4. Write `frontend/config.json` with the presign API URL and auth token
5. Upload frontend assets to S3

### Login credentials

- **Username:** `demo`
- **Password:** whatever you passed via `--password`

## Tear down

CloudFormation cannot delete non-empty S3 buckets, so empty it first:

```bash
AWS_PROFILE=cloudvisor-sandbox

# 1. Empty the frontend bucket
aws --profile $AWS_PROFILE --region us-east-1 \
  s3 rm s3://vox-brief-frontend-$(aws --profile $AWS_PROFILE sts get-caller-identity --query Account --output text)-us-east-1 --recursive

# 2. Delete the main stack
aws --profile $AWS_PROFILE --region us-east-1 \
  cloudformation delete-stack --stack-name vox-brief

# 3. (Optional) Delete the bootstrap stack (ECR repo + images)
aws --profile $AWS_PROFILE --region us-east-1 \
  cloudformation delete-stack --stack-name vox-brief-bootstrap
```

## Docker note (Linux with Docker Desktop)

If Docker uses a non-default socket, set before running deploy.sh:

```bash
export DOCKER_HOST=unix://$HOME/.docker/desktop/docker.sock
```
