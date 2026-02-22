#!/bin/bash
# Cascata Phantom Extension Linker
# Monitors /cascata_extensions for new PostGIS/heavy extension binaries and symlinks them to PG /usr/local/lib/postgresql

EXT_DIR="/usr/local/lib/postgresql"
SHARE_DIR="/usr/local/share/postgresql/extension"
PAYLOAD_DIR="/cascata_extensions"

echo "[Cascata Phantom Linker] Starting dynamic extension monitor..."

# Initial link for anything already created
link_extensions() {
    # .so files
    if ls $PAYLOAD_DIR/*.so 1> /dev/null 2>&1; then
        for file in $PAYLOAD_DIR/*.so; do
            filename=$(basename "$file")
            if [ ! -e "$EXT_DIR/$filename" ]; then
                ln -sf "$file" "$EXT_DIR/$filename"
                echo "[Phantom Linker] Symlinked binary: $filename"
            fi
        done
    fi

    # .sql and .control files
    if ls $PAYLOAD_DIR/*.sql 1> /dev/null 2>&1 || ls $PAYLOAD_DIR/*.control 1> /dev/null 2>&1; then
        for file in $PAYLOAD_DIR/*.sql $PAYLOAD_DIR/*.control; do
            # Check if files exists after glob expansion
            if [ -f "$file" ]; then
                filename=$(basename "$file")
                if [ ! -e "$SHARE_DIR/$filename" ]; then
                    ln -sf "$file" "$SHARE_DIR/$filename"
                    echo "[Phantom Linker] Symlinked spec: $filename"
                fi
            fi
        done
    fi
}

# Run immediately
link_extensions

# Background loop to monitor
while true; do
    sleep 5
    link_extensions
done
