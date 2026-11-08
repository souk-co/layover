# 0009: Hosts choose how open their offers are

## Status

Accepted; offer policy and guest enforcement exist.

## Context

Hosts bear different costs and risks when strangers use their machines or connections. One global choice of openness would exclude hosts with narrower terms.

## Decision

Treat openness, from accepting arbitrary work to allowing named sites only, as host policy. Match buyers within that policy and enforce accepted terms in the guest. See [host profiles](../../host/profiles), [host choices](../../HOSTING.md#4-choose-a-mode-for-each-offer), [guest network policy](../../guest/README.md#network), and [amin matching rules](../../amin/prompts/charter.md).

## Consequences

Core must carry policy through matching and admission. A host’s willingness to accept broad work grants no permission to bypass the guest’s network limits or a buyer’s agreed domain set.
