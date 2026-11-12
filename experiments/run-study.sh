#!/usr/bin/env bash
# Empirical study driver (thesis Ch. 5): every subject x PWE-4/8/16 = 21 runs,
# then aggregation into the tables of Sec. 5.5.
#
# Usage: experiments/run-study.sh subjects/bludit.mlmt.json subjects/joomla.mlmt.json ...
# Each subject must be deployed (Docker, seeded DB) and its baseline must pass.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MLMT="node $HERE/../dist/src/cli.js"
PWE_LEVELS="${PWE_LEVELS:-4 8 16}"
WORKERS="${WORKERS:-4}"
OUT="${OUT:-$HERE/results}"
mkdir -p "$OUT"

reports=()
for cfg in "$@"; do
  name="$(basename "$cfg" .mlmt.json)"
  first=1
  for n in $PWE_LEVELS; do
    echo "=== $name PWE-$n ==="
    reuse=""
    [ "$first" = 0 ] && reuse="--reuse-trace"   # one trace per subject, shared by the 3 configurations
    $MLMT run -c "$cfg" --max-pwe "$n" --workers "$WORKERS" $reuse
    first=0
    outdir="$(node -e "const c=require('$(realpath "$cfg")');const p=require('path');console.log(p.resolve(p.dirname('$(realpath "$cfg")'),c.projectRoot||'.',c.outputDir||'.mlmt'))")"
    cp "$outdir/report-pwe$n.json" "$OUT/$name-pwe$n.json"
    reports+=("$OUT/$name-pwe$n.json")
  done
done
$MLMT aggregate "${reports[@]}" -o "$OUT/aggregate.md"
echo "aggregate written to $OUT/aggregate.md"
