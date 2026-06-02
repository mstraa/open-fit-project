#!/usr/bin/env bash
#
# Sync the project version across the Cargo workspace, web, mobile, and Android,
# then (optionally) commit + tag so .github/workflows/release.yml publishes it.
#
#   scripts/bump-version.sh 0.3.0            # rewrite the version in all manifests
#   scripts/bump-version.sh 0.3.0 --tag      # …then commit + create tag v0.3.0
#
# Files touched:
#   Cargo.toml                        [workspace.package] version (all crates inherit)
#   web/package.json                  "version"
#   mobile/package.json               "version"
#   mobile/android/app/build.gradle   versionName + versionCode (auto-incremented)
#
set -euo pipefail

usage() { echo "usage: $0 X.Y.Z [--tag]" >&2; exit 1; }

VERSION="${1:-}"
[ -n "$VERSION" ] || usage
echo "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "error: version must be X.Y.Z" >&2; exit 1; }
TAG_IT="${2:-}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Cargo workspace: only the version line inside the [workspace.package] table
# ([^\[]*? keeps the match from crossing into [workspace.dependencies]).
perl -0pi -e 's/(\[workspace\.package\][^\[]*?\bversion\s*=\s*")[^"]*(")/${1}'"$VERSION"'${2}/s' Cargo.toml

# web + mobile package.json: the top-level "version" key (first occurrence).
for pkg in web/package.json mobile/package.json; do
  perl -0pi -e 's/("version"\s*:\s*")[^"]*(")/${1}'"$VERSION"'${2}/' "$pkg"
done

# Android: versionName = X.Y.Z and versionCode = previous + 1 (must increase).
GRADLE=mobile/android/app/build.gradle
perl -pi -e 's/(versionName\s+")[^"]*(")/${1}'"$VERSION"'${2}/' "$GRADLE"
CURRENT_CODE="$(grep -Eo 'versionCode[[:space:]]+[0-9]+' "$GRADLE" | grep -Eo '[0-9]+' || true)"
[ -n "$CURRENT_CODE" ] || { echo "error: could not read versionCode from $GRADLE" >&2; exit 1; }
NEXT_CODE=$(( CURRENT_CODE + 1 ))
perl -pi -e 's/(versionCode\s+)[0-9]+/${1}'"$NEXT_CODE"'/' "$GRADLE"

echo "✓ version $VERSION  (Cargo / web / mobile);  Android versionCode $CURRENT_CODE → $NEXT_CODE"

if [ "$TAG_IT" = "--tag" ]; then
  git add Cargo.toml web/package.json mobile/package.json "$GRADLE"
  git commit -m "chore(release): v$VERSION"
  git tag -a "v$VERSION" -m "Open Fit v$VERSION"
  echo
  echo "Committed + tagged v$VERSION. Push to trigger the release workflow:"
  echo "    git push && git push origin v$VERSION"
elif [ -n "$TAG_IT" ]; then
  echo "warning: ignoring unknown second argument '$TAG_IT' (expected --tag)" >&2
fi
