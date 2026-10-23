#!/bin/bash
# Delete everything deploy.sh created: the instance, its public IP, security group and IAM role.
set -euo pipefail
cd "$(dirname "$0")/.."
NAME="${UNRUSH_DEPLOY_NAME:-unrush-demo}"
export AWS_REGION="${AWS_REGION:-$(grep -E '^AWS_REGION=' .env | cut -d= -f2-)}" AWS_PAGER=""
ROLE="$NAME-ec2"

INSTANCE=$(aws ec2 describe-instances --filters Name=tag:Name,Values="$NAME" Name=instance-state-name,Values=pending,running,shutting-down,stopping,stopped --query 'Reservations[0].Instances[0].InstanceId' --output text)
if [ "$INSTANCE" != "None" ]; then
  aws ec2 terminate-instances --instance-ids "$INSTANCE" >/dev/null
  echo "Terminating ${INSTANCE}…"
  aws ec2 wait instance-terminated --instance-ids "$INSTANCE"
fi
ALLOC=$(aws ec2 describe-addresses --filters Name=tag:Name,Values="$NAME" --query 'Addresses[0].AllocationId' --output text)
[ "$ALLOC" != "None" ] && aws ec2 release-address --allocation-id "$ALLOC" && echo "Released the public IP."
SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values="$NAME-web" --query 'SecurityGroups[0].GroupId' --output text)
[ "$SG" != "None" ] && aws ec2 delete-security-group --group-id "$SG" && echo "Deleted security group $SG."
if aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam remove-role-from-instance-profile --instance-profile-name "$ROLE" --role-name "$ROLE" || true
  aws iam delete-instance-profile --instance-profile-name "$ROLE" || true
  aws iam delete-role-policy --role-name "$ROLE" --policy-name unrush-app || true
  aws iam detach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore || true
  aws iam delete-role --role-name "$ROLE"
  echo "Deleted IAM role $ROLE."
fi
echo "Done. Nothing from the Unrush demo is left running."
