#!/usr/bin/env bash
# Undoes scripts/cutover.sh's stop: starts Docket on the VPS again, as it was. Changes made on Workers since stay there.
set -euo pipefail
ssh vps "cd /opt/apps/docket && docker compose start docket && docker compose ps docket"
echo "The VPS's Docket runs again. Point clients back to it."
