# Security Policy

## Supported versions

actwhy is at `0.x`. Security fixes are made against the **latest `0.x` release**; older `0.x` versions are not separately patched.

| Version | Supported |
|---|---|
| Latest `0.x` | Yes |
| Older `0.x` | No |

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **[private vulnerability reporting](https://github.com/Co-Messi/actwhy/security/advisories/new)** on this repository. Do not open a public issue for a security problem.

Please include, where you can:

- A description of the issue and its impact.
- Steps to reproduce, or a proof of concept.
- The actwhy version and your environment (OS, Node.js version).

You can expect an acknowledgement, and we'll keep you updated as we work on a fix and coordinate disclosure.

## Scope and threat model

actwhy's design deliberately keeps its attack surface small:

- **The CLI runs entirely on your machine.** It makes zero network calls at runtime and has zero telemetry. It reads only your `.github/workflows/*.yml` files and local git metadata.
- **It never reads tokens or secrets.** `secrets.*` values are treated as `UNKNOWN` by design — actwhy has no code path that resolves a secret.
- **The playground is fully static and client-side.** Workflows you paste into [actwhy.vercel.app](https://actwhy.vercel.app) are evaluated in your browser and are not uploaded anywhere.

The most relevant class of issue is therefore untrusted **input handling**: a crafted workflow file or event payload that could cause a crash, resource exhaustion, or unexpected behavior when parsed or evaluated. Reports of that kind are in scope and welcome.
