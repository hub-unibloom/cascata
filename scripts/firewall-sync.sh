#!/bin/bash

# Cascata Edge Defense - OS Firewall Sync
# This script pulls the 'sys:firewall:blocklist' from Dragonfly and applies it via ipset/iptables.
# Run this on the HOST machine (not inside container) or in a container with NET_ADMIN.

DRAGONFLY_HOST=${DRAGONFLY_HOST:-"localhost"}
DRAGONFLY_PORT=${DRAGONFLY_PORT:-6379}
IPSET_NAME="cascata_blocklist"

# 1. Ensure ipset exists
ipset list $IPSET_NAME > /dev/null 2>&1
if [ $? -ne 0 ]; then
    echo "[Firewall] Creating ipset '$IPSET_NAME'..."
    ipset create $IPSET_NAME hash:ip
    iptables -I INPUT -m set --match-set $IPSET_NAME src -j DROP
fi

# 2. Sync loop
echo "[Firewall] Starting sync loop..."
while true; do
    # Pull current blocklist from Dragonfly
    IPS=$(redis-cli -h $DRAGONFLY_HOST -p $DRAGONFLY_PORT SMEMBERS sys:firewall:blocklist)
    
    # Flush and rebuild or incrementally add? 
    # For performance and simplicity in small lists, we incrementally add.
    for IP in $IPS; do
        ipset add $IPSET_NAME $IP -exist
    done
    
    sleep 60
done
