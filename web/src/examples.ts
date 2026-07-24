/**
 * Curated example scenarios. Each loads both the editor tabs and the event
 * controls. Verdicts noted in comments were captured from the real engine.
 */
import type { AppState } from "./engine.js";

export interface Example {
  id: string;
  label: string;
  blurb: string;
  state: AppState;
}

const DOCS_YML = `name: Docs
on:
  push:
    paths:
      - 'docs/**'
      - '**.md'
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm run docs:build
`;

const CI_YML = `name: CI
on:
  push:
    branches: [main]
    paths-ignore:
      - 'docs/**'
      - '**.md'
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
`;

const DEPLOY_PATHS_YML = `name: Deploy
on:
  push:
    branches: [main]
    paths:
      - 'src/**'
      - 'package.json'
jobs:
  ship:
    runs-on: ubuntu-latest
    steps:
      - run: ./scripts/deploy.sh
`;

const PIPELINE_YML = `name: Pipeline
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
        node: [18, 20, 22]
    steps:
      - uses: actions/checkout@v4
      - run: npm run build

  deploy:
    needs: build
    # Only deploy from the production branch — NOT from main.
    if: github.ref == 'refs/heads/production'
    runs-on: ubuntu-latest
    steps:
      - run: ./scripts/deploy.sh
`;

const RELEASE_TAGS_YML = `name: Release
on:
  push:
    tags:
      - 'v*'
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: npm publish
`;

const PROD_BRANCH_YML = `name: Prod
on:
  push:
    branches: [main, production]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: ./scripts/deploy.sh
`;

const NIGHTLY_YML = `name: Nightly
on:
  schedule:
    - cron: '0 3 * * *'
  workflow_dispatch:
jobs:
  bench:
    runs-on: ubuntu-latest
    steps:
      - run: npm run bench
`;

const FOOTGUN_YML = `name: Release Gate
on: push
jobs:
  guard:
    runs-on: ubuntu-latest
    # FOOTGUN: mixing text and \${{ }} makes this a non-empty STRING,
    # which is always truthy — the gate never actually blocks anything.
    if: \${{ github.ref == 'refs/heads/main' }} || true
    steps:
      - run: ./scripts/release.sh

  notify:
    runs-on: ubuntu-latest
    if: github.event_name == 'push'
    steps:
      - run: ./scripts/notify.sh
`;

export const EXAMPLES: Example[] = [
  {
    id: "monorepo-docs",
    label: "Monorepo: docs-only push",
    blurb: "Three workflows share a repo. You touched only docs — watch two go dark.",
    state: {
      files: [
        { name: "docs.yml", content: DOCS_YML },
        { name: "ci.yml", content: CI_YML },
        { name: "deploy.yml", content: DEPLOY_PATHS_YML },
      ],
      active: 0,
      event: "push",
      branch: "main",
      tag: "v1.0.0",
      changed: "docs/getting-started.md\ndocs/api/reference.md",
      commitMessage: "docs: rewrite getting-started",
      prBase: "main",
      prHead: "docs/rewrite",
      prActivity: "opened",
    },
  },
  {
    id: "deploy-skipped",
    label: "Why doesn't my deploy run?",
    blurb: "The workflow fires, the build runs 6 matrix legs — but deploy is gated out. Here's the exact reason.",
    state: {
      files: [{ name: "pipeline.yml", content: PIPELINE_YML }],
      active: 0,
      event: "push",
      branch: "main",
      tag: "v1.0.0",
      changed: "src/server.ts\npackage.json",
      commitMessage: "feat: new endpoint",
      prBase: "main",
      prHead: "feature/endpoint",
      prActivity: "opened",
    },
  },
  {
    id: "nothing-fires",
    label: "The push that triggers NOTHING",
    blurb: "A push to a feature branch that no workflow is listening for. Silence — and why.",
    state: {
      files: [
        { name: "release.yml", content: RELEASE_TAGS_YML },
        { name: "prod.yml", content: PROD_BRANCH_YML },
        { name: "nightly.yml", content: NIGHTLY_YML },
      ],
      active: 1,
      event: "push",
      branch: "feature/login",
      tag: "v1.0.0",
      changed: "src/auth/login.ts",
      commitMessage: "wip: login form",
      prBase: "main",
      prHead: "feature/login",
      prActivity: "opened",
    },
  },
  {
    id: "always-true-if",
    label: "The always-true if: footgun",
    blurb: "A release gate that silently never blocks — actwhy flags the mixed-template trap.",
    state: {
      files: [{ name: "release-gate.yml", content: FOOTGUN_YML }],
      active: 0,
      event: "push",
      branch: "develop",
      tag: "v1.0.0",
      changed: "src/index.ts",
      commitMessage: "chore: bump deps",
      prBase: "main",
      prHead: "chore/deps",
      prActivity: "opened",
    },
  },
];

/** A fresh clone of an example's state (deep enough for our flat shape). */
export function cloneExampleState(ex: Example): AppState {
  return {
    ...ex.state,
    files: ex.state.files.map((f) => ({ ...f })),
  };
}
