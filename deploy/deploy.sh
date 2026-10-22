#!/bin/bash
# Create the hosted Unrush demo in your AWS account: one t4g.micro running the MCP
# server, the web backend and Caddy (automatic HTTPS on an sslip.io hostname).
#
#   ./deploy/deploy.sh            # reads AWS_REGION, BEDROCK_MODEL_ID, AGENTCORE_MEMORY_ID from .env
#   ./deploy/update.sh            # pull the latest main onto the instance and restart
#   ./deploy/teardown.sh          # delete everything this script created
#
# The instance gets AWS access from an IAM role (no keys), allowing only Converse with
# the configured model and the four AgentCore Memory calls. No SSH: ports 80/443 only;
# use Session Manager for a shell. Costs about $10/month (instance, public IPv4, 8 GB disk)
# plus Bedrock usage.
set -euo pipefail
cd "$(dirname "$0")/.."

NAME="${UNRUSH_DEPLOY_NAME:-unrush-demo}"
REPO="${UNRUSH_REPO:-https://github.com/codergirl73/unrush.git}"
TYPE="${UNRUSH_INSTANCE_TYPE:-t4g.micro}"
env_value() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- | tr -d '"'; }
REGION="${AWS_REGION:-$(env_value AWS_REGION)}"
MODEL_ID="${BEDROCK_MODEL_ID:-$(env_value BEDROCK_MODEL_ID)}"
MEMORY_ID="${AGENTCORE_MEMORY_ID:-$(env_value AGENTCORE_MEMORY_ID)}"
[ -n "$REGION" ] && [ -n "$MODEL_ID" ] || { echo "Set AWS_REGION and BEDROCK_MODEL_ID (in .env or the environment)." >&2; exit 1; }
FOUNDATION_MODEL="${MODEL_ID#*.}"   # us.amazon.nova-2-lite-v1:0 -> amazon.nova-2-lite-v1:0
export AWS_REGION="$REGION" AWS_PAGER=""
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
echo "Account $ACCOUNT · region $REGION · model $MODEL_ID · memory ${MEMORY_ID:-(none)}"

# ---------- IAM role for the instance ----------
ROLE="$NAME-ec2"
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" --description "Unrush demo instance: Bedrock Converse + AgentCore Memory" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
  aws iam create-instance-profile --instance-profile-name "$ROLE" >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name "$ROLE" --role-name "$ROLE"
  NEW_ROLE=1
fi
POLICY=$(sed -e "s|__ACCOUNT__|$ACCOUNT|g; s|__REGION__|$REGION|g; s|__MODEL_ID__|$MODEL_ID|g; s|__FOUNDATION_MODEL__|$FOUNDATION_MODEL|g; s|__MEMORY_ID__|${MEMORY_ID:-none}|g" deploy/iam-policy.json)
aws iam put-role-policy --role-name "$ROLE" --policy-name unrush-app --policy-document "$POLICY"
[ -n "${NEW_ROLE:-}" ] && { echo "Waiting for the new IAM role to propagate…"; sleep 15; }

# ---------- network ----------
VPC=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values="$NAME-web" Name=vpc-id,Values="$VPC" --query 'SecurityGroups[0].GroupId' --output text)
if [ "$SG" = "None" ]; then
  SG=$(aws ec2 create-security-group --group-name "$NAME-web" --description "Unrush demo: HTTP and HTTPS only" --vpc-id "$VPC" --query GroupId --output text)
  aws ec2 authorize-security-group-ingress --group-id "$SG" --ip-permissions \
    'IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0}],Ipv6Ranges=[{CidrIpv6=::/0}]' \
    'IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0}],Ipv6Ranges=[{CidrIpv6=::/0}]' >/dev/null
fi

# A fixed public IP, so the HTTPS hostname (<ip>.sslip.io) survives stop/start.
ALLOC=$(aws ec2 describe-addresses --filters Name=tag:Name,Values="$NAME" --query 'Addresses[0].AllocationId' --output text)
if [ "$ALLOC" = "None" ]; then
  ALLOC=$(aws ec2 allocate-address --domain vpc --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$NAME}]" --query AllocationId --output text)
fi
IP=$(aws ec2 describe-addresses --allocation-ids "$ALLOC" --query 'Addresses[0].PublicIp' --output text)
DOMAIN="${IP//./-}.sslip.io"

# ---------- instance ----------
EXISTING=$(aws ec2 describe-instances --filters Name=tag:Name,Values="$NAME" Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[0].Instances[0].InstanceId' --output text)
if [ "$EXISTING" != "None" ]; then
  echo "Instance $EXISTING already exists. Use deploy/update.sh to ship new code, or deploy/teardown.sh first."
  INSTANCE="$EXISTING"
else
  AMI=$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 --query Parameter.Value --output text)
  USER_DATA=$(mktemp)
  sed -e "s|__DOMAIN__|$DOMAIN|g; s|__REPO__|$REPO|g; s|__REGION__|$REGION|g; s|__MODEL_ID__|$MODEL_ID|g; s|__MEMORY_ID__|$MEMORY_ID|g" deploy/bootstrap.sh > "$USER_DATA"
  INSTANCE=$(aws ec2 run-instances --image-id "$AMI" --instance-type "$TYPE" \
    --iam-instance-profile Name="$ROLE" --security-group-ids "$SG" \
    --metadata-options HttpTokens=required,HttpEndpoint=enabled \
    --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=8,VolumeType=gp3,Encrypted=true}' \
    --user-data "file://$USER_DATA" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" "ResourceType=volume,Tags=[{Key=Name,Value=$NAME}]" \
    --query 'Instances[0].InstanceId' --output text)
  rm -f "$USER_DATA"
  echo "Launched $INSTANCE; waiting for it to run…"
  aws ec2 wait instance-running --instance-ids "$INSTANCE"
  aws ec2 associate-address --instance-id "$INSTANCE" --allocation-id "$ALLOC" >/dev/null
fi

URL="https://$DOMAIN"
echo "Installing (Node, build, HTTPS certificate). This takes about 5-8 minutes…"
for _ in $(seq 1 60); do
  if curl -fsS --max-time 5 "$URL/api/status" >/dev/null 2>&1; then
    echo "✓ Unrush is live: $URL"
    exit 0
  fi
  sleep 15
done
echo "Not answering yet at $URL. Check progress with:"
echo "  aws ssm start-session --target $INSTANCE   then   sudo tail -f /var/log/cloud-init-output.log"
exit 1
