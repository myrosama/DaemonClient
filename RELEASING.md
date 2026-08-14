# Cutting a release

Releases matter more here than in most projects. A self-hosted worker checks
this repository's **GitHub releases feed** once a day and shows a banner when
the newest tag is newer than the build it is running
(`immich-api-shim/src/update-check.ts`). That feed is the **only** way a
self-hoster learns a security fix exists — we can push to managed installs
because we hold their Cloudflare token, and we deliberately cannot push to
theirs.

`install.sh` also clones the newest release tag rather than `main`, so a
release is what makes the project installable at all, not just updatable.

---

## The rule

> **`VERSION` always equals the newest release tag, and is bumped in the commit
> that gets tagged — never ahead of it.**

Bumping `VERSION` early looks harmless and is not. Say `VERSION` says `2.1.0`
while the newest tag is `v2.0.0`. Everyone who clones `main` in between stamps
`2.1.0` into their worker. When `v2.1.0` is finally cut — carrying commits
those installs do not have — the comparison is
`isNewerVersion('v2.1.0', '2.1.0')`, which is **false**. They are running
pre-release code and will never be told to update.

CI enforces this on every tag push (`.github/workflows/release.yml`). It cannot
enforce it on `main`, because between releases `VERSION` legitimately equals the
last tag.

## Steps

```bash
# 1. Bump VERSION and land it, together with the changelog entry.
echo "2.2.0" > VERSION
$EDITOR CHANGELOG.md          # move Unreleased -> 2.2.0
git commit -am "release: 2.2.0"

# 2. Tag that exact commit, and push both.
git tag -a v2.2.0 -m "v2.2.0"
git push origin main --follow-tags

# 3. Publish the release. The tag alone is NOT enough — update-check reads
#    /releases/latest, which only sees *published releases*.
gh release create v2.2.0 --title "v2.2.0" --notes-file <(sed -n '/## 2.2.0/,/^## /p' CHANGELOG.md)
```

Step 3 is the one that is easy to forget and impossible to notice: a tag with no
release leaves the feed unchanged, so every self-hosted install goes on
believing it is current.

## Checklist

- [ ] `VERSION` matches the tag exactly, minus the `v`
- [ ] `CHANGELOG.md` has a section for it
- [ ] CI is green on the tagged commit
- [ ] The release is **published**, not just tagged — check
      `gh release list` shows it
- [ ] `curl -s https://api.github.com/repos/myrosama/DaemonClient/releases/latest`
      returns the new `tag_name`

That last command is exactly what a self-hosted worker runs. If it does not
show the new version, no self-hoster will be told about it.
