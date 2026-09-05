# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use [GitHub private vulnerability reporting](https://github.com/Somethings1/quizzer/security/advisories/new) and include:

- the affected version and platform;
- reproduction steps or a minimal proof of concept;
- the security and privacy impact; and
- any proposed mitigation.

Maintainers will acknowledge a report when it is reviewed, coordinate remediation and disclosure with the reporter, and publish an advisory when users need to take action. Never include real credentials or private documents in a report.

## Supported versions

Until 1.0 is released, only the latest public beta receives security fixes. After 1.0, the latest stable and latest beta channels are supported.

Release signing, notarization, checksums, provenance, and an SBOM are release gates. Local Developer Mode and unsigned plugins must be treated as untrusted code.
