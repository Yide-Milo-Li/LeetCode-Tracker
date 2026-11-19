#!/usr/bin/env bash
set -euo pipefail

tag="${GITHUB_REF_NAME:?Missing release tag}"
version=$(node -p "require('./package.json').version")
if [[ "$tag" != "v$version" ]]; then
  echo "Tag $tag must match package version $version." >&2
  exit 1
fi

windows=$(find dist/release-input/windows -type f -name "*_${version}_x64-setup.exe")
macos=$(find dist/release-input/macos -type f -name "*_${version}_aarch64.dmg")
if [[ ! -f "$windows" || ! -f "$macos" ]]; then
  echo "Expected one Windows installer and one macOS disk image for $tag from this CI run." >&2
  exit 1
fi

output=dist/release-upload
mkdir -p "$output"
win_name="LeetCode-Tracker_${version}_x64-setup.exe"
mac_name="LeetCode-Tracker_${version}_aarch64.dmg"
cp "$windows" "$output/$win_name"
cp "$macos" "$output/$mac_name"
cd "$output"
sha256sum "$win_name" "$mac_name" > SHA256SUMS.txt
assets=("$win_name" "$mac_name" SHA256SUMS.txt)

if draft=$(gh release view "$tag" --json isDraft --jq '.isDraft'); then
  if [[ "$draft" != true ]]; then
    echo "Release $tag is already public." >&2
    exit 1
  fi
  gh release upload "$tag" "${assets[@]}" --clobber
else
  options=(--verify-tag --draft --generate-notes --title "LeetCode Tracker $version")
  if [[ "${version%%+*}" == *-* ]]; then
    options+=(--prerelease)
  fi
  gh release create "$tag" "${assets[@]}" "${options[@]}"
fi
