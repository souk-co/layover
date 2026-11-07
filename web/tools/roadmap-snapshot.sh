#!/bin/sh
# Writes web/static/roadmap.json: the Layover roadmap issues (those with an area:* label) for status.html, which cannot read the private repo.
set -eu
out="$(dirname "$0")/../static/roadmap.json"
gh api --paginate "repos/souk-co/layover-private/issues?state=all&per_page=100" --jq '.[] | select(.pull_request == null)' | jq -s --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{
  generated_at: $at, repo: "souk-co/layover-private",
  issues: [.[] | (.labels | map(.name)) as $l | select(any($l[]; startswith("area:"))) | {
    number, title, state, url: .html_url,
    areas: [$l[] | select(startswith("area:")) | ltrimstr("area:")],
    status: ([$l[] | select(startswith("status:")) | ltrimstr("status:")][0]),
    day: ([$l[] | select(startswith("day:")) | ltrimstr("day:")][0]),
    flags: [$l[] | select(startswith("cut:") or startswith("needs:"))]
  }] | sort_by(.number)
}' > "$out.tmp"
mv "$out.tmp" "$out"
echo "wrote $(jq '.issues | length' "$out") issues to $out"
