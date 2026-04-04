#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# vox-brief deployment script
#
# Usage:
#   ./deploy.sh [--profile <aws-profile>] [--region <aws-region>] [--password <demo-password>] [--waf]
#
# Requirements: aws-cli, docker (with buildx), jq
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PROFILE="default"
REGION="us-east-1"
DEMO_PASSWORD=""
ENABLE_WAF="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)   PROFILE="$2";       shift 2 ;;
    --region)    REGION="$2";        shift 2 ;;
    --password)  DEMO_PASSWORD="$2"; shift 2 ;;
    --waf)       ENABLE_WAF="true";  shift ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

AWS="aws --profile $PROFILE --region $REGION"

# ─────────────────────────────────────────────────────────────────────────────
# Phase 0 — Prerequisites
# ─────────────────────────────────────────────────────────────────────────────
echo "→ Checking prerequisites…"
for cmd in aws docker jq; do
  command -v "$cmd" &>/dev/null || { echo "✗ $cmd not found"; exit 1; }
done

ACCOUNT_ID=$($AWS sts get-caller-identity --query Account --output text)
echo "  Account: $ACCOUNT_ID  Region: $REGION  Profile: $PROFILE"

# ─────────────────────────────────────────────────────────────────────────────
# Phase 1 — Bootstrap ECR (idempotent)
# ─────────────────────────────────────────────────────────────────────────────
echo "→ Deploying bootstrap stack (ECR)…"
$AWS cloudformation deploy \
  --template-file infra/bootstrap.yaml \
  --stack-name vox-brief-bootstrap \
  --no-fail-on-empty-changeset

ECR_URI=$($AWS cloudformation describe-stacks \
  --stack-name vox-brief-bootstrap \
  --query "Stacks[0].Outputs[?OutputKey=='EcrUri'].OutputValue" \
  --output text)
echo "  ECR: $ECR_URI"

# ─────────────────────────────────────────────────────────────────────────────
# Phase 2 — Docker build and push (ARM64)
# ─────────────────────────────────────────────────────────────────────────────
echo "→ Logging in to ECR…"
$AWS ecr get-login-password | docker login \
  --username AWS \
  --password-stdin "$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"

IMAGE_URI="$ECR_URI:latest"
echo "→ Building ARM64 image (this may take a few minutes on x86)…"
docker buildx build \
  --platform linux/arm64 \
  --tag "$IMAGE_URI" \
  --push \
  ./agent

echo "  Pushed: $IMAGE_URI"

# ─────────────────────────────────────────────────────────────────────────────
# Phase 3 — Deploy main stack
# ─────────────────────────────────────────────────────────────────────────────
echo "→ Deploying main stack…"
DEPLOY_TS=$(date +%s)
DEMO_PASSWORD_B64=""
if [[ -n "$DEMO_PASSWORD" ]]; then
  DEMO_PASSWORD_B64=$(printf 'demo:%s' "$DEMO_PASSWORD" | base64 -w0)
  echo "  Basic Auth enabled (username: demo)"
fi
$AWS cloudformation deploy \
  --template-file infra/template.yaml \
  --stack-name vox-brief \
  --parameter-overrides "EcrImageUri=$IMAGE_URI" "DeployTimestamp=$DEPLOY_TS" "DemoPasswordB64=$DEMO_PASSWORD_B64" "EnableWAF=$ENABLE_WAF" \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset

OUTPUTS=$($AWS cloudformation describe-stacks \
  --stack-name vox-brief \
  --query "Stacks[0].Outputs" \
  --output json)

PRESIGN_URL=$(echo "$OUTPUTS" | jq -r '.[] | select(.OutputKey=="PresignApiUrl") | .OutputValue')
FRONTEND_BUCKET=$(echo "$OUTPUTS" | jq -r '.[] | select(.OutputKey=="FrontendBucketName") | .OutputValue')
FRONTEND_URL=$(echo "$OUTPUTS" | jq -r '.[] | select(.OutputKey=="FrontendUrl") | .OutputValue')
RUNTIME_ARN=$(echo "$OUTPUTS" | jq -r '.[] | select(.OutputKey=="RuntimeArn") | .OutputValue')

echo "  Presign API: $PRESIGN_URL"
echo "  Frontend bucket: $FRONTEND_BUCKET"
echo "  Runtime ARN: $RUNTIME_ARN"

# ─────────────────────────────────────────────────────────────────────────────
# Phase 4 — Write frontend config
# ─────────────────────────────────────────────────────────────────────────────
echo "→ Writing frontend/config.json…"
cat > frontend/config.json <<EOF
{
  "presignUrl": "$PRESIGN_URL",
  "demoToken": "$DEMO_PASSWORD_B64"
}
EOF

# ─────────────────────────────────────────────────────────────────────────────
# Phase 5 — Upload frontend to S3
# ─────────────────────────────────────────────────────────────────────────────
echo "→ Uploading frontend to S3…"
$AWS s3 sync ./frontend "s3://$FRONTEND_BUCKET" \
  --delete \
  --cache-control "no-store,no-cache,must-revalidate,max-age=0"

# ─────────────────────────────────────────────────────────────────────────────
# Done
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "✓ Deployment complete!"
echo ""
echo "  Frontend:  $FRONTEND_URL"
echo "  Presign:   $PRESIGN_URL"
echo "  Runtime:   $RUNTIME_ARN"
echo ""
echo "Note: CloudFront may take a few minutes to propagate globally."
