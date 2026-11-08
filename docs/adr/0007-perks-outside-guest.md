# 0007: Perks run outside the attested guest

## Status

Accepted; VPN routing exists, AI-plan turns are not served yet.

## Context

Building a guest image for every host perk would multiply the builds buyers must approve and would pull host subscription credentials into the measured workload.

## Decision

Keep the guest as one generic build. Run perks such as a VPN or AI-plan turns outside it. The [guest network and launch-input design](../../guest/README.md#network) implements host-side proxies and runtime inputs without rebuilding the guest. [Host offers](../../HOSTING.md#4-choose-a-mode-for-each-offer) list AI subscription turns as an offer that is not yet served.

## Consequences

Attestation covers the guest code and its policy enforcement. The host’s proxy, route and subscription remain outside that boundary. Measure what a route delivers; adding an AI-plan offer still requires its own implementation.
