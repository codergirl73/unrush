#!/bin/bash
# Ship the latest main to the hosted demo: git pull, install, build, restart (over Session Manager).
set -euo pipefail
cd "$(dirname "$0")/.."
NAME="${UNRUSH_DEPLOY_NAME:-unrush-demo}"
export AWS_REGION="${AWS_REGION:-$(grep -E '^AWS_REGION=' .env | cut -d= -f2-)}" AWS_PAGER=""
INSTANCE=$(aws ec2 describe-instances --filters Name=tag:Name,Values="$NAME" Name=instance-state-name,Values=running --query 'Reservations[0].Instances[0].InstanceId' --output text)
[ "$INSTANCE" != "None" ] || { echo "No running $NAME instance." >&2; exit 1; }
CMD=$(aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript \
  --parameters 'commands=["set -e","cd /opt/unrush","sudo -u unrush -H git pull --ff-only","sudo -u unrush -H npm ci --no-audit --no-fund","sudo -u unrush -H npm run build","systemctl restart unrush-mcp unrush-web","sleep 5","systemctl is-active unrush-mcp unrush-web caddy"]' \
  --query Command.CommandId --output text)
echo "Updating $INSTANCE (command $CMD)…"
aws ssm wait command-executed --command-id "$CMD" --instance-id "$INSTANCE" || true
aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE" --query '[Status,StandardOutputContent,StandardErrorContent]' --output text | tail -20
