# OfferFinch documentation

## Product and operation

- [Plan](PLAN.md): current desktop scope, product rules, and remaining work.
- [Decisions](decisions.md): product and architecture decisions, including historical context.
- [Workflows](workflows.md): Electron processes, local storage, and the application lifecycle.
- [Releasing](releasing.md): signing, notarization, versioning, and distribution.
- [Verification and exceptions](cleanup-baseline.md): reproducible checks and retained guard-rail exceptions.

## Design and research

- [Desktop design notes](design/desktop/README.md): implementation notes and performance measurements.
- [Desktop design system](design/desktop/system.md): shared components, visual rules, and their test guard.
- [Brand](brand/README.md): OfferFinch identity and assets.
- [Form inspection](form-inspection.md): browser protections, submission boundaries, and hand-off decisions.
- [T3 provider research](t3-provider-research.md): local model-provider research.

See the [root README](../README.md) to run, test, or build the local macOS app. Tests use
fabricated fixtures and temporary data folders; personal profiles and application data
stay outside the repository.
