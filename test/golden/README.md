# Golden live-fidelity data

On 2026-07-24 we pushed 12 crafted workflows and 13 ref events (4 commits to
`main` with disjoint changed-file sets, 7 new branches, 1 tag) to a scratch
GitHub repository and recorded which workflows GitHub actually ran
(`live-runs-raw.json`, from the Actions REST API) and the per-job
conclusions for the `if:` cases.

Every actwhy prediction matched real GitHub behavior: GitHub started 24
workflow runs across the 13 ref events, actwhy predicted exactly those 24
fired (and predicted "skip" for every other workflow×event combination that
did not run), and all 3 job-level `if:` decisions matched — including the
cases most tools get wrong:

| Semantics probed | Case | GitHub did | actwhy predicts |
|---|---|---|---|
| `?` = zero-or-one of preceding char | `ab?` vs branch `a` | fired | fires |
| `?` (not one-char wildcard) | `ab?` vs branch `abb` | did not fire | skipped |
| `+` = one-or-more of preceding char | `ab+` vs `a` / `ab` / `abb` | no / yes / yes | same |
| `*` does not cross `/` | `feature/*` vs `feature/deep/y` | did not fire | skipped |
| `**` crosses `/` | `feature/**` vs `feature/deep/y` | fired | fires |
| char class + quantifier | `v[12].[0-9]+` vs `v1.10` / `v3.0` | yes / no | same |
| `!` negation ordering | `['**','!docs/**']` vs docs-only commit | did not fire | skipped |
| negation re-include | `['**','!docs/**','docs/keep.md']` vs keep.md commit | fired | fires |
| paths-ignore = skip only if ALL ignored | docs-only vs docs+src commits | no / yes | same |
| tag push vs branch-only filters | `branches: [main]` + tag push | did not fire | skipped |
| tags filter | `tags: ['v*']` + tag `v1.0.0` | fired | fires |
| mixed-template `if:` footgun | `if: ${{ github.ref }} == 'refs/heads/never'` | job RAN (always-true) | fires + warning |
| `'' == null` coercion | `if: ${{ '' == null }}` | job ran (true) | fires |
| plain false condition | `if: github.ref == 'refs/heads/never'` | job skipped | skipped |

Commit key for `main` in `live-runs-raw.json`: `9161036` = c1 initial
(touches src+docs+workflows), `638fe3a` = c2 (docs/x.md only), `62bd194` =
c3 (docs/keep.md only), `1ea22e9` = c4 (src only).

The scratch repository was deleted after data collection. Reproducing the
probe is scripted work tracked in a starter issue (expand the compliance
corpus).
