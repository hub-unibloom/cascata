#!/bin/bash
# firewall-sync.sh - Synchronizes the Dragonfly blocklist with host ipset/iptables.
# This script should run in the background on the host or inside a container with NET_ADMIN.
# Required: ipset, iptables, redis-cli (or dragonfly-cli)

SET_NAME="cascata_blocklist"
DRAGONFLY_HOST=${DRAGONFLY_HOST:-"localhost"}
DRAGONFLY_PORT=${DRAGONFLY_PORT:-6379}
SYNC_INTERVAL=60

# Check dependencies
for cmd in ipset iptables redis-cli; do
    if ! command -v "$cmd" &> /dev/null; then
        echo "Error: $cmd is not installed."
        exit 1
    fi
done

# Initialize ipset if it doesn't exist
if ! ipset list "$SET_NAME" &> /dev/null; then
    echo "[Firewall] Creating ipset $SET_NAME..."
    ipset create "$SET_NAME" hash:ip timeout 3600
    # Add rule to iptables if not already present
    if ! iptables -C INPUT -m set --match-set "$SET_NAME" src -j DROP &> /dev/null; then
        echo "[Firewall] Adding iptables drop rule..."
        iptables -I INPUT -m set --match-set "$SET_NAME" src -j DROP
    fi
fi

echo "[Firewall] Starting blocklist sync from $DRAGONFLY_HOST:$DRAGONFLY_PORT every $SYNC_INTERVAL seconds..."

while true; do
    # Fetch all blocked IPs from Dragonfly
    # We use KEYS here because Dragonfly is optimized for it, but SCAN is safer for standard Redis.
    # The pattern matches the one used in RateLimitService.ts
    ips=$(redis-cli -h "$DRAGONFLY_HOST" -p "$DRAGONFLY_PORT" --raw KEYS "sys:firewall:blocklist:*" | sed 's/sys:firewall:blocklist://')

    if [ -n "$ips" ]; then
        for ip in $ips; do
            # Add to ipset (if already exists, timeout is refreshed)
            ipset add "$SET_NAME" "$ip" -exist &> /dev/null
        done
        count=$(echo "$ips" | wc -l)
        echo "[Firewall] Synced $count IPs to $SET_NAME"
    fi

    sleep "$SYNC_INTERVAL"
done
