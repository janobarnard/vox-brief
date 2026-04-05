# vox-brief — Deployment Guide

## Prerequisites

- AWS CLI configured with a profile
- Docker with buildx support (Docker Desktop or similar)
- `jq` installed

## Deploy

```bash
git clone git@github.com:janobarnard/vox-brief.git
cd vox-brief

# Without WAF (basic auth only)
./deploy.sh --profile <your-aws-profile> --password <your-demo-password>

# With WAF (adds rate limiting + AWS managed rules, ~$7/month)
./deploy.sh --profile <your-aws-profile> --password <your-demo-password> --waf

# Without auth (open access — not recommended)
./deploy.sh --profile <your-aws-profile>
```

The script will:
1. Create an ECR repository (bootstrap stack, first run only)
2. Build and push an ARM64 Docker image
3. Deploy the main CloudFormation stack (AgentCore Runtime, API Gateway, S3, CloudFront, DynamoDB)
4. Write `frontend/config.json` with the presign API URL and auth token
5. Upload frontend assets to S3

The CloudFront URL is printed at the end.

### Login credentials

- **Username:** `demo`
- **Password:** whatever you passed via `--password`

### Cold start

The first call after a fresh deploy (or after a period of inactivity) takes 30-60 seconds while the container starts. Make a test call a couple of minutes before a live demo to warm it up.

## Tear down

CloudFormation cannot delete non-empty S3 buckets, so empty it first:

```bash
PROFILE=<your-aws-profile>

# 1. Empty the frontend bucket
aws --profile $PROFILE --region us-east-1 \
  s3 rm s3://vox-brief-frontend-$(aws --profile $PROFILE sts get-caller-identity --query Account --output text)-us-east-1 --recursive

# 2. Delete the main stack
aws --profile $PROFILE --region us-east-1 \
  cloudformation delete-stack --stack-name vox-brief

# 3. (Optional) Delete the bootstrap stack (ECR repo + images)
aws --profile $PROFILE --region us-east-1 \
  cloudformation delete-stack --stack-name vox-brief-bootstrap
```

## Docker note (Linux with Docker Desktop)

If Docker uses a non-default socket, set before running deploy.sh:

```bash
export DOCKER_HOST=unix://$HOME/.docker/desktop/docker.sock
```
