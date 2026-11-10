#!/bin/bash
# extract each video once its GT is ready; 2 workers
cd "$(dirname "$0")"
todo() { for i in $(seq -w 1 44); do v=v$i; [ -f data/$v.npz ] || [ -e data/$v.lock ] || { [ -f gt/$v.json ] && [ -s gt/$v.log ] && echo $v; }; done; }
worker() {
  while true; do
    v=$(todo | head -1)
    if [ -z "$v" ]; then
      n=$(ls gt/*.log 2>/dev/null | xargs -n1 sh -c 'test -s $0 && echo x' | wc -l)
      [ "$n" -ge 44 ] && [ -z "$(todo)" ] && exit 0
      sleep 20; continue
    fi
    mkdir data/$v.lock 2>/dev/null || continue
    python3 extract.py $v >> data/extract.log 2>&1
    rmdir data/$v.lock
  done
}
mkdir -p data
worker & sleep 3; worker & wait
