#!/bin/bash
# Keeps the round6 capture alive until all 8 poses exist. Safe to run repeatedly:
# exits if the set is complete, does nothing while a capture is already running,
# relaunches with --resume otherwise so a reaped run costs at most one pose.
cd /home/user/claude-of-duty
while true; do
  n=$(ls shots/round6/*.png 2>/dev/null | wc -l)
  if [ "$n" -ge 8 ]; then echo "$(date -u +%H:%M) complete ($n/8)"; exit 0; fi
  if ! pgrep -f "tools/shoot.mjs.*--tag r6" >/dev/null; then
    echo "$(date -u +%H:%M) relaunching at $n/8"
    nohup timeout 20000 node tools/shoot.mjs --quality medium --w 1280 --h 720 \
      --tag r6 --out shots/round6 --resume >> shots/round6.log 2>&1 &
  fi
  sleep 120
done
