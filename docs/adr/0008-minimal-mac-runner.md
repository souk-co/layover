# 0008: Keep the signed Mac runner minimal

## Status

Accepted as the boundary for new work; measurement workloads exist.

## Context

Each addition to the signed runner changes code that buyers must trust and approve. A number supplied by the host establishes only what the host chose to report.

## Decision

Keep the runner responsible for attested execution and evidence binding. Put measurement in minion workloads and verify their evidence. [Baseline load](../../minion/minion.py), [network measurement](../../minion/netmeasure.py), and [verdict calculation](../../minion/verdict.py) implement that separation. The [architecture’s Mac boundary](../../ARCHITECTURE.md#trust-boundaries) separates owner-reported properties from attested evidence.

## Consequences

A host report remains labeled owner-reported. A new measurement must say which workload observed it and how its evidence is checked. The signed runner changes only when the execution or attestation primitive requires it.
