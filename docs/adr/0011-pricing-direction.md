# 0011: Proposed: discount for host reasons, never mark up on buyer information

## Status

Proposed; the rule is not enforced yet.

## Context

If disclosing a budget raises a buyer’s price, buyers have a reason to hide it. Today the program checks the host floor and buyer maximum; the rate between them remains the model’s choice.

## Decision

Allow a rate below the posted or last accepted rate only with a declared host-side or structural reason, such as idle capacity or flexible timing. Never raise the rate above posted because of what the amin knows about the buyer. Send demand information to hosts so they can change their own floors. The current [charter](../../amin/prompts/charter.md) and [matching prompt](../../amin/prompts/match.md) are the starting point; `guard_terms` in [souk.py](../../amin/souk.py) is the proposed enforcement point.

## Consequences

Acceptance requires a program check and tests that reject buyer-based markups and discounts without a permitted reason. Prompt guidance alone does not enforce the proposal. Changing the amin’s objective is a separate open question.
